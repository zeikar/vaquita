package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/zeikar/vaquita/daemon/internal/client"
	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

const (
	testToken        = "test-token"
	testHelloTimeout = 200 * time.Millisecond
)

func startServer(t *testing.T, allowOrigins ...string) *Server {
	t.Helper()
	return listen(t, Options{AllowOrigins: allowOrigins})
}

// listen starts a server with opts, filling in the test token, hello
// timeout, /bin/sh and a fresh home where opts leaves them out, and closes
// it when the test ends.
func listen(t *testing.T, opts Options) *Server {
	t.Helper()
	if opts.Token == "" {
		opts.Token = testToken
	}
	if opts.HelloTimeout == 0 {
		opts.HelloTimeout = testHelloTimeout
	}
	if opts.Shell == "" {
		opts.Shell = "/bin/sh"
	}
	if opts.Home == "" {
		opts.Home = t.TempDir()
	}
	srv, err := Listen(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := srv.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return srv
}

func testCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// dial opens a raw WebSocket to srv, sending origin unless it is empty.
func dial(t *testing.T, srv *Server, origin string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	return dialHost(t, srv, origin, "")
}

// dialHost is dial with the Host header set to host unless it is empty.
func dialHost(t *testing.T, srv *Server, origin, host string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	opts := &websocket.DialOptions{Host: host}
	if origin != "" {
		opts.HTTPHeader = http.Header{"Origin": {origin}}
	}
	ws, resp, err := websocket.Dial(testCtx(t), srv.URL(), opts)
	if err == nil {
		ws.SetReadLimit(protocol.MaxMessage)
		t.Cleanup(func() { ws.CloseNow() })
	}
	return ws, resp, err
}

func mustDial(t *testing.T, srv *Server, origin string) *websocket.Conn {
	t.Helper()
	ws, _, err := dial(t, srv, origin)
	if err != nil {
		t.Fatalf("dial with Origin %q: %v", origin, err)
	}
	return ws
}

func write(t *testing.T, ws *websocket.Conn, typ websocket.MessageType, data []byte) {
	t.Helper()
	if err := ws.Write(testCtx(t), typ, data); err != nil {
		t.Fatal(err)
	}
}

func writeJSON(t *testing.T, ws *websocket.Conn, v any) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	write(t, ws, websocket.MessageText, data)
}

func goodHello() protocol.Hello {
	return protocol.Hello{T: protocol.THello, V: protocol.Version, Token: testToken, Client: protocol.ClientGUI}
}

// readText reads one message and requires it to be text.
func readText(t *testing.T, ws *websocket.Conn) []byte {
	t.Helper()
	typ, data, err := ws.Read(testCtx(t))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("got a %v message, want text", typ)
	}
	return data
}

