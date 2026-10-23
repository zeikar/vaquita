package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"maps"
	"math"
	"slices"
	"sync"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/session"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

// Lock order: table.mu, then a session's lock, then conn.mu.
//
// Building a sessions list reads each session's state under the table lock,
// and so does draining a session's status, so nothing that holds a session
// lock may take table.mu: anything that needs both takes table.mu first; the
// exit handler, the status timer and the conversation id read are the
// session-side callers. The PTY reader must not wait for table.mu, which is
// held across state.json's fsync, so its OnOutput leaves the drain to the
// session's status timer. conn.mu is innermost: conn.send and a connection's
// subscription list are used with either of the others held, and nothing is
// locked under it.

// table holds the sessions and the connections that receive their list.
type table struct {
	home string
	// userHome is the user's home directory, where the agents keep the files
	// their conversation ids are read from; empty turns the reads off. Set
	// before the server serves.
	userHome string

	mu sync.Mutex
	// st is what state.json holds; its Sessions are rebuilt from entries on
	// every save.
	st      state.State
	entries map[uint32]*entry
	// lastSID is the highest sid handed out or loaded, so that no sid is
	// used twice in a daemon's lifetime or collides with a kept record.
	lastSID uint32
	// clients are the connections past the hello. Each gets every sessions
	// broadcast, which is sent under mu so that the lists arrive in the
	// order of the changes they show.
	clients map[*conn]struct{}
	// missed counts the notifications raised while no GUI client was
	// connected, for the next GUI to join.
	missed int
	// readID reads the conversation id a snapshot describes. Tests replace
	// it to stand in for the agents' files.
	readID func(convSnapshot) string
}

// entry is one session in the table. A record kept from a previous daemon run
// has no session: it is listed as exited. It is restorable, or holds orphans
// until a kill's rescan finds them gone; either way it can be dismissed.
type entry struct {
	sid  uint32
	inc  string // tells this session apart from another shown in the same place
	pid  int
	sess *session.Session
	// listed is closed once the entry is complete and in the table, before
	// any other connection can find it there. The session's callbacks can
	// run before Start has returned it.
	listed chan struct{}
	// statusTimer drains the session's status when output() asks for it
	// with Reset(0) and at the projector's deadlines. Created stopped before
	// the session starts and never replaced; Reset and Stop are called under
	// the session lock.
	statusTimer *time.Timer

	// Guarded by table.mu.
	rec state.SessionRecord
	// reopening is set while a reopen of this record is starting its
	// session; it refuses a second reopen and a dismiss.
	reopening bool

	// Guarded by the session lock.
	subs   []*subscriber
	exited bool
	code   int
	// finalOff is the ring end when the exit was reported. A subscriber is
	// sent output this far before it is sent the exit.
	finalOff uint64
	// removeOnExit is set by a kill of the running session: the record goes
	// once the exit leaves nothing behind.
	removeOnExit bool
	// drainDue is set while a drain output() asked for has yet to run;
	// output read meanwhile goes out with it.
	drainDue bool
	// idBusy is set while a read of the agent's conversation id is in
	// flight, and idDue when a drain asked for another meanwhile.
	idBusy, idDue bool
}

func newTable(home string, st state.State) *table {
	t := &table{home: home, st: st, entries: make(map[uint32]*entry), clients: make(map[*conn]struct{}), readID: convSnapshot.readFiles}
	for _, r := range st.Sessions {
		if r.SID < 1 || r.SID > math.MaxUint32 || t.entries[uint32(r.SID)] != nil {
			slog.Warn("dropping session record with an invalid or duplicate sid", "sid", r.SID, "pid", r.PID, "orphans", r.Orphans)
			continue
		}
		sid := uint32(r.SID)
		t.entries[sid] = &entry{sid: sid, inc: newInc(), pid: r.PID, rec: r}
		t.lastSID = max(t.lastSID, sid)
	}
	return t
}

// newInc returns 8 random bytes in hex.
func newInc() string {
	b := make([]byte, 8)
	rand.Read(b) // never fails since Go 1.24
	return hex.EncodeToString(b)
}

func (t *table) allocSID() uint32 {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lastSID++
	return t.lastSID
}

func (t *table) lookup(sid uint32) *entry {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.entries[sid]
}

// saveLocked writes state.json from the table. A failure is only logged: the
// sessions themselves are unaffected, and the next change writes it again.
func (t *table) saveLocked() {
	recs := make([]state.SessionRecord, 0, len(t.entries))
	for _, sid := range slices.Sorted(maps.Keys(t.entries)) {
		recs = append(recs, t.entries[sid].rec)
	}
	t.st.Sessions = recs
	if err := t.st.Save(t.home); err != nil {
		slog.Error("save state", "err", err)
	}
}

