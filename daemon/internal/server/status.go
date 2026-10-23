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
//
// The drain is also where the agent's conversation id is read, on a goroutine
// of its own as well, so that no file is touched under a lock or on the
// reader (see readConversation), and where Claude Code's topic becomes the
// title of the session's record (see retitleLocked).

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
	t.drainStatus(e)
}

// drainStatus drains e's status under its session lock and sends what the
// drain took. A drain that changed e's record saves it and lists it first, so
// that a notification it raised is titled by the new title, and does so once
// the session lock is released, as the PTY reader takes that lock for every
// read and a save waits for the disk. Output read meanwhile may have moved
// the view past the drain's, and the list shows it as it is by then, so the
// view is read again for the status that follows: a GUI never gets an older
// view after a newer one. It requires t.mu.
func (t *table) drainStatus(e *entry) {
	s := e.sess
	d := func() drained {
		s.Lock()
		// Deferred, so that a panic in the projector releases it too.
		defer s.Unlock()
		return t.drainStatusLocked(e)
	}()
	if d.retitled {
		t.saveLocked()
		t.broadcastLocked()
		s.Lock()
		d.view, d.unread = s.Output().View()
		s.Unlock()
	}
	t.sendStatusLocked(e.sid, d)
}

// drained is what a drain took from a session's output for its caller to
// send: the view, which changed if changed is set, the notifications, and
// whether the record's title changed.
type drained struct {
	changed  bool
	view     status.View
	unread   bool
	notes    []status.Notification
	retitled bool
}

// drainStatusLocked raises the notifications whose deadline has passed, takes
// e's view and its notifications for the caller to send, and re-arms e's
// status timer. When either, or the reporting app, changed, it asks for a
// read of the agent's conversation id. When the app or Claude Code's title
// changed, it updates the record's title, which the caller saves and lists
// before it sends the rest (see drainStatus). It requires t.mu and the session
// lock. After the exit it takes nothing, so no status follows a session's
// exit. Output read after the exit, when the reader outlives the drain
// timeout, leaves drainDue set, so output() asks for no further drains.
//
// The Tick may append output: the sequence that undoes the terminal modes of
// a reporter it found gone. No read of the PTY calls output() for it, and the
// shell may write nothing more, so the drain wakes the subscribers' writers
// itself.
func (t *table) drainStatusLocked(e *entry) drained {
	if e.exited {
		return drained{}
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
	appChanged := out.TakeAppChange()
	titleChanged := out.TakeTitleChange()
	// Asked before the status is queued: waitConversationRead, in the
	// tests, relies on that order.
	if (changed || len(notes) > 0 || appChanged) && agentOf(out.App()) != "" {
		t.askConversationLocked(e)
	}
	e.armStatusLocked(now)
	d := drained{changed: changed, notes: notes}
	d.view, d.unread = out.View()
	d.retitled = (appChanged || titleChanged) && e.retitleLocked(out)
	return d
}

// genericTitle is the window title Claude Code sets before it has a topic.
const genericTitle = "Claude Code"

// retitleLocked sets the title of e's record from out, the session's output,
// and reports whether that changed it. While claude is the agent, its window
// title is the conversation's topic, but its generic title keeps the topic
// already there: a reopened session shows its record's until Claude Code
// gives one. Any other agent clears it, as a topic belongs to claude's
// conversation. It requires t.mu and the session lock.
func (e *entry) retitleLocked(out *session.Output) bool {
	title := e.rec.Title
	switch {
	case agentOf(out.App()) != "claude":
		title = ""
	case out.Title() != "" && out.Title() != genericTitle:
		title = out.Title()
	}
	if title == e.rec.Title {
		return false
	}
	e.rec.Title = title
	return true
}

// sendStatusLocked queues sid's view, when it changed, and then one notify
// per notification to every GUI client. Attach clients show neither.
// Notifications no GUI was connected to receive are counted for the summary
// the next one gets. It requires t.mu. Notification kinds are the protocol's.
func (t *table) sendStatusLocked(sid uint32, d drained) {
	var msgs []any
	if d.changed {
		msgs = append(msgs, protocol.Status{T: protocol.TStatus, SID: sid, Status: statusInfo(d.view), Unread: d.unread})
	}
	for _, n := range d.notes {
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
		t.missed += len(d.notes)
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

// endStatusLocked discards what e's projector still holds as its session
// exits, once the exit's drain has sent what it had produced: a done still
// waiting out its quiet period is dropped, as the session has ended, and so
// is output read after that drain, which only a reader that outlived the
// drain timeout can add. It requires the session lock.
func (e *entry) endStatusLocked() {
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
	exited := e.exited
	if !exited {
		s.Output().Seen()
	}
	s.Unlock()
	// Under t.mu, the exit cannot fall between.
	if !exited {
		t.drainStatus(e)
	}
}
