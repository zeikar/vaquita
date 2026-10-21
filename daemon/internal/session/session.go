// Package session runs shells on PTYs; like the rest of vaquitad it is macOS-only.
package session

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

const (
	readBufSize = 64 << 10
	// maxPendingInput bounds input accepted but not yet written to the PTY,
	// which piles up while the program in the session is not reading.
	maxPendingInput = 4 << 20
	// drainTimeout caps how long an exit waits for the reader to reach EOF.
	// On macOS the master sees EOF right after the session leader exits, so
	// this is only a safety net.
	drainTimeout = 2 * time.Second
)

var (
	// ErrInputOverflow rejects input while the program in the session is
	// not reading what was already queued.
	ErrInputOverflow = errors.New("session: input queue full")
	// ErrClosed rejects Write once the shell has exited and Resize once the
	// master is closed.
	ErrClosed = errors.New("session: closed")
)

// scanSession lists the processes still in the PTY session whose leader has
// pid sid, and killProcedure ends them all. They are variables so that tests
// can observe the exit path.
var (
	scanSession   = SessionPIDs
	killProcedure = killSession
)

// Config describes a session to start.
type Config struct {
	// SID is the daemon's id for the session, exported to the shell as
	// VAQUITA_SESSION_ID.
	SID   int
	Shell string // path of the shell, run as a login and interactive shell
	Cwd   string // working directory; empty means the user's home
	Cmd   string // run by the shell before it turns interactive; may be empty
	Name  string // label for clients; Start does not use it
	Cols  int
	Rows  int

	// OnOutput is called after each read from the PTY is in the ring. It
	// must not block: the reader never waits on consumers.
	OnOutput func()
	// OnExit is called once with the shell's exit status, or 128 plus the
	// signal number if a signal killed it. By then the reader has reached EOF
	// (or drainTimeout has passed), so all output is in the ring; a kill
	// started by Kill has finished; State reports the exit, Orphans what is
	// left of the PTY session, and the master is still open.
	OnExit func(code int)
}

// Session is a shell running on its own PTY, in a POSIX session of its own
// whose id is the shell's pid.
//
// The session lock (Lock/Unlock) guards Output, State, Size and Orphans;
// callers hold it while using them. Appending output to the ring happens
// under it as well, so a consumer that reads the ring and records how far it
// got under the lock never misses an append. OnOutput and OnExit are called
// without the lock held and may take it. Resize and Kill take the lock
// themselves, so they must not be called with the lock held; Write never
// touches it.
type Session struct {
	pid      int
	started  time.Time
	cmd      *exec.Cmd
	master   *os.File
	onOutput func()
	onExit   func(code int)

	readerDone chan struct{}
	done       chan struct{} // closed once the master is closed

	mu         sync.Mutex
	out        *Output
	cols, rows int
	exited     bool
	code       int
	orphans    []int
	orphansErr error // the scan for orphans failed
	// killDone is closed when an in-progress kill has finished; nil when
	// none was started.
	killDone chan struct{}
	closed   bool // the master is closed

	inMu      sync.Mutex
	inBuf     []byte
	inPending int // bytes accepted by Write and not yet written to the PTY
	inClosed  bool
	inWake    chan struct{} // cap 1
}

