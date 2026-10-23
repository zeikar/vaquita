package server

import (
	"strconv"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/session"
	"github.com/zeikar/vaquita/daemon/internal/status"
)

// A session's status reaches GUI clients through drains. The projector in
// its Output accumulates view changes and notifications as output is read;
// a drain takes them and queues them to the GUIs under t.mu and the session
// lock, the locks a sessions list is built under, so a GUI never gets an
// older view after a newer one, whether as a status or in a list. The PTY
// reader holds neither lock in OnOutput and must not wait for t.mu, so it
// only asks for a drain, which the session's status timer runs on a
// goroutine of its own. The timer also fires at the projector's deadlines.

// statusInfo is what a row shows for v, nil for nothing. The status package's
// view states are the protocol's.
func statusInfo(v status.View) *protocol.StatusInfo {
	if v.State == "" {
		return nil
	}
	return &protocol.StatusInfo{State: v.State, Kind: v.Kind, Msg: v.Msg}
}

// newStatusTimer returns e's status timer, stopped: there is no stopped
// AfterFunc. The callback runs the projector and the fan-out, so a panic in
// them is recovered like one on any other daemon goroutine; statusTick
// releases its locks as it unwinds.
func (t *table) newStatusTimer(e *entry) *time.Timer {
	name := "sid " + strconv.Itoa(int(e.sid)) + " status"
	timer := time.AfterFunc(time.Hour, func() { session.Go(name, func() { t.statusTick(e) }) })
	timer.Stop()
	return timer
}

// statusTick is e's status timer callback: a drain output() asked for, or a
// deadline. Timers carry no state, so one that fires late, or after a drain
// made on another path, finds nothing to send. It does not look e up again:
// only the exit removes a running session, and the drain does nothing once e
// has exited.
func (t *table) statusTick(e *entry) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := e.sess
	s.Lock()
	defer s.Unlock()
	t.drainStatusLocked(e)
}

// drainStatusLocked raises the notifications whose deadline has passed,
// sends e's view if it changed and its notifications to the GUI clients, and
// re-arms e's status timer. It requires t.mu and the session lock. After the
// exit it does nothing, so no status follows a session's exit. Output read
// after the exit, when the reader outlives the drain timeout, leaves drainDue
// set, so output() asks for no further drains.
//
// The Tick may append output: the sequence that undoes the terminal modes of
// a reporter it found gone. No read of the PTY calls output() for it, and the
// shell may write nothing more, so the drain wakes the subscribers' writers
// itself.
func (t *table) drainStatusLocked(e *entry) {
	if e.exited {
		return
	}
	e.drainDue = false
	out := e.sess.Output()
	now := out.Now()
	end := out.Ring().End()
	out.Tick(now)
	if out.Ring().End() != end {
		for _, sub := range e.subs {
			sub.conn.wakeWriter()
		}
	}
	changed, notes := out.TakeStatus()
	out.TakeAppChange()
	e.armStatusLocked(now)
	v, unread := out.View()
	t.sendStatusLocked(e.sid, changed, v, unread, notes)
}

// sendStatusLocked queues sid's view, when it changed, and then one notify
// per notification to every GUI client. Attach clients show neither.
// Notifications no GUI was connected to receive are counted for the summary
// the next one gets. It requires t.mu. Notification kinds are the protocol's.
func (t *table) sendStatusLocked(sid uint32, changed bool, v status.View, unread bool, notes []status.Notification) {
	var msgs []any
	if changed {
		msgs = append(msgs, protocol.Status{T: protocol.TStatus, SID: sid, Status: statusInfo(v), Unread: unread})
	}
	for _, n := range notes {
		msgs = append(msgs, protocol.Notify{T: protocol.TNotify, SID: sid, Kind: n.Kind, Msg: n.Msg})
	}
	if len(msgs) == 0 {
		return
	}
	gui := false
	for c := range t.clients {
		if c.client != protocol.ClientGUI {
			continue
		}
		gui = true
		for _, m := range msgs {
			c.send(m)
		}
	}
	if !gui {
		t.missed += len(notes)
	}
}

// sendMissedLocked tells c, if it is a GUI, how many notifications were
// raised while no GUI was connected, and starts the count over. It requires
// t.mu.
func (t *table) sendMissedLocked(c *conn) {
	if c.client != protocol.ClientGUI || t.missed == 0 {
		return
	}
	c.send(protocol.Notify{T: protocol.TNotify, Kind: protocol.NotifyMissed, Count: t.missed})
	t.missed = 0
}

// armStatusLocked sets e's status timer to fire at the projector's next
// deadline, or stops it when there is none. It requires the session lock.
func (e *entry) armStatusLocked(now time.Time) {
	if d, ok := e.sess.Output().NextDeadline(); ok {
		e.statusTimer.Reset(d.Sub(now))
		return
	}
	e.statusTimer.Stop()
}

// endStatusLocked sends what e's projector has produced as its session exits
// and discards the rest: a done still waiting out its quiet period is
// dropped, as the session has ended. It requires t.mu and the session lock,
// and must run before e.exited is set, which stops the drain.
func (t *table) endStatusLocked(e *entry) {
	t.drainStatusLocked(e)
	e.statusTimer.Stop()
	e.sess.Output().ClearStatus()
}

// seen marks a session as looked at. The status it changes goes to every GUI,
// so that all of them agree on what is unread. An exited session shows no
// status, so seeing it changes nothing and sends nothing.
func (c *conn) seen(sid uint32) {
	t := c.srv.table
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.entries[sid]
	if e == nil || e.sess == nil {
		c.send(noSession(sid))
		return
	}
	s := e.sess
	s.Lock()
	defer s.Unlock()
	if !e.exited {
		s.Output().Seen()
		t.drainStatusLocked(e)
	}
}
