package server

import (
	"slices"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/session"
)

// maxUnacked bounds the output a subscriber has been sent and not yet
// acknowledged. A GUI acks once xterm.js has written the bytes, so this is
// also how much can pile up in the webview's write queue, which would
// otherwise grow without bound behind a fast program.
const maxUnacked = 1 << 20

// A replay is sent whatever the acks, as it starts with nothing
// unacknowledged; it stays within maxUnacked only because the ring is no
// larger. This fails to compile otherwise.
const _ uint = maxUnacked - session.DefaultRingCap

// subscriber is one connection's subscription to one session. conn, e and
// sid are fixed; the rest is guarded by the session lock.
//
// All offsets are ring offsets. A snapshot fixes the replay range
// [from, replayTo); output appended after it goes out live. sentOff is the
// next offset to send, ackedOff how far the client has acknowledged, never
// beyond sentOff.
type subscriber struct {
	conn *conn
	e    *entry
	sid  uint32

	gen        uint32
	from       uint64
	replayTo   uint64
	sentOff    uint64
	ackedOff   uint64
	needReplay bool
	// dropped is set once the subscription has ended: unsubscribed, its
	// connection gone, or its exit sent. A pump step already under way for
	// it must not send anything more.
	dropped bool
	// writable is whether input and resizes from this subscriber are
	// taken; setWriter keeps it.
	writable bool
	// toldRO is the ro the client was last told, by live or an ro event.
	// The pump sends an ro whenever it differs from !writable.
	toldRO bool
}

// newSubscriber returns a subscription of c to e in generation 1 that starts
// with a replay of nothing at offset 0, which is right for a session that has
// not written anything yet. Subscribing to an existing session takes a
// snapshot on top. It is read-only until setWriter has run with it in
// e.subs.
func newSubscriber(c *conn, e *entry) *subscriber {
	return &subscriber{conn: c, e: e, sid: e.sid, gen: 1, needReplay: true}
}

// snapshot schedules a replay of everything now in the ring. It requires the
// session lock.
func (sub *subscriber) snapshot(r *session.Ring) {
	sub.from, sub.replayTo = r.Start(), r.End()
	sub.sentOff, sub.ackedOff = sub.from, sub.from
	sub.needReplay = true
}

// reset starts the subscription over in a new generation, so that the
// client can tell acks and frames of the old one apart. It requires the
// session lock.
func (sub *subscriber) reset(r *session.Ring) {
	sub.gen++
	sub.snapshot(r)
}

// detach ends sub, removing it from e and from its connection. It requires the
// session lock and does nothing for a subscription already ended.
func (e *entry) detach(sub *subscriber) {
	if sub.dropped {
		return
	}
	sub.dropped = true
	e.subs = slices.DeleteFunc(e.subs, func(x *subscriber) bool { return x == sub })
	sub.conn.removeSub(sub)
	e.setWriter()
}

// setWriter makes the earliest GUI subscriber the session's one writer, or
// the earliest subscriber when no GUI is subscribed: two terminals must
// never both answer the queries in the output. e.subs is in the order of
// subscribing; setWriter runs whenever it changes, and requires the session
// lock (or, for a session's creator, that nobody else can see the session
// yet).
//
// It only sets the flags and wakes the writers: the pump tells each client,
// so that the news is ordered with the subscription's own messages.
func (e *entry) setWriter() {
	var w *subscriber
	for _, sub := range e.subs {
		if sub.conn.client == protocol.ClientGUI {
			w = sub
			break
		}
	}
	if w == nil && len(e.subs) > 0 {
		w = e.subs[0]
	}
	for _, sub := range e.subs {
		writable := sub == w
		if sub.writable == writable {
			continue
		}
		sub.writable = writable
		sub.conn.wakeWriter()
	}
}

// replay is a replay copied out of the ring, to be sent without the lock.
type replay struct {
	msg    protocol.Replay
	prefix []byte
	chunks [][]byte
	live   protocol.Live
}

// takeReplay copies sub's pending replay and marks it sent. It requires the
// session lock, and from must still be in the ring, which pumpStep ensures.
func (sub *subscriber) takeReplay(s *session.Session) replay {
	out := s.Output()
	ring := out.Ring()
	cols, rows := s.Size()
	sub.toldRO = !sub.writable
	r := replay{
		msg: protocol.Replay{T: protocol.TReplay, SID: sub.sid, Gen: sub.gen, From: sub.from, To: sub.replayTo, Cols: cols, Rows: rows},
		// from is the ring start (pumpStep resets a subscription whose
		// from has been evicted), which is what the prefix is for.
		prefix: out.ReplayPrefix(),
		live:   protocol.Live{T: protocol.TLive, SID: sub.sid, Gen: sub.gen, Off: sub.replayTo, RO: sub.toldRO},
	}
	for off := sub.from; off < sub.replayTo; {
		end := min(sub.replayTo, off+protocol.MaxPayload)
		r.chunks = append(r.chunks, ring.CopyRange(off, end, nil))
		off = end
	}
	sub.sentOff = sub.replayTo
	sub.needReplay = false
	return r
}

