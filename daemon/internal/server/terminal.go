package server

import (
	"errors"
	"log/slog"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/session"
)

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
