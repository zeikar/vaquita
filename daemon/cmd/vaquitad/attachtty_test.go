package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/client"
	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/server"
	"github.com/zeikar/vaquita/daemon/internal/session"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

const (
	attachToken   = "attach-test-token"
	attachTimeout = 10 * time.Second
	// da1Text is a DA1 reply as `cat -v` shows it: what a reply that
	// reaches the test sessions looks like in their output.
	da1Text = "^[[?1;2c"
	// replyDelay is how long the fake terminal takes to answer. A real one
	// takes a few milliseconds, by which time attach has usually moved on
	// past the replay; answering at once would hide a fence that counts
	// wrong behind replies read before it was even written.
	replyDelay = 20 * time.Millisecond
	// echoCmd prepares a session that shows each byte it is sent once, as
	// soon as it arrives: no tty echo, no line buffering, escapes visible.
	echoCmd = `stty -echo -icanon; `
)

// fakeTTY stands in for the user's terminal. It keeps everything attach
// writes and, like a real terminal, answers each plain DA1 query and cursor
// position request in it, in order, by queueing the reply as input after
// replyDelay. Input is one FIFO,
// so what a test types lands after the replies to every query already
// written.
type fakeTTY struct {
	mu        sync.Mutex
	cond      *sync.Cond
	out       []byte
	queryEnds []int // offsets in out just after each DA1 query
	in        []chunk
	closed    bool
	reading   bool          // a Read is waiting for input
	hold      chan struct{} // while set, Write waits for it to close
	mute      bool          // a terminal that never answers
	cols      int
	rows      int
	sc        *session.Scanner
	sawQuery  bool
	sawCPR    bool
}

func newFakeTTY() *fakeTTY {
	t := &fakeTTY{cols: 80, rows: 24}
	t.cond = sync.NewCond(&t.mu)
	t.sc = session.NewScanner(ttySink{t})
	return t
}

// chunk is input that attach can read from ready on.
type chunk struct {
	p     []byte
	ready time.Time
}

// queue adds p to the input, readable after delay but never before what is
// queued already. It requires t.mu.
func (t *fakeTTY) queue(p []byte, delay time.Duration) {
	ready := time.Now().Add(delay)
	if n := len(t.in); n > 0 && t.in[n-1].ready.After(ready) {
		ready = t.in[n-1].ready
	}
	t.in = append(t.in, chunk{p: bytes.Clone(p), ready: ready})
	time.AfterFunc(time.Until(ready), func() {
		t.mu.Lock()
		t.cond.Broadcast()
		t.mu.Unlock()
	})
}

// ttySink spots DA1 queries and cursor position requests independently of
// the code under test.
type ttySink struct{ t *fakeTTY }

func (ttySink) OSC(int, []byte, bool) {}
func (ttySink) ESC(byte)              {}
func (s ttySink) CSI(params, intermediates []byte, final byte) {
	if final == 'c' && len(intermediates) == 0 && (len(params) == 0 || string(params) == "0") {
		s.t.sawQuery = true
	}
	if final == 'n' && len(intermediates) == 0 && string(params) == "6" {
		s.t.sawCPR = true
	}
}

func (t *fakeTTY) Write(p []byte) (int, error) {
	t.mu.Lock()
	hold := t.hold
	t.mu.Unlock()
	if hold != nil {
		<-hold
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for i := range p {
		t.out = append(t.out, p[i])
		t.sc.Scan(p[i : i+1])
		if t.sawCPR {
			t.sawCPR = false
			if !t.mute {
				t.queue([]byte("\x1b[1;1R"), replyDelay)
			}
		}
		if !t.sawQuery {
			continue
		}
		t.sawQuery = false
		t.queryEnds = append(t.queryEnds, len(t.out))
		if !t.mute {
			t.queue([]byte(da1Reply), replyDelay)
		}
	}
	return len(p), nil
}

func (t *fakeTTY) Read(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for {
		if len(t.in) > 0 && !time.Now().Before(t.in[0].ready) {
			t.reading = false
			n := copy(p, t.in[0].p)
			if t.in[0].p = t.in[0].p[n:]; len(t.in[0].p) == 0 {
				t.in = t.in[1:]
			}
			return n, nil
		}
		if len(t.in) == 0 && t.closed {
			return 0, io.EOF
		}
		t.reading = true
		t.cond.Wait()
	}
}

func (t *fakeTTY) typeIn(s string) {
	t.mu.Lock()
	t.queue([]byte(s), 0)
	t.mu.Unlock()
}

func (t *fakeTTY) close() {
	t.mu.Lock()
	t.closed = true
	t.cond.Broadcast()
	t.mu.Unlock()
	t.release()
}

// holdWrites makes the terminal stop taking output until release.
func (t *fakeTTY) holdWrites() {
	t.mu.Lock()
	t.hold = make(chan struct{})
	t.mu.Unlock()
}

func (t *fakeTTY) release() {
	t.mu.Lock()
	if t.hold != nil {
		close(t.hold)
		t.hold = nil
	}
	t.mu.Unlock()
}

func (t *fakeTTY) size() (int, int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cols, t.rows, nil
}

func (t *fakeTTY) setSize(cols, rows int) {
	t.mu.Lock()
	t.cols, t.rows = cols, rows
	t.mu.Unlock()
}

func (t *fakeTTY) output() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.out)
}