// pumpStep sends sub's next piece of output: a whole replay, one live frame,
// or the exit. It reports whether anything was sent.
func (c *conn) pumpStep(sub *subscriber) (bool, error) {
	send := sub.next()
	if send == nil {
		return false, nil
	}
	return true, send(c)
}

// next decides what sub is sent next and copies it out of the ring under the
// session lock, returning the write to make once the lock is released, so
// that the PTY reader never waits on the network; nil means nothing to send.
// The lock is released by a defer, so a panic here cannot leave the session
// wedged.
func (sub *subscriber) next() func(*conn) error {
	e, s := sub.e, sub.e.sess
	s.Lock()
	defer s.Unlock()
	if sub.dropped {
		return nil
	}
	ring := s.Output().Ring()
	// What was sent has been evicted before the rest followed it, so the
	// client is sent a fresh replay in a new generation instead. Not while
	// sent output is unacknowledged: the subscription waits for its acks, so
	// a client that never acks cannot be sent a full replay every time the
	// ring wraps.
	if sub.sentOff < ring.Start() && sub.ackedOff == sub.sentOff {
		sub.reset(ring)
	}
	sid := sub.sid
	switch {
	case sub.needReplay:
		r := sub.takeReplay(s)
		return func(c *conn) error { return c.writeReplay(sid, r) }
	case sub.toldRO == sub.writable:
		// The writer has changed since the client was told. Sent here
		// rather than queued, it can come neither before the live that
		// first tells the client nor after the exit that ends the
		// subscription, and changes made in between collapse into one.
		// The acks do not hold it up.
		sub.toldRO = !sub.writable
		m := protocol.RO{T: protocol.TRO, SID: sid, RO: sub.toldRO}
		return func(c *conn) error { return c.writeMessage(m) }
	case sub.sentOff < ring.Start():
		// Waiting for the acks, as above.
	case sub.sentOff < ring.End() && sub.sentOff-sub.ackedOff < maxUnacked:
		// Live output stops while maxUnacked bytes are unacknowledged and
		// the chunk is cut to stay within it; with the replay bound above,
		// no more than maxUnacked bytes are ever unacknowledged. Only this
		// subscriber waits; the ring goes on filling.
		end := min(ring.End(), sub.sentOff+protocol.MaxPayload, sub.ackedOff+maxUnacked)
		p := ring.CopyRange(sub.sentOff, end, nil)
		sub.sentOff = end
		gen := sub.gen
		return func(c *conn) error { return c.writeFrame(protocol.FrameLive, sid, gen, p) }
	case e.exited && sub.sentOff >= e.finalOff:
		// The exit comes after the session's last output, and it ends the
		// subscription.
		m := protocol.Exit{T: protocol.TExit, SID: sid, Code: e.code}
		e.detach(sub)
		return func(c *conn) error { return c.writeMessage(m) }
	}
	return nil
}

// writeReplay sends a replay as one unbroken sequence: the replay message,
// the prefix frame, the ring bytes, then live.
func (c *conn) writeReplay(sid uint32, r replay) error {
	if err := c.writeMessage(r.msg); err != nil {
		return err
	}
	// Sent even when empty, so that the first replay frame is always the
	// prefix; the client's acks count only the ring bytes after it.
	if err := c.writeFrame(protocol.FrameReplay, sid, r.msg.Gen, r.prefix); err != nil {
		return err
	}
	for _, p := range r.chunks {
		if err := c.writeFrame(protocol.FrameReplay, sid, r.msg.Gen, p); err != nil {
			return err
		}
	}
	return c.writeMessage(r.live)
}

// addSub, removeSub, subscription and subscriptions keep c's subscription
// list. A subscriber is added to it and removed from it together with its
// session's list, under that session's lock (or, for a session's creator,
// before anyone else can see the session).

func (c *conn) addSub(sub *subscriber) {
	c.mu.Lock()
	c.subs = append(c.subs, sub)
	c.mu.Unlock()
}

func (c *conn) removeSub(sub *subscriber) {
	c.mu.Lock()
	c.subs = slices.DeleteFunc(c.subs, func(x *subscriber) bool { return x == sub })
	c.mu.Unlock()
}

// subscription returns c's subscription to sid, or nil.
func (c *conn) subscription(sid uint32) *subscriber {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, sub := range c.subs {
		if sub.sid == sid {
			return sub
		}
	}
	return nil
}

// subscriptions returns a copy of c's subscription list.
func (c *conn) subscriptions() []*subscriber {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.subs)
}
