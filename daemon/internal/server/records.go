package server

import (
	"log/slog"

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
