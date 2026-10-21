// Package client speaks vaquitad's WebSocket protocol for the CLI commands
// and tests.
package client

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

// ErrVersion means the daemon speaks another protocol version.
var ErrVersion = errors.New("protocol version mismatch")

// Event is one thing received from the daemon: a message, a frame, or why
// the connection ended. An Err event is the last before Events is closed;
// a connection ended by Close has none.
type Event struct {
	Msg   any             // a message as returned by protocol.ParseMessage
	Frame *protocol.Frame // a binary frame
	Err   error
}

// Client is a connection that has completed the hello.
type Client struct {
	ws      *websocket.Conn
	ctx     context.Context // cancelled by Close
	cancel  context.CancelFunc
	events  chan Event
	closing atomic.Bool
}

// Dial connects to the daemon at ep as a client of the given kind
// (protocol.ClientGUI or ClientAttach) and returns the session list the
// daemon sends after the hello. ctx bounds the handshake only.
func Dial(ctx context.Context, ep state.Endpoint, kind string) (*Client, []protocol.SessionInfo, error) {
	ws, _, err := websocket.Dial(ctx, ep.URL, nil)
	if err != nil {
		return nil, nil, err
	}
	ws.SetReadLimit(protocol.MaxMessage)
	list, err := handshake(ctx, ws, ep.Token, kind)
	if err != nil {
		ws.CloseNow()
		return nil, nil, err
	}
	c := &Client{ws: ws, events: make(chan Event, 64)}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	go c.readLoop()
	return c, list, nil
}

func handshake(ctx context.Context, ws *websocket.Conn, token, kind string) ([]protocol.SessionInfo, error) {
	hello := protocol.Hello{T: protocol.THello, V: protocol.Version, Token: token, Client: kind}
	if err := wsjson.Write(ctx, ws, hello); err != nil {
		return nil, err
	}
	m, err := readMessage(ctx, ws)
	if err != nil {
		return nil, err
	}
	switch m := m.(type) {
	case protocol.Hello:
		if m.V != protocol.Version {
			return nil, fmt.Errorf("%w: daemon speaks v%d, this client v%d", ErrVersion, m.V, protocol.Version)
		}
	case protocol.Error:
		if m.Code == protocol.CodeVersion {
			return nil, fmt.Errorf("%w: daemon speaks v%d, this client v%d", ErrVersion, m.V, protocol.Version)
		}
		return nil, fmt.Errorf("daemon refused hello: %s", m.Code)
	default:
		return nil, fmt.Errorf("expected hello from daemon, got %T", m)
	}
	m, err = readMessage(ctx, ws)
	if err != nil {
		return nil, err
	}
	s, ok := m.(protocol.Sessions)
	if !ok {
		return nil, fmt.Errorf("expected sessions after hello, got %T", m)
	}
	return s.List, nil
}

func readMessage(ctx context.Context, ws *websocket.Conn) (any, error) {
	typ, data, err := ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText {
		return nil, errors.New("binary frame during the handshake")
	}
	return protocol.ParseMessage(data)
}

// Events delivers what the daemon sends after the handshake. It is closed
// when the connection ends.
func (c *Client) Events() <-chan Event { return c.events }

func (c *Client) readLoop() {
	defer close(c.events)
	for {
		ev, err := c.read()
		if err != nil {
			if !c.closing.Load() {
				c.emit(Event{Err: err})
			}
			return
		}
		if !c.emit(ev) {
			return
		}
	}
}

// read returns the next event. A daemon sending something this client
// cannot decode speaks another protocol, so the connection is closed rather
// than the stream misread.
func (c *Client) read() (Event, error) {
	typ, data, err := c.ws.Read(c.ctx)
	if err != nil {
		return Event{}, err
	}
	if typ == websocket.MessageBinary {
		f, err := protocol.Decode(data)
		if err != nil {
			c.ws.Close(websocket.StatusUnsupportedData, "bad frame")
			return Event{}, err
		}
		return Event{Frame: &f}, nil
	}
	m, err := protocol.ParseMessage(data)
	if err != nil {
		c.ws.Close(websocket.StatusUnsupportedData, "bad message")
		return Event{}, err
	}
	return Event{Msg: m}, nil
}

func (c *Client) emit(ev Event) bool {
	select {
	case c.events <- ev:
		return true
	case <-c.ctx.Done():
		return false
	}
}

func (c *Client) send(m any) error { return wsjson.Write(c.ctx, c.ws, m) }

func (c *Client) Create(cwd, cmd, name string, cols, rows int) error {
	return c.send(protocol.Create{T: protocol.TCreate, Cwd: cwd, Cmd: cmd, Name: name, Cols: cols, Rows: rows})
}

func (c *Client) Subscribe(sid uint32) error {
	return c.send(protocol.Subscribe{T: protocol.TSubscribe, SID: sid})
}

func (c *Client) Unsubscribe(sid uint32) error {
	return c.send(protocol.Unsubscribe{T: protocol.TUnsubscribe, SID: sid})
}

func (c *Client) Ack(sid, gen uint32, off uint64) error {
	return c.send(protocol.Ack{T: protocol.TAck, SID: sid, Gen: gen, Off: off})
}

func (c *Client) Resize(sid uint32, cols, rows int) error {
	return c.send(protocol.Resize{T: protocol.TResize, SID: sid, Cols: cols, Rows: rows})
}

func (c *Client) Kill(sid uint32) error {
	return c.send(protocol.Kill{T: protocol.TKill, SID: sid})
}

// Input sends p to session sid as input frames of generation gen, split to
// fit the 64KB payload limit.
func (c *Client) Input(sid, gen uint32, p []byte) error {
	for len(p) > 0 {
		n := min(len(p), protocol.MaxPayload)
		b, err := protocol.Encode(protocol.Frame{Type: protocol.FrameInput, SID: sid, Gen: gen, Payload: p[:n]})
		if err != nil {
			return err
		}
		if err := c.ws.Write(c.ctx, websocket.MessageBinary, b); err != nil {
			return err
		}
		p = p[n:]
	}
	return nil
}

// Close closes the connection normally. Events is closed without an Err
// event.
func (c *Client) Close() error {
	c.closing.Store(true)
	err := c.ws.Close(websocket.StatusNormalClosure, "")
	c.cancel()
	return err
}
