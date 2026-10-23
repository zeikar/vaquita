package server

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/session"
)

// helloReadLimit caps messages until the hello has passed, so a client
// without the token cannot make the daemon buffer a megabyte.
const helloReadLimit = 4 << 10

// maxControlQueue bounds control messages waiting for the writer. They are
// small and rare, so a client this far behind has stopped reading.
const maxControlQueue = 256

// conn is one client connection. The goroutine running serve reads and
// handles requests; after the hello a writer goroutine makes every write,
// so nothing else ever blocks on a slow client.
type conn struct {
	srv    *Server
	ws     *websocket.Conn
	remote string
	ctx    context.Context
	cancel context.CancelFunc
	client string // protocol.ClientGUI or ClientAttach, set by the hello

	mu         sync.Mutex
	queue      []any         // control messages for the writer, in order
	overflowed bool          // the queue filled up; the connection is closing
	subs       []*subscriber // this connection's subscriptions, in the order made
	wake       chan struct{} // cap 1; tells the writer there is something to send

	closeOnce sync.Once
	closed    chan struct{} // closed once the close handshake has finished
}

func newConn(srv *Server, ws *websocket.Conn, remote string) *conn {
	ctx, cancel := context.WithCancel(context.Background())
	return &conn{
		srv:    srv,
		ws:     ws,
		remote: remote,
		ctx:    ctx,
		cancel: cancel,
		wake:   make(chan struct{}, 1),
		closed: make(chan struct{}),
	}
}

func (c *conn) serve() {
	defer c.cancel()
	var writerDone chan struct{}
	if c.hello() {
		writerDone = make(chan struct{})
		session.Go("conn writer", func() {
			defer close(writerDone)
			c.writeLoop()
		})
		c.readLoop()
		c.srv.table.leave(c)
	}
	// Whatever ended the reader has started closing the socket or found it
	// closed, so this is normally a no-op. The close handshake must finish
	// before c.ctx is cancelled: cancelling a write in progress drops the
	// connection, and the close frame with it.
	c.closeWith(websocket.StatusNormalClosure, "")
	<-c.closed
	if writerDone != nil {
		c.cancel()
		<-writerDone
	}
}

// hello runs the hello gate and reports whether the client passed it. Until
// it returns, this goroutine is the only one writing.
func (c *conn) hello() bool {
	timer := time.AfterFunc(c.srv.opts.HelloTimeout, func() {
		slog.Warn("connection rejected", "remote", c.remote, "reason", "hello timeout")
		c.closeWith(websocket.StatusPolicyViolation, "hello timeout")
	})
	typ, data, err := c.ws.Read(c.ctx)
	if !timer.Stop() {
		return false
	}
	if err != nil {
		slog.Debug("connection ended before hello", "remote", c.remote, "err", err)
		return false
	}
	reject := func(reason string) bool {
		slog.Warn("connection rejected", "remote", c.remote, "reason", reason)
		c.closeWith(websocket.StatusPolicyViolation, reason)
		return false
	}
	if typ != websocket.MessageText {
		return reject("expected hello")
	}
	m, err := protocol.ParseMessage(data)
	h, ok := m.(protocol.Hello)
	if err != nil || !ok {
		return reject("expected hello")
	}
	// The token is checked before the version so a client that has not
	// read endpoint.json is only told it was refused, not which protocol
	// this daemon speaks.
	if subtle.ConstantTimeCompare([]byte(h.Token), []byte(c.srv.opts.Token)) != 1 {
		return reject("bad token")
	}
	if h.V != protocol.Version {
		slog.Warn("connection rejected", "remote", c.remote, "reason", "protocol version", "client_v", h.V)
		err := wsjson.Write(c.ctx, c.ws, protocol.Error{T: protocol.TError, Code: protocol.CodeVersion, V: protocol.Version})
		if err != nil {
			slog.Debug("send version error", "remote", c.remote, "err", err)
		}
		// A normal close, so the client reads the error as the reason
		// rather than as a policy violation.
		c.closeWith(websocket.StatusNormalClosure, "protocol version mismatch")
		return false
	}
	if h.Client != protocol.ClientGUI && h.Client != protocol.ClientAttach {
		return reject("unknown client kind")
	}
	c.client = h.Client
	c.ws.SetReadLimit(protocol.MaxMessage)
	c.srv.table.join(c)
	slog.Info("client connected", "remote", c.remote, "client", c.client)
	return true
}