func (t *fakeTTY) queries() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.queryEnds)
}

// queryEnd is the offset in the output just after the i-th DA1 query.
func (t *fakeTTY) queryEnd(i int) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.queryEnds[i]
}

func (t *fakeTTY) unread() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var b []byte
	for _, c := range t.in {
		b = append(b, c.p...)
	}
	return string(b)
}

// waitFor waits until cond holds for the output so far.
func (t *fakeTTY) waitFor(tb testing.TB, what string, cond func(out string) bool) {
	tb.Helper()
	for deadline := time.Now().Add(attachTimeout); !cond(t.output()); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			tb.Fatalf("no %s within %v; output %q", what, attachTimeout, t.output())
		}
	}
}

func (t *fakeTTY) waitQueries(tb testing.TB, n int) {
	tb.Helper()
	t.waitFor(tb, "DA1 query", func(string) bool { return t.queries() >= n })
}

// waitIdle waits until attach has taken all input typed so far: with the
// input empty and attach back in Read, its unbuffered hand-off of the last
// read has completed, so anything attach handles next comes after it.
func (t *fakeTTY) waitIdle(tb testing.TB) {
	tb.Helper()
	t.waitFor(tb, "idle input", func(string) bool {
		t.mu.Lock()
		defer t.mu.Unlock()
		return len(t.in) == 0 && t.reading
	})
}

func contains(s string) func(string) bool {
	return func(out string) bool { return strings.Contains(out, s) }
}

// startDaemon runs a daemon in the test whose sessions run /bin/sh with a
// fresh HOME, so that none of the user's rc files affect them.
func startDaemon(t *testing.T) *server.Server {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	srv, err := server.Listen(server.Options{Token: attachToken, Shell: "/bin/sh", Home: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := srv.Close(); err != nil {
			t.Errorf("close server: %v", err)
		}
	})
	t.Cleanup(func() { killSessions(t, srv) })
	return srv
}

func dialDaemonTest(t *testing.T, srv *server.Server, kind string) (*client.Client, []protocol.SessionInfo) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), attachTimeout)
	defer cancel()
	c, list, err := client.Dial(ctx, state.Endpoint{URL: srv.URL(), Token: attachToken}, kind)
	if err != nil {
		t.Fatal(err)
	}
	return c, list
}

// killSessions kills the sessions still running and waits for their exits,
// so that nothing is left behind and nothing writes state.json while the
// test's home is removed.
func killSessions(t *testing.T, srv *server.Server) {
	c, list := dialDaemonTest(t, srv, protocol.ClientAttach)
	defer c.Close()
	anyRunning := func() bool {
		for _, s := range list {
			if s.State == protocol.StateRunning {
				return true
			}
		}
		return false
	}
	for _, s := range list {
		if s.State == protocol.StateRunning {
			if err := c.Kill(s.SID); err != nil {
				t.Errorf("kill session %d: %v", s.SID, err)
				return
			}
		}
	}
	deadline := time.After(attachTimeout)
	for anyRunning() {
		select {
		case ev, ok := <-c.Events():
			if !ok || ev.Err != nil {
				t.Errorf("waiting for the sessions to exit: connection ended: %v", ev.Err)
				return
			}
			if m, ok := ev.Msg.(protocol.Sessions); ok {
				list = m.List
			}
		case <-deadline:
			t.Errorf("sessions still running: %+v", list)
			return
		}
	}
}

// attachRun is an attach core running against a fakeTTY.
type attachRun struct {
	t        *testing.T
	a        *attacher
	tty      *fakeTTY
	stop     chan os.Signal
	winch    chan os.Signal
	done     chan ending
	ended    bool
	restores atomic.Int32
}

func startAttach(t *testing.T, srv *server.Server, tty *fakeTTY, cfg attachConfig) *attachRun {
	t.Helper()
	c, _ := dialDaemonTest(t, srv, protocol.ClientAttach)
	r := &attachRun{t: t, tty: tty, stop: make(chan os.Signal, 1), winch: make(chan os.Signal, 1), done: make(chan ending, 1)}
	r.a = newAttacher(cfg, c, tty, tty, tty.size, func() { r.restores.Add(1) })
	go func() { r.done <- r.a.run(r.stop, r.winch) }()
	t.Cleanup(func() {
		// An attachment the test left running ends with its terminal.
		tty.close()
		if !r.ended {
			select {
			case <-r.done:
			case <-time.After(attachTimeout):
				t.Error("attach did not end after its terminal closed")
			}
		}
	})
	return r
}

// wait returns how the attachment ended, checking that the terminal mode
// was restored exactly once.
func (r *attachRun) wait() ending {
	r.t.Helper()
	var e ending
	select {
	case e = <-r.done:
		r.ended = true
	case <-time.After(attachTimeout):
		r.t.Fatalf("attach did not end; output %q", r.tty.output())
	}
	if n := r.restores.Load(); n != 1 {
		r.t.Errorf("terminal mode restored %d times, want once", n)
	}
	return e
}

func wantEnding(t *testing.T, got, want ending) {
	t.Helper()
	if got.msg != want.msg || got.failed != want.failed {
		t.Errorf("ended with %q (failed %v), want %q (failed %v)", got.msg, got.failed, want.msg, want.failed)
	}
}