// Start runs cfg.Shell on a new PTY of cfg.Cols x cfg.Rows. With a Cmd the
// shell runs it first and then replaces itself with an interactive shell,
// so the session outlives the command.
func Start(cfg Config) (*Session, error) {
	ws, err := winsize(cfg.Cols, cfg.Rows)
	if err != nil {
		return nil, err
	}
	cwd := cfg.Cwd
	if cwd == "" {
		if cwd, err = os.UserHomeDir(); err != nil {
			return nil, fmt.Errorf("session cwd: %w", err)
		}
	}
	// Checked here because a failed chdir in the child surfaces as an error
	// about executing the shell.
	if fi, err := os.Stat(cwd); err != nil {
		return nil, fmt.Errorf("session cwd: %w", err)
	} else if !fi.IsDir() {
		return nil, fmt.Errorf("session cwd %s: not a directory", cwd)
	}

	args := []string{"-l", "-i"}
	if cfg.Cmd != "" {
		// A newline rather than ';' still runs the exec after a command that
		// ends in '&' or a comment.
		args = append(args, "-c", cfg.Cmd+"\nexec "+shellQuote(cfg.Shell)+" -l -i")
	}
	cmd := exec.Command(cfg.Shell, args...)
	cmd.Dir = cwd
	cmd.Env = ChildEnv(cfg.SID, cfg.Shell)

	master, slave, err := pty.Open()
	if err != nil {
		return nil, fmt.Errorf("open pty: %w", err)
	}
	// The child holds its own copies; the parent's would keep the slave open.
	defer func() {
		if err := slave.Close(); err != nil {
			slog.Warn("session: close pty slave", "err", err)
		}
	}()
	if err := pty.Setsize(master, ws); err != nil {
		master.Close()
		return nil, fmt.Errorf("set pty size: %w", err)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	// Ctty is a descriptor number in the child, where the slave is fd 0.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		master.Close()
		return nil, fmt.Errorf("start %s: %w", cfg.Shell, err)
	}

	s := &Session{
		pid:        cmd.Process.Pid,
		started:    time.Now(),
		cmd:        cmd,
		master:     master,
		onOutput:   cfg.OnOutput,
		onExit:     cfg.OnExit,
		readerDone: make(chan struct{}),
		done:       make(chan struct{}),
		out:        NewOutput(),
		cols:       cfg.Cols,
		rows:       cfg.Rows,
		inWake:     make(chan struct{}, 1),
	}
	name := "session " + strconv.Itoa(s.pid)
	Go(name+" reader", s.readLoop)
	Go(name+" input", s.writeLoop)
	Go(name+" exit", s.waitExit)
	return s, nil
}

func (s *Session) Lock()   { s.mu.Lock() }
func (s *Session) Unlock() { s.mu.Unlock() }

// PID is the shell's pid, which is also the id of its POSIX session.
func (s *Session) PID() int { return s.pid }

// Started is when the shell was started.
func (s *Session) Started() time.Time { return s.started }

// Output is the session's output path. It requires the session lock.
func (s *Session) Output() *Output { return s.out }

// State reports whether the shell has exited and its exit code. It requires
// the session lock.
func (s *Session) State() (exited bool, code int) { return s.exited, s.code }

// Size is the PTY size in cells. It requires the session lock.
func (s *Session) Size() (cols, rows int) { return s.cols, s.rows }

// Orphans lists the processes found still in the PTY session after the shell
// exited and any kill had finished. It requires the session lock and is nil
// before the exit. An error means the scan failed and the session may still
// have members: a caller must then treat it as having orphans and keep its
// record rather than remove it.
func (s *Session) Orphans() ([]int, error) { return s.orphans, s.orphansErr }

// Kill ends every process in the shell's PTY session, as killSession
// describes, without blocking the caller. The exit is reported only after the
// kill has finished, so Orphans then lists what survived it. Once the exit
// has been reported Kill does nothing: the pids in Orphans are never
// signalled, as they may have been reused by then.
func (s *Session) Kill() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.exited || s.killDone != nil {
		return
	}
	done := make(chan struct{})
	s.killDone = done
	Go("session "+strconv.Itoa(s.pid)+" kill", func() {
		defer close(done)
		if survivors := killProcedure(s.pid); len(survivors) > 0 {
			slog.Warn("session: processes survived the kill", "pid", s.pid, "survivors", survivors)
		}
	})
}

// Write queues p as input to the PTY and never blocks: a program that stops
// reading must not stall the caller. It fails with ErrInputOverflow when the
// queue would exceed its bound and with ErrClosed once the shell has exited.
func (s *Session) Write(p []byte) error {
	s.inMu.Lock()
	defer s.inMu.Unlock()
	if s.inClosed {
		return ErrClosed
	}
	if s.inPending+len(p) > maxPendingInput {
		return ErrInputOverflow
	}
	s.inBuf = append(s.inBuf, p...)
	s.inPending += len(p)
	select {
	case s.inWake <- struct{}{}:
	default:
	}
	return nil
}

// Resize sets the PTY size, which signals SIGWINCH to the foreground job.
func (s *Session) Resize(cols, rows int) error {
	ws, err := winsize(cols, rows)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// pty.Setsize uses the raw descriptor, which a closed master may have
	// handed on to an unrelated file.
	if s.closed {
		return ErrClosed
	}
	if err := pty.Setsize(s.master, ws); err != nil {
		return fmt.Errorf("resize pty: %w", err)
	}
	s.cols, s.rows = cols, rows
	return nil
}

func winsize(cols, rows int) (*pty.Winsize, error) {
	if cols < 1 || rows < 1 || cols > 0xffff || rows > 0xffff {
		return nil, fmt.Errorf("session: invalid size %dx%d", cols, rows)
	}
	return &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}, nil
}

