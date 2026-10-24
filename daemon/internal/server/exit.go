package server

import (
	"log/slog"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
)

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
	// Before exited is set, which stops the drain: the session's last status
	// goes out ahead of its exit, as a subscriber's exit is written after the
	// control messages queued for its connection, and a title the drain
	// changed is listed, the session still running, ahead of its
	// notifications.
	t.drainStatus(e)
	s.Lock()
	e.endStatusLocked()
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
