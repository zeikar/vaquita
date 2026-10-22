package session

import (
	"bytes"
	"errors"
	"log"
	"log/slog"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/status"
	"golang.org/x/sys/unix"
)

const testTimeout = 10 * time.Second

type exitResult struct {
	code int
	ring string // the whole ring as OnExit saw it
}

// testSession runs a command under /bin/sh with a fresh HOME, so neither
// the user's rc files nor zsh's CHECK_JOBS affect the outcome.
type testSession struct {
	*Session
	output     chan struct{} // wakes waitOutput; cap 1
	exit       chan exitResult
	goroutines int // before Start
	// atExit, when set, runs inside OnExit before the result is sent.
	atExit atomic.Pointer[func()]
}

// startSession starts cmd as session 1 at 80x24, calling onOutput (if not
// nil) after each read.
func startSession(t *testing.T, cmd string, onOutput func()) *testSession {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	ts := &testSession{
		output:     make(chan struct{}, 1),
		exit:       make(chan exitResult, 1),
		goroutines: runtime.NumGoroutine(),
	}
	// OnExit may only touch the session once Start has returned it.
	ready := make(chan *Session, 1)
	s, err := Start(Config{
		SID:   1,
		Shell: "/bin/sh",
		Cmd:   cmd,
		Cols:  80,
		Rows:  24,
		OnOutput: func() {
			select {
			case ts.output <- struct{}{}:
			default:
			}
			if onOutput != nil {
				onOutput()
			}
		},
		OnExit: func(code int) {
			s := <-ready
			if f := ts.atExit.Load(); f != nil {
				(*f)()
			}
			ts.exit <- exitResult{code: code, ring: ringText(s)}
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	ready <- s
	ts.Session = s
	t.Cleanup(func() {
		// Whatever the session started must not outlive the test, whether the
		// test failed or it left a child running on purpose.
		pids, _, err := SessionPIDs(s.PID())
		if err != nil {
			t.Errorf("scan for leftover processes: %v", err)
		}
		for _, pid := range pids {
			if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
				t.Errorf("kill session member %d: %v", pid, err)
			}
		}
		s.Lock()
		exited, _ := s.State()
		s.Unlock()
		// The test failed while the shell was still running. ESRCH means it
		// exited after all and has been reaped.
		if !exited {
			if err := syscall.Kill(s.PID(), syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
				t.Errorf("kill shell %d: %v", s.PID(), err)
			}
		}
		select {
		case <-s.done:
			// Later tests count goroutines from a clean baseline.
			ts.waitGoroutines(t)
		case <-time.After(testTimeout):
			t.Errorf("session %d never closed", s.PID())
		}
	})
	return ts
}

// tail bounds the output a failure message shows.
func tail(s string) string {
	const n = 512
	if len(s) > n {
		return "..." + s[len(s)-n:]
	}
	return s
}

func ringText(s *Session) string {
	s.Lock()
	defer s.Unlock()
	r := s.Output().Ring()
	return string(r.CopyRange(r.Start(), r.End(), nil))
}

func (ts *testSession) waitExit(t *testing.T) exitResult {
	t.Helper()
	select {
	case r := <-ts.exit:
		return r
	case <-time.After(testTimeout):
		t.Fatalf("no exit within %v; output ends %q", testTimeout, tail(ringText(ts.Session)))
		return exitResult{}
	}
}

// waitOutput returns once the ring contains want.
func (ts *testSession) waitOutput(t *testing.T, want string) {
	t.Helper()
	deadline := time.After(testTimeout)
	for !strings.Contains(ringText(ts.Session), want) {
		select {
		case <-ts.output:
		case <-deadline:
			t.Fatalf("output never contained %q; it ends %q", want, tail(ringText(ts.Session)))
		}
	}
}

func (ts *testSession) write(t *testing.T, p string) {
	t.Helper()
	if err := ts.Write([]byte(p)); err != nil {
		t.Fatalf("Write(%q): %v", p, err)
	}
}

// waitClosed waits for the master to be closed and the session's goroutines
// to end.
func (ts *testSession) waitClosed(t *testing.T) {
	t.Helper()
	select {
	case <-ts.done:
	case <-time.After(testTimeout):
		t.Fatal("master never closed")
	}
	ts.waitGoroutines(t)
}

func (ts *testSession) waitGoroutines(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > ts.goroutines {
		if time.Now().After(deadline) {
			t.Errorf("%d goroutines remain, %d before Start", runtime.NumGoroutine(), ts.goroutines)
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestSessionExitAfterOutput(t *testing.T) {
	ts := startSession(t, "printf hi; exit 3", nil)
	r := ts.waitExit(t)
	if r.code != 3 {
		t.Errorf("exit code %d, want 3", r.code)
	}
	if !strings.Contains(r.ring, "hi") {
		t.Errorf("ring at exit %q lacks the output", tail(r.ring))
	}
	if err := ts.Write([]byte("x")); !errors.Is(err, ErrClosed) {
		t.Errorf("Write after the shell exited: %v, want ErrClosed", err)
	}
	ts.Lock()
	exited, code := ts.State()
	orphans, err := ts.Orphans()
	ts.Unlock()
	if !exited || code != 3 || orphans != nil || err != nil {
		t.Errorf("State() = %v, %d, Orphans() = %v, %v; want true, 3, nil, nil", exited, code, orphans, err)
	}

	ts.waitClosed(t)
	if err := ts.Resize(100, 30); !errors.Is(err, ErrClosed) {
		t.Errorf("Resize after close: %v, want ErrClosed", err)
	}
}

// Output far beyond what the tty queues must all be in the ring at OnExit.
func TestSessionExitWaitsForDrain(t *testing.T) {
	ts := startSession(t, `head -c 300000 /dev/zero | tr '\0' x; exit 3`, nil)
	r := ts.waitExit(t)
	if r.code != 3 {
		t.Errorf("exit code %d, want 3", r.code)
	}
	if n := strings.Count(r.ring, "x"); n < 300000 || !strings.Contains(r.ring, strings.Repeat("x", 300000)) {
		t.Errorf("ring at exit holds %d x, want a run of 300000", n)
	}
}

func TestSessionInput(t *testing.T) {
	ts := startSession(t, "read l; printf got:$l; exit 0", nil)
	ts.write(t, "abc\n")
	if r := ts.waitExit(t); !strings.Contains(r.ring, "got:abc") {
		t.Errorf("ring %q lacks the echoed input", tail(r.ring))
	}
}

func TestSessionResize(t *testing.T) {
	ts := startSession(t, "stty size; read l; stty size; exit 0", nil)
	ts.waitOutput(t, "24 80")
	if err := ts.Resize(100, 30); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	ts.Lock()
	cols, rows := ts.Size()
	ts.Unlock()
	if cols != 100 || rows != 30 {
		t.Errorf("Size() = %d, %d, want 100, 30", cols, rows)
	}
	ts.write(t, "\n")
	if r := ts.waitExit(t); !strings.Contains(r.ring, "30 100") {
		t.Errorf("ring %q lacks the new size", tail(r.ring))
	}
}

func TestSessionEnv(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	// Only the checked variables are printed: the rest of an environment
	// that leaked through may hold secrets.
	ts := startSession(t, `printf '%s|%s|%s|%s' "$TERM_PROGRAM" "$VAQUITA_SESSION_ID" "${CLAUDECODE-unset}" "$SHELL"; exit 0`, nil)
	const want = "vaquita|1|unset|/bin/sh"
	if r := ts.waitExit(t); !strings.Contains(r.ring, want) {
		t.Errorf("ring %q lacks %q", tail(r.ring), want)
	}
}

func TestSessionControllingTerminal(t *testing.T) {
	// Opening /dev/tty only works with a controlling terminal.
	ts := startSession(t, "read l; : </dev/tty && printf ctty-ok; exit 0", nil)
	pid := ts.PID()
	if sid, err := unix.Getsid(pid); err != nil || sid != pid {
		t.Errorf("Getsid(%d) = %d, %v; want the shell to lead its own session", pid, sid, err)
	}
	ts.write(t, "\n")
	if r := ts.waitExit(t); !strings.Contains(r.ring, "ctty-ok") {
		t.Errorf("no controlling terminal: %q", tail(r.ring))
	}
}

func TestSessionCwd(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := Start(Config{SID: 1, Shell: "/bin/sh", Cwd: "/nonexistent/vaquita-test", Cols: 80, Rows: 24})
	if err == nil || !strings.Contains(err.Error(), "cwd") {
		t.Fatalf("Start with a missing cwd: %v, want an error about the cwd", err)
	}
}

// The tty stops taking input the shell never reads, so the queue fills and
// Write must fail rather than block; the stuck input writer must still end
// with the session.
func TestSessionInputOverflow(t *testing.T) {
	ts := startSession(t, "sleep 37; exit 0", nil)
	ts.write(t, strings.Repeat("a\n", maxPendingInput/2))
	if err := ts.Write([]byte("b")); !errors.Is(err, ErrInputOverflow) {
		t.Fatalf("Write past the bound: %v, want ErrInputOverflow", err)
	}
	if err := syscall.Kill(ts.PID(), syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	if r := ts.waitExit(t); r.code != 128+int(syscall.SIGKILL) {
		t.Errorf("exit code %d, want %d", r.code, 128+int(syscall.SIGKILL))
	}
	ts.waitClosed(t)
}

// A program killed in its own process group, as claude runs under the
// session's shell, ends neither the session nor its working view by itself;
// the poll of the foreground group it reported from clears the view. The
// child waits before reporting so that the shell has made it the foreground
// group by then.
func TestForegroundGroupDeathClearsView(t *testing.T) {
	ts := startSession(t, `set -m; sh -c 'sleep 0.2; printf "\033]7501;state=working:app=x\007"; exec sleep 60'; read l; printf "after:%s" "$l"`, nil)
	deadline := time.After(testTimeout)
	for {
		ts.Lock()
		v, _ := ts.out.View()
		reporter := ts.out.reporter
		fg, fgErr := ts.out.Foreground()
		ts.Unlock()
		if v.State == status.ViewWorking {
			// The job still runs, so it is still the foreground group.
			if reporter <= 1 || reporter == ts.PID() || reporter != fg || fgErr != nil {
				t.Fatalf("reporter %d, foreground %d (%v), shell %d; want the job's own group", reporter, fg, fgErr, ts.PID())
			}
			// Only a group in this test's PTY session is ever signalled.
			if sid, err := unix.Getsid(reporter); err != nil || sid != ts.PID() {
				t.Fatalf("Getsid(%d) = %d, %v; want %d", reporter, sid, err, ts.PID())
			}
			if err := unix.Kill(-reporter, unix.SIGKILL); err != nil {
				t.Fatalf("kill job group %d: %v", reporter, err)
			}
			break
		}
		select {
		case <-ts.output:
		case <-deadline:
			t.Fatalf("view never turned working; output ends %q", tail(ringText(ts.Session)))
		}
	}

	// The shell reaps the job some time after the kill; until then the group
	// is still there.
	stop := time.Now().Add(testTimeout)
	for {
		ts.Lock()
		v, _ := ts.out.View()
		d, ok := ts.out.NextDeadline(ts.out.Now())
		if v == (status.View{}) {
			ts.Unlock()
			break
		}
		if !ok {
			ts.Unlock()
			t.Fatalf("no poll scheduled for view %+v", v)
		}
		ts.out.Tick(d)
		ts.Unlock()
		if time.Now().After(stop) {
			t.Fatalf("view %+v outlived the reporter's group", v)
		}
		time.Sleep(10 * time.Millisecond)
	}

	ts.Lock()
	exited, _ := ts.State()
	ts.Unlock()
	if exited {
		t.Fatal("the session exited with the job")
	}
	ts.write(t, "x\n")
	ts.waitOutput(t, "after:x")
}

// panicOnce panics the first time it sees OSC 4242, standing in for a
// parser bug.
type panicOnce struct {
	Sink
	hit chan struct{}
}

func (p *panicOnce) OSC(num int, payload []byte, oversized bool) {
	if num == 4242 && p.hit != nil {
		close(p.hit)
		p.hit = nil
		panic("test: sink panic")
	}
	p.Sink.OSC(num, payload, oversized)
}

// syncBuffer is a bytes.Buffer safe for the reader goroutine to log into.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureLogs sends the default slog logger's output to the returned buffer
// until the test ends.
func captureLogs(t *testing.T) *syncBuffer {
	logs := new(syncBuffer)
	prev, prevOut, prevFlags := slog.Default(), log.Writer(), log.Flags()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	// Restoring slog's default handler leaves the log package writing to
	// ours, so log is restored too.
	t.Cleanup(func() {
		slog.SetDefault(prev)
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	})
	return logs
}

func TestSessionRecoversScannerPanic(t *testing.T) {
	logs := captureLogs(t)
	ts := startSession(t, `read l; printf '\033]4242;x\007'; read l; printf after:$l; exit 0`, nil)
	hit := make(chan struct{})
	ts.Lock()
	sink := &panicOnce{Sink: ts.out.live.sink, hit: hit}
	panicking := NewScanner(sink)
	ts.out.live = panicking
	ts.Unlock()

	ts.write(t, "1\n")
	select {
	case <-hit:
	case <-time.After(testTimeout):
		t.Fatal("the sink never saw the OSC")
	}
	ts.write(t, "2\n")
	r := ts.waitExit(t)
	if !strings.Contains(r.ring, "after:2") {
		t.Errorf("output after the panic is missing: %q", tail(r.ring))
	}
	ts.Lock()
	replaced := ts.out.live != panicking
	ts.Unlock()
	if !replaced {
		t.Error("the scanner was not replaced after the panic")
	}
	if !strings.Contains(logs.String(), "test: sink panic") {
		t.Errorf("panic not logged: %q", tail(logs.String()))
	}
}

// Nothing reading the master would keep the shell from exiting, so a
// panicking OnOutput must not end the reader.
func TestSessionRecoversOnOutputPanic(t *testing.T) {
	logs := captureLogs(t)
	hit := make(chan struct{})
	var once sync.Once
	ts := startSession(t, "printf before; read l; printf after:$l; exit 0", func() {
		once.Do(func() {
			close(hit)
			panic("test: OnOutput panic")
		})
	})
	select {
	case <-hit:
	case <-time.After(testTimeout):
		t.Fatal("OnOutput was never called")
	}
	ts.write(t, "x\n")
	if r := ts.waitExit(t); !strings.Contains(r.ring, "after:x") {
		t.Errorf("output after the panic is missing: %q", tail(r.ring))
	}
	if !strings.Contains(logs.String(), "test: OnOutput panic") {
		t.Errorf("panic not logged: %q", tail(logs.String()))
	}
}
