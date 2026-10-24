package server

import (
	"log/slog"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
)

// shutdown agrees to a client's shutdown request, or refuses an idle one
// while a session runs or is starting. The check and the stop on new
// sessions are one step under t.mu, so no session starts in between that an
// idle shutdown would end.
func (c *conn) shutdown(m protocol.Shutdown) {
	t := c.srv.table
	t.mu.Lock()
	busy := m.Idle && t.runningLocked()
	if !busy {
		t.stopping = true
	}
	t.mu.Unlock()
	if busy {
		c.send(protocol.Error{T: protocol.TError, Code: protocol.CodeBusy})
		return
	}
	slog.Info("shutdown requested", "remote", c.remote, "client", c.client, "idle", m.Idle)
	c.srv.stopOnce.Do(func() { close(c.srv.stopping) })
}

// runningLocked reports whether a session is running or starting. Records of
// an earlier run and exited sessions hold no process of the daemon's. It
// requires t.mu and takes one session lock at a time, which keeps the lock
// order.
func (t *table) runningLocked() bool {
	if t.starting > 0 {
		return true
	}
	for _, e := range t.entries {
		if e.sess == nil {
			continue
		}
		e.sess.Lock()
		exited := e.exited
		e.sess.Unlock()
		if !exited {
			return true
		}
	}
	return false
}
