package server

import (
	"log/slog"
	"strings"

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
// with its name and title (see below for a record with neither), running the
// agent resumed by the conversation id the record holds, by the agent's
// continue without one, or a plain shell when the record names no agent. The
// record is taken as it stands, with no rescan: a PTY session found empty
// gains no members except by pid reuse, which the rescan rule counts as gone
// anyway. A record with orphans is refused, and so is one whose conversation
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
	cwd, name, title := e.rec.Cwd, e.rec.Name, e.rec.Title
	cmd := session.RestoreCommand(e.rec.Cmd, e.rec.Agent, e.rec.Conversation)
	// A session with neither name nor title is titled by its cmd, which would
	// show the conversation id; the agent's name is title enough. For claude
	// it goes in as the title, as a name would hide the topic Claude Code
	// gives the session later.
	if agent, _, _ := strings.Cut(cmd, " "); name == "" && title == "" && cmd != "" {
		if agent == "claude" {
			title = agent
		} else {
			name = agent
		}
	}
	t.mu.Unlock()
	c.startSession(cwd, cmd, name, title, m.Cols, m.Rows, e)
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