// listLocked describes every session, by sid. It is never nil, so clients
// can always iterate it.
func (t *table) listLocked() []protocol.SessionInfo {
	list := make([]protocol.SessionInfo, 0, len(t.entries))
	for _, sid := range slices.Sorted(maps.Keys(t.entries)) {
		e := t.entries[sid]
		info := protocol.SessionInfo{
			SID: sid, Inc: e.inc, Cwd: e.rec.Cwd, Cmd: e.rec.Cmd, Name: e.rec.Name,
			State: protocol.StateExited, PID: e.pid, Orphans: e.rec.Orphans,
			// Unknown for a record from a previous run, as for a shell
			// whose wait failed.
			Code:       -1,
			Restorable: e.sess == nil && len(e.rec.Orphans) == 0,
		}
		if s := e.sess; s != nil {
			s.Lock()
			info.Cols, info.Rows = s.Size()
			info.Code = e.code
			// An exited session shows no status.
			if !e.exited {
				info.State = protocol.StateRunning
				v, unread := s.Output().View()
				info.Status, info.Unread = statusInfo(v), unread
			}
			s.Unlock()
		}
		list = append(list, info)
	}
	return list
}

func (t *table) broadcastLocked() {
	m := protocol.Sessions{T: protocol.TSessions, List: t.listLocked()}
	for c := range t.clients {
		c.send(m)
	}
}

func (t *table) broadcast() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.broadcastLocked()
}

// join answers c's hello with the current list and adds c to the broadcasts,
// in one step so that no change falls between the list and the first
// broadcast. A GUI is then told how many notifications it missed, if any
// were raised while no GUI was connected.
func (t *table) join(c *conn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	c.send(protocol.Hello{T: protocol.THello, V: protocol.Version})
	c.send(protocol.Sessions{T: protocol.TSessions, List: t.listLocked()})
	if c.client == protocol.ClientGUI {
		t.sendReposLocked(c)
	}
	t.sendMissedLocked(c)
	t.clients[c] = struct{}{}
}

// leave ends c's broadcasts and subscriptions. Its sessions keep running: a
// GUI that restarts must find them.
func (t *table) leave(c *conn) {
	t.mu.Lock()
	delete(t.clients, c)
	t.mu.Unlock()
	for _, sub := range c.subscriptions() {
		s := sub.e.sess
		s.Lock()
		sub.e.detach(sub)
		s.Unlock()
	}
}

// output is the session's OnOutput: it wakes the writer of every subscriber,
// and asks for a status drain when the read changed the status. It runs on
// the PTY reader and never takes table.mu.
func (e *entry) output() {
	select {
	case <-e.listed:
	default:
		// No other connection can have found the entry yet, so only the
		// creator is subscribed, and create wakes its writer and drains the
		// status once the entry is listed.
		return
	}
	s := e.sess
	s.Lock()
	for _, sub := range e.subs {
		sub.conn.wakeWriter()
	}
	// The drain runs on the timer's goroutine. Reads made before it runs
	// ask for no other, so a burst of output has one drain waiting for
	// table.mu, not one per read.
	if !e.drainDue && s.Output().NeedsDrain() {
		e.drainDue = true
		e.statusTimer.Reset(0)
	}
	s.Unlock()
}

// exit is the session's OnExit. All output is in the ring by now, so the
// final offset recorded here is where each subscriber's exit goes.
//
// It holds table.mu throughout, so the exit is recorded, saved and broadcast
// in one step: a kill that finds the session exited waits for table.mu, so
// it reads the record only once that is done. Orphans only returns the scan
// the session made before calling OnExit, so nothing slow is added under
// table.mu.
func (t *table) exit(e *entry, code int) {
	<-e.listed
	s := e.sess
	t.mu.Lock()
	defer t.mu.Unlock()
	s.Lock()
	// Before exited is set, which stops the drain: the session's last status
	// goes out ahead of its exit, as a subscriber's exit is written after the
	// control messages queued for its connection.
	t.endStatusLocked(e)
	e.exited, e.code = true, code
	e.finalOff = s.Output().Ring().End()
	orphans, scanErr := s.Orphans()
	remove := e.removeOnExit && scanErr == nil && len(orphans) == 0
	for _, sub := range e.subs {
		sub.conn.wakeWriter()
	}
	s.Unlock()

	switch {
	case scanErr != nil:
		slog.Warn("session exited; its PTY session could not be scanned, so the record is kept", "sid", e.sid, "pid", e.pid, "code", code, "err", scanErr)
	case len(orphans) > 0:
		slog.Warn("session exited leaving processes behind; the record is kept", "sid", e.sid, "pid", e.pid, "code", code, "orphans", orphans)
	default:
		slog.Info("session exited", "sid", e.sid, "pid", e.pid, "code", code)
	}

	// The entry leaves the table before anything is written, so the one
	// save and the one broadcast both show it gone. Subscriptions keep
	// their pointer to it until their exit has been sent.
	if remove {
		delete(t.entries, e.sid)
	} else {
		e.rec.Orphans = orphans
	}
	t.saveLocked()
	t.broadcastLocked()
}

