package server

import (
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/session"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

// rescanPIDs scans a PTY session for its members. A variable so that tests
// can stand in a scan.
var rescanPIDs = session.SessionPIDs

// rescanRecord rescans a copy of e's record and returns it. The scan reads
// every process on the system, so it runs without t.mu; the caller applies
// the result under t.mu once it has checked that e is still current.
func (t *table) rescanRecord(e *entry) (state.SessionRecord, error) {
	t.mu.Lock()
	rec := e.rec
	t.mu.Unlock()
	return rec, rec.Rescan(rescanPIDs)
}

// reopen starts a new session in place of a restorable record, in its cwd and
// with its name and title (see reopenTitle for a record with neither),
// running the agent resumed by the conversation id the record holds, by the
// agent's continue without one, or a plain shell when the record names no
// agent. The record is taken as it stands, with no rescan: a PTY session
// found empty gains no members except by pid reuse, which the rescan rule
// counts as gone anyway. A record with orphans is refused, and so is one whose conversation
// is open in a running session or is being reopened from another record, so
// that one conversation never runs twice.
func (c *conn) reopen(m protocol.Reopen) {
	t := c.srv.table
	t.mu.Lock()
	e := t.entries[m.SID]
	var refusal protocol.Error
	switch {
	case e == nil:
		refusal = noSession(m.SID)
	case e.sess != nil || e.reopening:
		refusal = badRequest(m.SID)
	case len(e.rec.Orphans) > 0:
		refusal = protocol.Error{T: protocol.TError, Code: protocol.CodeOrphans, SID: m.SID, PIDs: e.rec.Orphans}
	case t.conversationLiveLocked(e):
		refusal = protocol.Error{T: protocol.TError, Code: protocol.CodeConversationLive, SID: m.SID}
	}
	if refusal.Code != "" {
		t.mu.Unlock()
		c.send(refusal)
		return
	}
	e.reopening = true
	cwd := e.rec.Cwd
	cmd := session.RestoreCommand(e.rec.Cmd, e.rec.Agent, e.rec.Conversation)
	t.mu.Unlock()
	c.startSession(cwd, cmd, "", m.Cols, m.Rows, e)
}

// reopenTitle is the title of the session reopened from rec running cmd:
// rec's. A session with neither name nor title is titled by its cmd, which
// would show the conversation id; the agent's name is title enough. It goes in
// as the title, as a name would hide the title the agent gives the session
// later.
func reopenTitle(rec state.SessionRecord, cmd string) string {
	if rec.Name != "" || rec.Title != "" || cmd == "" {
		return rec.Title
	}
	agent, _, _ := strings.Cut(cmd, " ")
	return agent
}

// conversationLiveLocked reports whether e's conversation id, if it has one,
// is also that of a running session or of a record being reopened, whose
// session is starting and not yet in the table. It requires t.mu, and takes
// one session lock at a time, which keeps the lock order.
func (t *table) conversationLiveLocked(e *entry) bool {
	id := e.rec.Conversation
	if id == "" {
		return false
	}
	for _, o := range t.entries {
		if o == e || o.rec.Conversation != id {
			continue
		}
		if o.reopening {
			return true
		}
		if o.sess != nil {
			o.sess.Lock()
			running := !o.exited
			o.sess.Unlock()
			if running {
				return true
			}
		}
	}
	return false
}

// dismiss removes the record of a session from an earlier daemon run, once a
// fresh scan finds its PTY session empty. Otherwise it answers with the
// orphans, as a kill does.
func (c *conn) dismiss(sid uint32) {
	t := c.srv.table
	e := t.lookup(sid)
	if e == nil {
		c.send(noSession(sid))
		return
	}
	t.mu.Lock()
	busy := e.sess != nil || e.reopening
	t.mu.Unlock()
	if busy {
		c.send(badRequest(sid))
		return
	}

	rec, err := t.rescanRecord(e)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.entries[sid] != e {
		return
	}
	// A reopen that began during the scan is about to replace the record.
	if e.reopening {
		c.send(badRequest(sid))
		return
	}
	if err != nil {
		slog.Warn("dismiss: scan failed, so the record is kept", "sid", sid, "pid", e.pid, "err", err)
	} else if len(rec.Orphans) == 0 {
		delete(t.entries, sid)
		slog.Info("record dismissed", "sid", sid, "pid", e.pid)
		t.saveLocked()
		t.broadcastLocked()
		return
	} else {
		e.rec.Orphans = rec.Orphans
		slog.Warn("dismiss: processes remain, so the record is kept", "sid", sid, "pid", e.pid, "orphans", e.rec.Orphans)
		t.saveLocked()
		t.broadcastLocked()
	}
	c.send(protocol.Error{T: protocol.TError, Code: protocol.CodeOrphans, SID: sid, PIDs: e.rec.Orphans})
}

// orphanRechecks are the waits, one after another, after which the records
// that held processes when the daemon started are scanned again. Right after a
// crash those are often agents still shutting down, and a record with orphans
// can be neither reopened nor dismissed. A variable so that tests can shorten
// it.
var orphanRechecks = []time.Duration{2 * time.Second, 3 * time.Second, 10 * time.Second}

// recheckOrphans scans the records with orphans again after each of
// orphanRechecks, until none is left or done is closed.
func (t *table) recheckOrphans(done <-chan struct{}) {
	for _, wait := range orphanRechecks {
		select {
		case <-done:
			return
		case <-time.After(wait):
		}
		if !t.rescanOrphans() {
			return
		}
	}
}

// rescanOrphans rescans the earlier run's records that hold orphans, by the
// rule SessionRecord.Rescan applies, and sends the list when one changed: a
// record found empty becomes restorable. It reports whether any record still
// holds orphans.
func (t *table) rescanOrphans() bool {
	t.mu.Lock()
	type held struct {
		e       *entry
		orphans []int // what the record held when the scan began
	}
	var todo []held
	for _, e := range t.entries {
		if e.sess == nil && !e.reopening && len(e.rec.Orphans) > 0 {
			todo = append(todo, held{e, slices.Clone(e.rec.Orphans)})
		}
	}
	t.mu.Unlock()

	changed, left := false, false
	for _, h := range todo {
		e := h.e
		rec, err := t.rescanRecord(e)
		t.mu.Lock()
		// A dismiss or reopen may have dealt with the record meanwhile.
		if t.entries[e.sid] == e && e.sess == nil && !e.reopening {
			// A kill keeps the record but clears its orphans, and a dismiss may
			// narrow them; whoever changed them during the scan knows better
			// than the scan does. Orphans that remain are still rechecked.
			if !slices.Equal(e.rec.Orphans, h.orphans) {
				slog.Info("recheck of orphans: the record changed during the scan, so its result is dropped", "sid", e.sid, "pid", e.pid)
			} else if err != nil {
				slog.Warn("recheck of orphans: scan failed, so the record is kept", "sid", e.sid, "pid", e.pid, "err", err)
			} else if !slices.Equal(rec.Orphans, e.rec.Orphans) {
				e.rec.Orphans = rec.Orphans
				changed = true
				slog.Info("recheck of orphans", "sid", e.sid, "pid", e.pid, "orphans", e.rec.Orphans)
			}
			left = left || len(e.rec.Orphans) > 0
		}
		t.mu.Unlock()
	}
	if changed {
		t.mu.Lock()
		t.saveLocked()
		t.broadcastLocked()
		t.mu.Unlock()
	}
	return left
}
