package server

import (
	"errors"
	"log/slog"

	"github.com/zeikar/vaquita/daemon/internal/convid"
	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/session"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

func (c *conn) create(m protocol.Create) {
	c.startSession(m.Cwd, m.Cmd, m.Name, "", m.Cols, m.Rows, nil)
}

// startSession starts a session with c already subscribed. The subscription
// exists before the shell does and starts at offset 0, so everything the
// program writes goes to c live: an agent sends terminal queries within
// milliseconds of starting, and only live output is answered.
//
// With old, the record a reopen is starting from, the new session replaces it
// in the table: in one step, so that one save and one broadcast show the
// swap. The new record carries old's agent and conversation id over, so a
// restart before the agent has reported resumes the same conversation, and
// keeps the restored command as its cmd, which a later reopen maps again.
// title is the new record's until the agent gives another.
func (c *conn) startSession(cwd, cmd, name, title string, cols, rows int, old *entry) {
	t := c.srv.table
	sid, ok := t.beginStart()
	if !ok {
		c.failStart(old, errors.New("the daemon is stopping"))
		return
	}
	e := &entry{sid: sid, inc: newInc(), listed: make(chan struct{})}
	// Before the shell starts, so that output() always finds it.
	e.statusTimer = t.newStatusTimer(e)
	sub := newSubscriber(c, e)
	e.subs = []*subscriber{sub}
	e.setWriter(sub)
	// Only the shell gets the added options; the record keeps cmd without them.
	s, err := session.Start(session.Config{
		SID:      int(e.sid),
		Shell:    c.srv.opts.Shell,
		Cwd:      cwd,
		Cmd:      session.AgentCommand(cmd),
		Name:     name,
		Cols:     cols,
		Rows:     rows,
		OnOutput: e.output,
		OnExit:   func(code int) { t.exit(e, code) },
	})
	if err != nil {
		t.mu.Lock()
		t.starting--
		t.mu.Unlock()
		c.failStart(old, err)
		return
	}
	e.sess, e.pid = s, s.PID()
	e.rec = state.SessionRecord{SID: int(e.sid), PID: e.pid, Started: s.Started(), Cwd: s.Cwd(), Cmd: cmd, Name: name, Title: title}
	c.addSub(sub)

	// Listed only once started: other connections can find the entry once
	// t.mu is released, and a kill from this one is read only after
	// startSession returns, so a close requested right away always finds a
	// started session. listed is closed first, so that output from then on
	// wakes whoever subscribes. exit waits for it holding no lock, so closing
	// it under t.mu cannot deadlock.
	t.mu.Lock()
	t.starting--
	t.entries[e.sid] = e
	close(e.listed)
	byID := false
	if old != nil {
		e.rec.Agent, e.rec.Conversation = old.rec.Agent, old.rec.Conversation
		byID = convid.ValidID(e.rec.Conversation)
		if t.entries[old.sid] == old {
			delete(t.entries, old.sid)
		}
	}
	t.saveLocked()
	t.broadcastLocked()
	// output() asked for no drain before listed was closed, so the status
	// of what was read until then goes out here, after the list.
	t.drainStatus(e)
	t.mu.Unlock()
	if old != nil {
		slog.Info("session reopened", "sid", e.sid, "record", old.sid, "pid", e.pid, "cwd", cwd, "by_id", byID, "remote", c.remote)
	} else {
		slog.Info("session created", "sid", e.sid, "pid", e.pid, "cwd", cwd, "remote", c.remote)
	}
	c.wakeWriter()
}

// failStart answers a create, or a reopen of old, whose session did not start.
func (c *conn) failStart(old *entry, err error) {
	if old == nil {
		slog.Warn("create session", "remote", c.remote, "err", err)
		c.send(protocol.Error{T: protocol.TError, Code: protocol.CodeBadRequest})
		return
	}
	slog.Warn("reopen session", "remote", c.remote, "record", old.sid, "err", err)
	t := c.srv.table
	t.mu.Lock()
	old.reopening = false
	t.mu.Unlock()
	c.send(badRequest(old.sid))
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