func noSession(sid uint32) protocol.Error {
	return protocol.Error{T: protocol.TError, Code: protocol.CodeNoSession, SID: sid}
}

func badRequest(sid uint32) protocol.Error {
	return protocol.Error{T: protocol.TError, Code: protocol.CodeBadRequest, SID: sid}
}

// create starts a session with c already subscribed. The subscription exists
// before the shell does and starts at offset 0, so everything the program
// writes goes to c live: an agent sends terminal queries within milliseconds
// of starting, and only live output is answered.
func (c *conn) create(m protocol.Create) {
	t := c.srv.table
	e := &entry{sid: t.allocSID(), inc: newInc(), listed: make(chan struct{})}
	// Before the shell starts, so that output() always finds it.
	e.statusTimer = t.newStatusTimer(e)
	sub := newSubscriber(c, e)
	e.subs = []*subscriber{sub}
	e.setWriter(sub)
	// Only the shell gets the added options; the record keeps what the user typed.
	s, err := session.Start(session.Config{
		SID:      int(e.sid),
		Shell:    c.srv.opts.Shell,
		Cwd:      m.Cwd,
		Cmd:      session.AgentCommand(m.Cmd),
		Name:     m.Name,
		Cols:     m.Cols,
		Rows:     m.Rows,
		OnOutput: e.output,
		OnExit:   func(code int) { t.exit(e, code) },
	})
	if err != nil {
		slog.Warn("create session", "remote", c.remote, "sid", e.sid, "err", err)
		c.send(protocol.Error{T: protocol.TError, Code: protocol.CodeBadRequest})
		return
	}
	e.sess, e.pid = s, s.PID()
	e.rec = state.SessionRecord{SID: int(e.sid), PID: e.pid, Started: s.Started(), Cwd: m.Cwd, Cmd: m.Cmd, Name: m.Name}
	c.addSub(sub)

	// Listed only once started: other connections can find the entry once
	// t.mu is released, and a kill from this one is read only after create
	// returns, so a close requested right away always finds a started
	// session. listed is closed first, so that output from then on wakes
	// whoever subscribes. exit waits for it holding no lock, so closing it
	// under t.mu cannot deadlock.
	t.mu.Lock()
	t.entries[e.sid] = e
	close(e.listed)
	t.saveLocked()
	t.broadcastLocked()
	// output() asked for no drain before listed was closed, so the status
	// of what was read until then goes out here, after the list.
	s.Lock()
	t.drainStatusLocked(e)
	s.Unlock()
	t.mu.Unlock()
	slog.Info("session created", "sid", e.sid, "pid", e.pid, "cwd", m.Cwd, "remote", c.remote)
	c.wakeWriter()
}

func (c *conn) subscribe(sid uint32) {
	e := c.srv.table.lookup(sid)
	if e == nil || e.sess == nil {
		c.send(noSession(sid))
		return
	}
	s := e.sess
	s.Lock()
	defer s.Unlock()
	if c.subscription(sid) != nil {
		c.send(badRequest(sid))
		return
	}
	sub := newSubscriber(c, e)
	sub.snapshot(s.Output().Ring())
	e.subs = append(e.subs, sub)
	c.addSub(sub)
	e.setWriter(sub)
	c.wakeWriter()
}

func (c *conn) unsubscribe(sid uint32) {
	sub := c.subscription(sid)
	if sub == nil {
		// A known session without a subscription has just had its exit
		// sent, which ended it.
		if c.srv.table.lookup(sid) == nil {
			c.send(noSession(sid))
		}
		return
	}
	s := sub.e.sess
	s.Lock()
	sub.e.detach(sub)
	s.Unlock()
}

// ack records how far the client has consumed sub's output. An ack from an
// earlier generation is stale: its offset refers to output that was replaced.
func (c *conn) ack(m protocol.Ack) {
	// Acks for a subscription that has just ended are expected; they are
	// moot.
	sub := c.subscription(m.SID)
	if sub == nil {
		return
	}
	s := sub.e.sess
	s.Lock()
	if !sub.dropped && m.Gen == sub.gen {
		sub.ackedOff = min(max(sub.ackedOff, m.Off), sub.sentOff)
	}
	s.Unlock()
	// The pump may be waiting for this ack.
	c.wakeWriter()
}