func readMessage(t *testing.T, ws *websocket.Conn) any {
	t.Helper()
	m, err := protocol.ParseMessage(readText(t, ws))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// expectClose requires the next read to report a close with status want,
// with no message before it.
func expectClose(t *testing.T, ws *websocket.Conn, want websocket.StatusCode) {
	t.Helper()
	typ, data, err := ws.Read(testCtx(t))
	if err == nil {
		t.Fatalf("got %v message %q, want close %v", typ, data, want)
	}
	if got := websocket.CloseStatus(err); got != want {
		t.Fatalf("read err = %v (status %v), want close %v", err, got, want)
	}
}

// handshake sends a good hello and consumes the hello and sessions replies.
func handshake(t *testing.T, ws *websocket.Conn) {
	t.Helper()
	writeJSON(t, ws, goodHello())
	if m, ok := readMessage(t, ws).(protocol.Hello); !ok || m.V != protocol.Version {
		t.Fatalf("first reply = %+v, want hello v%d", m, protocol.Version)
	}
	if _, ok := readMessage(t, ws).(protocol.Sessions); !ok {
		t.Fatal("second reply is not sessions")
	}
	// goodHello is a GUI's, which is also sent the repo list.
	if _, ok := readMessage(t, ws).(protocol.Repos); !ok {
		t.Fatal("third reply is not repos")
	}
}

func TestListenRequiresTokenAndHome(t *testing.T) {
	if _, err := Listen(Options{Home: t.TempDir()}); err == nil {
		t.Fatal("Listen with an empty token succeeded")
	}
	if _, err := Listen(Options{Token: testToken}); err == nil {
		t.Fatal("Listen with an empty home succeeded")
	}
}

func TestHelloRepliesHelloThenSessions(t *testing.T) {
	srv := startServer(t)
	if !strings.HasPrefix(srv.URL(), "ws://127.0.0.1:") {
		t.Fatalf("URL = %q, want a loopback address", srv.URL())
	}
	ws := mustDial(t, srv, "")
	writeJSON(t, ws, goodHello())
	m := readMessage(t, ws)
	if h, ok := m.(protocol.Hello); !ok || h.V != protocol.Version || h.Token != "" {
		t.Fatalf("first reply = %+v, want hello v%d without a token", m, protocol.Version)
	}
	if got, want := string(readText(t, ws)), `{"t":"sessions","list":[]}`; strings.TrimSpace(got) != want {
		t.Fatalf("second reply = %s, want %s", got, want)
	}
}

func TestClientDial(t *testing.T) {
	srv := startServer(t)
	c, list, err := client.Dial(testCtx(t), state.Endpoint{URL: srv.URL(), Token: testToken}, protocol.ClientAttach)
	if err != nil {
		t.Fatal(err)
	}
	if list == nil || len(list) != 0 {
		t.Fatalf("list = %#v, want empty", list)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	for ev := range c.Events() {
		t.Fatalf("event after Close: %+v", ev)
	}
}

func TestClientDialBadToken(t *testing.T) {
	srv := startServer(t)
	_, _, err := client.Dial(testCtx(t), state.Endpoint{URL: srv.URL(), Token: "wrong"}, protocol.ClientAttach)
	if got := websocket.CloseStatus(err); got != websocket.StatusPolicyViolation {
		t.Fatalf("err = %v, want close %v", err, websocket.StatusPolicyViolation)
	}
}

func TestBadHelloIsClosed(t *testing.T) {
	hello := func(edit func(*protocol.Hello)) []byte {
		h := goodHello()
		edit(&h)
		b, err := json.Marshal(h)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	cases := []struct {
		name string
		typ  websocket.MessageType
		data []byte
	}{
		{"wrong token", websocket.MessageText, hello(func(h *protocol.Hello) { h.Token = "wrong" })},
		{"missing token", websocket.MessageText, hello(func(h *protocol.Hello) { h.Token = "" })},
		{"unknown client kind", websocket.MessageText, hello(func(h *protocol.Hello) { h.Client = "browser" })},
		{"subscribe first", websocket.MessageText, []byte(`{"t":"subscribe","sid":1}`)},
		{"not json", websocket.MessageText, []byte(`hello`)},
		{"binary first", websocket.MessageBinary, make([]byte, protocol.HeaderSize)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ws := mustDial(t, startServer(t), "")
			write(t, ws, c.typ, c.data)
			expectClose(t, ws, websocket.StatusPolicyViolation)
		})
	}
}

func TestVersionMismatchSendsErrorThenCloses(t *testing.T) {
	ws := mustDial(t, startServer(t), "")
	h := goodHello()
	h.V = protocol.Version + 1
	writeJSON(t, ws, h)
	m := readMessage(t, ws)
	if e, ok := m.(protocol.Error); !ok || e.Code != protocol.CodeVersion || e.V != protocol.Version {
		t.Fatalf("reply = %+v, want error %q with v%d", m, protocol.CodeVersion, protocol.Version)
	}
	expectClose(t, ws, websocket.StatusNormalClosure)
}

func TestHelloTimeout(t *testing.T) {
	ws := mustDial(t, startServer(t), "")
	start := time.Now()
	expectClose(t, ws, websocket.StatusPolicyViolation)
	if d := time.Since(start); d < testHelloTimeout*3/4 {
		t.Fatalf("closed after %v, before the %v hello timeout", d, testHelloTimeout)
	}
}

func TestOrigins(t *testing.T) {
	const devOrigin = "http://localhost:1420"
	cases := []struct {
		origin string
		allow  []string
		ok     bool
	}{
		{"", nil, true},
		{"tauri://localhost", nil, true},
		{"http://localhost", nil, false},
		{"https://localhost", nil, false},
		{"http://localhost:9999", nil, false},
		{devOrigin, nil, false},
		{devOrigin, []string{devOrigin}, true},
		{"http://localhost:9999", []string{devOrigin}, false},
		{"https://localhost:1420", []string{devOrigin}, false},
		{"http://evil.example", nil, false},
		{"http://evil.example", []string{devOrigin}, false},
		// Sandboxed frames and file:// pages send a literal "null".
		{"null", nil, false},
		{"null", []string{devOrigin}, false},
	}
	for _, c := range cases {
		srv := startServer(t, c.allow...)
		ws, resp, err := dial(t, srv, c.origin)
		if !c.ok {
			if err == nil {
				t.Errorf("Origin %q (allowed %v): upgrade accepted, want rejected", c.origin, c.allow)
			} else if resp == nil || resp.StatusCode != http.StatusForbidden {
				t.Errorf("Origin %q (allowed %v): err = %v, want 403", c.origin, c.allow, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("Origin %q (allowed %v): %v", c.origin, c.allow, err)
			continue
		}
		handshake(t, ws)
	}
}

func TestHostMustBeListenAddress(t *testing.T) {
	cases := []struct {
		name         string
		origin, host string // "P" is replaced by the server's port
		ok           bool
	}{
		{"DNS rebinding", "http://evil.example:P", "evil.example:P", false},
		{"foreign host without origin", "", "evil.example:P", false},
		{"localhost instead of the listen address", "", "localhost:P", false},
		// coder/websocket admits an Origin equal to the Host. With the Host
		// pinned to the listen address that origin is the daemon itself,
		// which serves no pages, so no web page can send it.
		{"origin of the listen address", "http://127.0.0.1:P", "127.0.0.1:P", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := startServer(t)
			port := srv.ln.Addr().(*net.TCPAddr).Port
			fill := func(s string) string { return strings.ReplaceAll(s, "P", strconv.Itoa(port)) }
			ws, resp, err := dialHost(t, srv, fill(c.origin), fill(c.host))
			if !c.ok {
				if err == nil {
					t.Fatal("upgrade accepted, want rejected")
				}
				if resp == nil || resp.StatusCode != http.StatusForbidden {
					t.Fatalf("err = %v, want 403", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			handshake(t, ws)
		})
	}
}

func TestReadLimitBeforeHello(t *testing.T) {
	ws := mustDial(t, startServer(t), "")
	write(t, ws, websocket.MessageText, []byte(`{"t":"hello","pad":"`+strings.Repeat("x", helloReadLimit)+`"}`))
	expectClose(t, ws, websocket.StatusMessageTooBig)
}

func TestReadLimitRaisedAfterHello(t *testing.T) {
	ws := mustDial(t, startServer(t), "")
	handshake(t, ws)
	write(t, ws, websocket.MessageText, []byte(`{"t":"no-such-type","pad":"`+strings.Repeat("x", 2*helloReadLimit)+`"}`))
	if e, ok := readMessage(t, ws).(protocol.Error); !ok || e.Code != protocol.CodeBadRequest {
		t.Fatalf("reply = %+v, want error %q", e, protocol.CodeBadRequest)
	}
}

func TestOversizeFrameCloses(t *testing.T) {
	ws := mustDial(t, startServer(t), "")
	handshake(t, ws)
	write(t, ws, websocket.MessageBinary, make([]byte, protocol.HeaderSize+protocol.MaxPayload+1))
	expectClose(t, ws, websocket.StatusMessageTooBig)
}

func TestCloseSendsGoingAway(t *testing.T) {
	srv, err := Listen(Options{Token: testToken, HelloTimeout: testHelloTimeout, Home: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := client.Dial(testCtx(t), state.Endpoint{URL: srv.URL(), Token: testToken}, protocol.ClientGUI)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	if err := srv.Close(); err != nil {
		t.Fatal(err)
	}
	ev, ok := <-c.Events()
	if !ok {
		t.Fatal("Events closed without an error event")
	}
	if _, isRepos := ev.Msg.(protocol.Repos); isRepos {
		ev, ok = <-c.Events()
		if !ok {
			t.Fatal("Events closed without an error event")
		}
	}
	if got := websocket.CloseStatus(ev.Err); got != websocket.StatusGoingAway {
		t.Fatalf("event = %+v, want close %v", ev, websocket.StatusGoingAway)
	}
	if _, ok := <-c.Events(); ok {
		t.Fatal("Events not closed after the error event")
	}
	if _, _, err := websocket.Dial(testCtx(t), srv.URL(), nil); err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("dial after Close: err = %v, want refused", err)
	}
}