func (c *conn) readLoop() {
	for {
		typ, data, err := c.ws.Read(c.ctx)
		if err != nil {
			slog.Info("client disconnected", "remote", c.remote, "client", c.client, "err", err)
			return
		}
		if typ == websocket.MessageBinary {
			f, err := protocol.Decode(data)
			// The read limit is well above a full frame, so an oversized
			// payload arrives whole; it is a client ignoring the 64KB
			// rule, and it is cut off rather than answered.
			if errors.Is(err, protocol.ErrPayloadTooLarge) {
				slog.Warn("closing connection", "remote", c.remote, "reason", "frame payload over 64KB", "len", len(data))
				c.closeWith(websocket.StatusMessageTooBig, "frame payload over 64KB")
				return
			}
			if err != nil {
				c.send(protocol.Error{T: protocol.TError, Code: protocol.CodeBadRequest})
				continue
			}
			c.handleFrame(f)
			continue
		}
		m, err := protocol.ParseMessage(data)
		if err != nil {
			c.send(protocol.Error{T: protocol.TError, Code: protocol.CodeBadRequest})
			continue
		}
		c.handle(m)
	}
}

// handle acts on a control message after the hello.
func (c *conn) handle(m any) {
	switch m := m.(type) {
	case protocol.Create:
		c.create(m)
	case protocol.Subscribe:
		c.subscribe(m.SID)
	case protocol.Unsubscribe:
		c.unsubscribe(m.SID)
	case protocol.Ack:
		c.ack(m)
	case protocol.Resize:
		c.resize(m)
	case protocol.Kill:
		c.kill(m.SID)
	case protocol.Dismiss:
		c.dismiss(m.SID)
	case protocol.Seen:
		c.seen(m.SID)
	case protocol.ReposList:
		c.reposList()
	case protocol.ReposAdd:
		c.reposAdd(m)
	case protocol.ReposRemove:
		c.reposRemove(m)
	default:
		c.send(protocol.Error{T: protocol.TError, Code: protocol.CodeBadRequest})
	}
}

// handleFrame acts on a binary frame after the hello; clients only send
// input.
func (c *conn) handleFrame(f protocol.Frame) {
	if f.Type != protocol.FrameInput {
		c.send(badRequest(f.SID))
		return
	}
	c.input(f)
}

// send queues a control message for the writer. It never blocks, so it may
// be called with locks held; a client too far behind to take more is
// disconnected instead.
func (c *conn) send(m any) {
	c.mu.Lock()
	if c.overflowed || len(c.queue) >= maxControlQueue {
		first := !c.overflowed
		c.overflowed = true
		c.mu.Unlock()
		if first {
			slog.Warn("closing connection", "remote", c.remote, "reason", "control queue full")
			c.closeWith(websocket.StatusPolicyViolation, "not reading")
		}
		return
	}
	c.queue = append(c.queue, m)
	c.mu.Unlock()
	c.wakeWriter()
}

// wakeWriter tells the writer to look for work. It never blocks, so the PTY
// reader may call it with the session lock held.
func (c *conn) wakeWriter() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// writeLoop makes every write after the hello. Each pass sends the queued
// control messages and then gives every subscription one pump step, sending
// control messages again after each, so that a busy session neither starves
// the others nor holds up control messages. It parks only after a pass that
// found nothing to send; anything that makes work afterwards wakes it.
func (c *conn) writeLoop() {
	// However the writer ends, a panic included, the connection ends with
	// it, so that the reader does not go on serving a client nothing is
	// sent to. Usually a close is already under way and this does nothing.
	defer c.closeWith(websocket.StatusInternalError, "writer stopped")
	for {
		busy, err := c.writePass()
		if err != nil {
			slog.Debug("write to client", "remote", c.remote, "err", err)
			return
		}
		if busy {
			continue
		}
		select {
		case <-c.ctx.Done():
			return
		case <-c.wake:
		}
	}
}

func (c *conn) writePass() (busy bool, err error) {
	if err := c.flushControl(); err != nil {
		return false, err
	}
	for _, sub := range c.subscriptions() {
		sent, err := c.pumpStep(sub)
		if err != nil {
			return false, err
		}
		if !sent {
			continue
		}
		busy = true
		if err := c.flushControl(); err != nil {
			return false, err
		}
	}
	return busy, nil
}

func (c *conn) flushControl() error {
	c.mu.Lock()
	batch := c.queue
	c.queue = nil
	c.mu.Unlock()
	for _, m := range batch {
		if err := c.writeMessage(m); err != nil {
			return err
		}
	}
	return nil
}

func (c *conn) writeMessage(m any) error { return wsjson.Write(c.ctx, c.ws, m) }

func (c *conn) writeFrame(typ byte, sid, gen uint32, p []byte) error {
	b, err := protocol.Encode(protocol.Frame{Type: typ, SID: sid, Gen: gen, Payload: p})
	if err != nil {
		return err
	}
	return c.ws.Write(c.ctx, websocket.MessageBinary, b)
}

// closeWith starts the close handshake with code unless one has already
// started. It doesn't wait for it: callers include goroutines that must not
// block on a slow client. c.closed is closed when the handshake is over.
func (c *conn) closeWith(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		session.Go("conn close", func() {
			defer close(c.closed)
			if err := c.ws.Close(code, reason); err != nil {
				slog.Debug("close connection", "remote", c.remote, "err", err)
			}
		})
	})
}
