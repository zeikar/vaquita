// Package server serves vaquitad's WebSocket protocol on loopback.
package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/zeikar/vaquita/daemon/internal/session"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

const defaultHelloTimeout = 5 * time.Second

// tauriOrigin is the Origin the packaged GUI's webview sends. Origin
// patterns containing "://" are matched against scheme://host, so this does
// not admit http://localhost.
const tauriOrigin = "tauri://localhost"

// Options configures Listen.
type Options struct {
	// Token must be presented in the hello; only readers of endpoint.json
	// know it.
	Token string
	// AllowOrigins are browser origins accepted besides the GUI's, such as
	// a dev server's "http://localhost:1420". Each is a coder/websocket
	// origin pattern, matched against scheme://host when it has a scheme.
	AllowOrigins []string
	// HelloTimeout is how long a new connection may take to send its
	// hello; 0 means 5s.
	HelloTimeout time.Duration
	Shell        string // absolute path of the shell sessions run
	// Home is the instance directory, where state.json is saved on every
	// change to the sessions.
	Home string
	// State is state.json as loaded. Its records are of a previous run's
	// sessions, which have no PTY here: they are listed as exited until a
	// rescan decides what becomes of them.
	State state.State
}

// Server accepts WebSocket connections on 127.0.0.1.
type Server struct {
	opts    Options
	origins []string
	ln      net.Listener
	hs      *http.Server
	table   *table

	mu      sync.Mutex
	conns   map[*conn]struct{}
	closing bool
	wg      sync.WaitGroup // one per tracked conn
}

// NewToken returns 32 random bytes in hex.
func NewToken() string {
	b := make([]byte, 32)
	rand.Read(b) // never fails since Go 1.24
	return hex.EncodeToString(b)
}

// Listen starts serving on a free loopback port.
func Listen(opts Options) (*Server, error) {
	// An empty token would match a hello that leaves it out.
	if opts.Token == "" {
		return nil, errors.New("server: empty token")
	}
	// Saving with an empty home would write state.json to the working
	// directory.
	if opts.Home == "" {
		return nil, errors.New("server: empty home")
	}
	if opts.HelloTimeout <= 0 {
		opts.HelloTimeout = defaultHelloTimeout
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen: %w", err)
	}
	s := &Server{
		opts:    opts,
		origins: append([]string{tauriOrigin}, opts.AllowOrigins...),
		ln:      ln,
		table:   newTable(opts.Home, opts.State),
		conns:   make(map[*conn]struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", s.handleWS)
	s.hs = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	session.Go("http server", func() {
		if err := s.hs.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			slog.Error("http server stopped", "err", err)
		}
	})
	return s, nil
}

// URL is the WebSocket URL clients dial.
func (s *Server) URL() string { return "ws://" + s.ln.Addr().String() + "/ws" }

// Close stops accepting connections and closes the open ones with 1001
// (going away), returning once each has finished closing.
func (s *Server) Close() error {
	s.mu.Lock()
	s.closing = true
	conns := make([]*conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	// http.Server.Close doesn't know about hijacked (upgraded) connections;
	// those are closed below.
	err := s.hs.Close()
	for _, c := range conns {
		c.closeWith(websocket.StatusGoingAway, "daemon stopping")
	}
	s.wg.Wait()
	return err
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	// Rejections log at Debug: any web page that finds the port can cause
	// them, and the log is append-only.
	//
	// Every real client dials the URL in endpoint.json, so the Host is
	// exactly the listen address. Anything else is a page reaching the port
	// through DNS rebinding, whose Origin would match its own Host.
	if r.Host != s.ln.Addr().String() {
		slog.Debug("websocket upgrade rejected", "remote", r.RemoteAddr, "host", r.Host, "reason", "foreign host")
		http.Error(w, http.StatusText(http.StatusForbidden), http.StatusForbidden)
		return
	}
	// A missing Origin is accepted: browsers always send one, so only
	// non-browser clients (the CLI) leave it out, and the token still gates
	// them. Accept also admits an Origin equal to the Host; with the Host
	// pinned above, that is the daemon's own address, which serves no pages.
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.origins})
	if err != nil {
		slog.Debug("websocket upgrade rejected", "remote", r.RemoteAddr, "origin", r.Header.Get("Origin"), "err", err)
		return
	}
	ws.SetReadLimit(helloReadLimit)
	c := newConn(s, ws, r.RemoteAddr)
	if !s.track(c) {
		c.cancel()
		c.closeWith(websocket.StatusGoingAway, "daemon stopping")
		<-c.closed
		return
	}
	defer s.untrack(c)
	c.serve()
}

func (s *Server) track(c *conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return false
	}
	s.conns[c] = struct{}{}
	s.wg.Add(1)
	return true
}

func (s *Server) untrack(c *conn) {
	s.mu.Lock()
	delete(s.conns, c)
	s.mu.Unlock()
	s.wg.Done()
}