// readLoop moves PTY output into the ring until EOF. It never waits on
// consumers, so a slow one cannot stall the program in the session.
func (s *Session) readLoop() {
	defer close(s.readerDone)
	buf := make([]byte, readBufSize)
	for {
		n, err := s.master.Read(buf)
		if n > 0 {
			s.feed(buf[:n])
			s.notifyOutput()
		}
		if err != nil {
			// The master reports EOF or EIO once the tty is gone.
			if !errors.Is(err, io.EOF) && !errors.Is(err, syscall.EIO) {
				slog.Warn("session: read pty", "pid", s.pid, "err", err)
			}
			return
		}
	}
}

// feed appends p to the output. A panic while scanning it is recovered here
// so the reader keeps going; p itself is lost, and the scanner, possibly
// left halfway through an update, is replaced.
func (s *Session) feed(p []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Deferred after the Unlock so that it runs before it, with the lock
	// still held.
	defer func() {
		if r := recover(); r != nil {
			slog.Error("session: output scanner panicked; replacing it", "pid", s.pid, "panic", r, "stack", string(debug.Stack()))
			s.out.ReplaceScanner()
		}
	}()
	s.out.Feed(p)
}

// notifyOutput calls OnOutput, recovering a panic in it: the reader must keep
// going, as the shell cannot even exit while its output goes unread.
func (s *Session) notifyOutput() {
	if s.onOutput == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("session: OnOutput panicked", "pid", s.pid, "panic", r, "stack", string(debug.Stack()))
		}
	}()
	s.onOutput()
}

// writeLoop writes queued input to the PTY until the session is closed.
func (s *Session) writeLoop() {
	for {
		select {
		case <-s.inWake:
		case <-s.done:
			return
		}
		s.inMu.Lock()
		p := s.inBuf
		s.inBuf = nil
		s.inMu.Unlock()
		if len(p) == 0 {
			continue
		}
		// Blocks while the tty's input queue is full; ends with EIO once the
		// shell is gone.
		_, err := s.master.Write(p)
		s.inMu.Lock()
		s.inPending -= len(p)
		s.inMu.Unlock()
		if err != nil {
			slog.Warn("session: input dropped", "pid", s.pid, "bytes", len(p), "err", err)
		}
	}
}

// waitExit reports the shell's exit once everything it wrote is in the ring,
// then closes the master.
func (s *Session) waitExit() {
	// Deferred so that the master is closed and the input writer released
	// even if OnExit panics.
	defer s.shutdown()
	err := s.cmd.Wait()
	// Input from here on would only be dropped by the writer.
	s.closeInput()
	code := -1
	if ps := s.cmd.ProcessState; ps != nil {
		code = exitCode(ps)
	} else {
		slog.Error("session: wait for shell", "pid", s.pid, "err", err)
	}

	// The kernel holds the shell's exit until its output has been read from
	// the master, but the last read may still be on its way into the ring.
	select {
	case <-s.readerDone:
	case <-time.After(drainTimeout):
		slog.Warn("session: output not drained; reporting exit anyway", "pid", s.pid)
	}
	// A kill under way may still be SIGKILLing what the shell left behind,
	// so the exit waits for it and scans after it. Kill decides under the
	// lock whether the exit is reported yet, so a kill that started during
	// the scan shows up in the re-check and is waited for in turn.
	s.mu.Lock()
	for {
		killDone := s.killDone
		s.mu.Unlock()
		if killDone != nil {
			<-killDone
		}
		orphans, _, err := scanSession(s.pid)
		if err != nil {
			slog.Error("session: scan for orphans", "pid", s.pid, "err", err)
		}
		s.mu.Lock()
		if s.killDone == killDone {
			s.exited, s.code, s.orphans, s.orphansErr = true, code, orphans, err
			break
		}
	}
	s.mu.Unlock()
	if s.onExit != nil {
		s.onExit(code)
	}
}

func (s *Session) closeInput() {
	s.inMu.Lock()
	s.inClosed = true
	s.inBuf = nil
	s.inMu.Unlock()
}

func (s *Session) shutdown() {
	s.mu.Lock()
	s.closed = true
	err := s.master.Close()
	s.mu.Unlock()
	if err != nil {
		slog.Warn("session: close pty master", "pid", s.pid, "err", err)
	}
	close(s.done)
}

// exitCode maps a death by signal to 128 plus the signal number, as shells
// report it.
func exitCode(ps *os.ProcessState) int {
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return ps.ExitCode()
}

// shellQuote quotes s as a single POSIX shell word.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