// writer returns c's subscription to sid if c may write to the session, and
// answers the request itself otherwise.
func (c *conn) writer(sid uint32) *subscriber {
	sub := c.subscription(sid)
	if sub == nil {
		c.send(noSession(sid))
		return nil
	}
	s := sub.e.sess
	s.Lock()
	writable := sub.writable && !sub.needReset
	s.Unlock()
	if !writable {
		// Dropped without an error: the client has been told it is
		// read-only, and a terminal sends input on every keystroke.
		slog.Debug("request from a read-only subscription dropped", "sid", sid, "remote", c.remote)
		return nil
	}
	return sub
}

func (c *conn) input(f protocol.Frame) {
	sub := c.subscription(f.SID)
	if sub == nil {
		c.send(noSession(f.SID))
		return
	}
	s := sub.e.sess
	// Checked and queued under the session lock, so that a reset or a
	// writer change cannot fall between: input of an earlier generation, such as
	// replies to output that has since been replayed, never reaches the
	// session. Write only appends to a buffer.
	s.Lock()
	if !sub.writable || sub.needReset || sub.dropped || f.Gen != sub.gen {
		s.Unlock()
		slog.Debug("input dropped: read-only or stale generation", "sid", f.SID, "remote", c.remote, "gen", f.Gen)
		return
	}
	err := s.Write(f.Payload)
	s.Unlock()
	switch {
	case errors.Is(err, session.ErrInputOverflow):
		c.send(protocol.Error{T: protocol.TError, Code: protocol.CodeInputOverflow, SID: f.SID})
	case err != nil:
		// The shell has exited; the client is about to be sent its exit.
		slog.Debug("input dropped", "sid", f.SID, "remote", c.remote, "bytes", len(f.Payload), "err", err)
	}
}

func (c *conn) resize(m protocol.Resize) {
	sub := c.writer(m.SID)
	if sub == nil {
		return
	}
	s := sub.e.sess
	s.Lock()
	cols, rows := s.Size()
	s.Unlock()
	// Clients resize as a window is dragged, often to the size the session
	// already has; a broadcast for each would only fill control queues.
	if m.Cols == cols && m.Rows == rows {
		return
	}
	err := s.Resize(m.Cols, m.Rows)
	if errors.Is(err, session.ErrClosed) {
		// The shell has exited; its size no longer matters.
		slog.Debug("resize after exit", "sid", m.SID, "remote", c.remote)
		return
	}
	if err != nil {
		slog.Debug("resize", "sid", m.SID, "remote", c.remote, "err", err)
		c.send(badRequest(m.SID))
		return
	}
	c.srv.table.broadcast()
}

// kill ends a running session and removes its record once it has exited. An
// exited session is never signalled, as its pids may belong to anything by
// now; it is rescanned by the rule SessionRecord.Rescan applies. If its PTY
// session is empty, the record of this run's session goes, while the record
// of an earlier run's session loses its orphans and stays, restorable. If
// processes remain they are listed and answered as orphans.
func (c *conn) kill(sid uint32) {
	t := c.srv.table
	e := t.lookup(sid)
	if e == nil {
		c.send(noSession(sid))
		return
	}
	if s := e.sess; s != nil {
		s.Lock()
		running := !e.exited
		if running {
			e.removeOnExit = true
		}
		s.Unlock()
		if running {
			// Only the exit removes a running session's entry, so the
			// lookup is still current. The exit, then a sessions list
			// without the record, answer the kill.
			s.Kill()
			return
		}
	}

	rec, err := t.rescanRecord(e)
	if err != nil {
		slog.Warn("kill of an exited session: scan failed, so the record is kept", "sid", sid, "pid", e.pid, "err", err)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	// Another kill has removed it meanwhile; its broadcast answers this one
	// too.
	if t.entries[sid] != e {
		return
	}
	if err == nil && len(rec.Orphans) == 0 {
		if e.sess == nil {
			e.rec.Orphans = nil
			slog.Info("record cleaned; it can be reopened", "sid", sid, "pid", e.pid)
		} else {
			delete(t.entries, sid)
			slog.Info("session removed", "sid", sid, "pid", e.pid)
		}
		t.saveLocked()
		t.broadcastLocked()
		return
	}
	if err == nil {
		e.rec.Orphans = rec.Orphans
		slog.Warn("kill of an exited session: processes remain, so the record is kept", "sid", sid, "pid", e.pid, "orphans", e.rec.Orphans)
		t.saveLocked()
		t.broadcastLocked()
	}
	c.send(protocol.Error{T: protocol.TError, Code: protocol.CodeOrphans, SID: sid, PIDs: e.rec.Orphans})
}
