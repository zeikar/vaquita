package session

import (
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zeikar/vaquita/daemon/internal/convid"
)

// waitGroups polls until the PTY session sid has processes in at least n
// process groups, and returns them.
func waitGroups(t *testing.T, sid, n int) []proc {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for {
		procs, err := sessionProcs(sid)
		if err != nil {
			t.Fatal(err)
		}
		groups := make(map[int]bool)
		for _, p := range procs {
			groups[p.pgid] = true
		}
		if len(groups) >= n {
			return procs
		}
		if time.Now().After(deadline) {
			t.Fatalf("session %d has %v, want processes in %d groups", sid, procs, n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestKillHUPIgnoringSession(t *testing.T) {
	// The shell ignores HUP as well, so only the SIGKILL ends either.
	ts := startSession(t, "trap '' HUP; sleep 60", nil)
	procs := waitGroups(t, ts.PID(), 2)
	if len(procs) < 2 {
		t.Fatalf("sessionProcs = %v, want the shell and sleep", procs)
	}
	members := pidsOf(procs)
	// Checked inside OnExit: by then every member must already be gone.
	var aliveAtExit []int
	f := func() {
		for _, pid := range members {
			if err := unix.Kill(pid, 0); !errors.Is(err, unix.ESRCH) {
				aliveAtExit = append(aliveAtExit, pid)
			}
		}
	}
	ts.atExit.Store(&f)

	start := time.Now()
	ts.Kill()
	if d := time.Since(start); d > time.Second {
		t.Errorf("Kill blocked for %v", d)
	}
	r := ts.waitExit(t)
	if d := time.Since(start); d < hupGrace || d > 6*time.Second {
		t.Errorf("exit reported %v after Kill, want between %v and 6s", d, hupGrace)
	}
	if r.code != 128+int(unix.SIGKILL) {
		t.Errorf("exit code %d, want %d", r.code, 128+int(unix.SIGKILL))
	}
	if len(aliveAtExit) > 0 {
		t.Errorf("members %v of %v still existed at OnExit", aliveAtExit, members)
	}
	ts.Lock()
	orphans, err := ts.Orphans()
	ts.Unlock()
	if len(orphans) != 0 || err != nil {
		t.Errorf("Orphans() = %v, %v; want none", orphans, err)
	}
	ts.waitClosed(t)
}

// Members that honour HUP end the kill without the SIGKILL stage.
func TestKillSessionHUPSuffices(t *testing.T) {
	ts := startSession(t, "sleep 60", nil)
	waitGroups(t, ts.PID(), 2)
	start := time.Now()
	ts.Kill()
	ts.waitExit(t)
	if d := time.Since(start); d >= 2*time.Second {
		t.Errorf("exit reported %v after Kill, want under 2s", d)
	}
	ts.Lock()
	orphans, err := ts.Orphans()
	ts.Unlock()
	if len(orphans) != 0 || err != nil {
		t.Errorf("Orphans() = %v, %v; want none", orphans, err)
	}
	ts.waitClosed(t)
}

// A child that ignores HUP outlives its leader and the tty; the sid scan
// must still find it, and the exit must report it as an orphan.
func TestProcOrphanOutlivesLeader(t *testing.T) {
	// HUP is ignored before the fork, so the child inherits it.
	ts := startSession(t, "trap '' HUP; sleep 60 & exit 0", nil)
	ts.waitExit(t)
	pid := ts.PID()
	if err := unix.Kill(pid, 0); !errors.Is(err, unix.ESRCH) {
		t.Errorf("kill(%d, 0) = %v after the exit, want ESRCH", pid, err)
	}
	procs, err := sessionProcs(pid)
	if err != nil || len(procs) != 1 {
		t.Fatalf("sessionProcs(%d) = %v, %v; want just the sleep", pid, procs, err)
	}
	child := procs[0].pid
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", child)
	if err != nil {
		t.Fatal(err)
	}
	if kp.Eproc.Ppid != 1 {
		t.Errorf("ppid of %d is %d, want 1", child, kp.Eproc.Ppid)
	}
	ts.Lock()
	orphans, err := ts.Orphans()
	ts.Unlock()
	if !slices.Equal(orphans, []int{child}) || err != nil {
		t.Errorf("Orphans() = %v, %v; want [%d]", orphans, err, child)
	}

	// The pid may belong to anything by the time someone asks for a kill.
	ts.Kill()
	ts.Lock()
	killed := ts.killDone != nil
	ts.Unlock()
	if killed {
		t.Error("Kill after the exit started a kill")
	}
	ts.waitClosed(t)
}

func TestProcWaitGone(t *testing.T) {
	cmd := exec.Command("sleep", "60")
	// In a session of its own, as a shell is.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})
	pid := cmd.Process.Pid

	const d = 300 * time.Millisecond
	start := time.Now()
	if got := waitGone(pid, []int{pid}, d); !slices.Equal(got, []int{pid}) {
		t.Errorf("waitGone with a live pid = %v, want [%d]", got, pid)
	}
	if elapsed := time.Since(start); elapsed < d {
		t.Errorf("waitGone returned after %v, before its %v deadline", elapsed, d)
	}

	// Not reaped until the cleanup, so it lingers as a zombie, which
	// kill(pid, 0) would still find.
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	if got := waitGone(pid, []int{pid}, d); got != nil {
		t.Errorf("waitGone with a zombie = %v, want none", got)
	}
	if elapsed := time.Since(start); elapsed >= d {
		t.Errorf("waitGone took %v for a pid that is gone", elapsed)
	}
	if err := unix.Kill(pid, 0); err != nil {
		t.Errorf("kill(%d, 0) = %v, want the zombie still found", pid, err)
	}
}

// With the process list unavailable, Kill still reaches the shell's own
// process group, and the exit reports that its orphans are unknown.
func TestKillScanFails(t *testing.T) {
	ts := startSession(t, "sleep 60", nil)
	waitGroups(t, ts.PID(), 2)
	errList := errors.New("test: no process list")
	prev := listProcs
	listProcs = func() ([]unix.KinfoProc, error) { return nil, errList }
	// Registered after startSession so the real list is back for its cleanup.
	t.Cleanup(func() { listProcs = prev })

	start := time.Now()
	ts.Kill()
	ts.waitExit(t)
	if d := time.Since(start); d >= 2*time.Second {
		t.Errorf("exit reported %v after Kill, want under 2s", d)
	}
	ts.Lock()
	orphans, err := ts.Orphans()
	ts.Unlock()
	if orphans != nil || !errors.Is(err, errList) {
		t.Errorf("Orphans() = %v, %v; want no list and the scan error", orphans, err)
	}
	ts.waitClosed(t)
}

// observeKill makes killProcedure, for the rest of the test, linger after the
// real kill before counting it as finished, so an exit reported before the
// kill ended would be seen. Call it before startSession, so that it is
// restored only after the session has closed.
func observeKill(t *testing.T) (finished *atomic.Int32) {
	finished = new(atomic.Int32)
	prev := killProcedure
	killProcedure = func(sid int) []int {
		survivors := killSession(sid)
		time.Sleep(100 * time.Millisecond)
		finished.Add(1)
		return survivors
	}
	t.Cleanup(func() { killProcedure = prev })
	return finished
}

// checkExitAfterKill makes OnExit verify that a kill started on ts, if any,
// had finished, and returns the number of OnExit calls.
func checkExitAfterKill(t *testing.T, ts *testSession, finished *atomic.Int32) (exits *atomic.Int32) {
	exits = new(atomic.Int32)
	f := func() {
		exits.Add(1)
		ts.Lock()
		killed := ts.killDone != nil
		ts.Unlock()
		if killed && finished.Load() != 1 {
			t.Error("exit reported while the kill was still running")
		}
	}
	ts.atExit.Store(&f)
	return exits
}

func TestKillRacesExit(t *testing.T) {
	// Kill arrives after the exit path has looked for a kill in progress but
	// before it has marked the session exited.
	t.Run("during exit scan", func(t *testing.T) {
		finished := observeKill(t)
		var target atomic.Pointer[Session]
		prevScan := scanSession
		scanSession = func(sid int) ([]int, time.Time, error) {
			if s := target.Load(); s != nil {
				s.Kill()
			}
			return SessionPIDs(sid)
		}
		t.Cleanup(func() { scanSession = prevScan })

		ts := startSession(t, "read l; exit 0", nil)
		exits := checkExitAfterKill(t, ts, finished)
		target.Store(ts.Session)
		ts.write(t, "\n")
		ts.waitExit(t)
		ts.waitClosed(t)
		if finished.Load() != 1 {
			t.Errorf("kill procedure finished %d times, want 1", finished.Load())
		}
		if n := exits.Load(); n != 1 {
			t.Errorf("OnExit called %d times, want 1", n)
		}
	})

	// Kill lands at assorted points around a natural exit.
	for i := range 20 {
		t.Run(fmt.Sprint("delay ", i), func(t *testing.T) {
			finished := observeKill(t)
			ts := startSession(t, "printf ready; read l; exit 0", nil)
			exits := checkExitAfterKill(t, ts, finished)
			ts.waitOutput(t, "ready")
			ts.write(t, "\n")
			time.Sleep(time.Duration(i) * 100 * time.Microsecond)
			ts.Kill()
			ts.waitExit(t)
			ts.waitClosed(t)
			if n := finished.Load(); n > 1 {
				t.Errorf("kill procedure finished %d times, want at most 1", n)
			}
			if n := exits.Load(); n != 1 {
				t.Errorf("OnExit called %d times, want 1", n)
			}
		})
	}
}

func TestMembers(t *testing.T) {
	cmd := exec.Command("/bin/sleep", "60")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cmd.Process.Kill()
		cmd.Wait()
	}()
	pid := cmd.Process.Pid
	var ms []convid.Member
	deadline := time.Now().Add(testTimeout)
	for len(ms) == 0 && time.Now().Before(deadline) {
		var err error
		if ms, err = Members(pid); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(ms) != 1 || ms[0].PID != pid || ms[0].PGID != pid {
		t.Fatalf("Members = %+v, want only pid %d leading its group", ms, pid)
	}
	if d := time.Since(ms[0].Start); d < -5*time.Second || d > 5*time.Second {
		t.Fatalf("Start %v is %v from now", ms[0].Start, d)
	}
	if ms, err := Members(1); err != nil || ms != nil {
		t.Fatalf("Members(1) = %v, %v", ms, err)
	}
}

// Claude Code leaves caffeinate running for up to five minutes after it
// exits. It holds nothing a reopened session would need, so it is no orphan.
func TestOrphansLeaveOutCaffeinate(t *testing.T) {
	ts := startSession(t, "trap '' HUP; sleep 60 & /usr/bin/caffeinate -i -t 60 & exit 0", nil)
	ts.waitExit(t)
	pid := ts.PID()
	var procs []proc
	deadline := time.Now().Add(testTimeout)
	for len(procs) < 2 && time.Now().Before(deadline) {
		var err error
		if procs, err = sessionProcs(pid); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Cleanup(func() {
		for _, p := range procs {
			unix.Kill(p.pid, unix.SIGKILL)
		}
	})
	if len(procs) != 2 {
		t.Fatalf("sessionProcs(%d) = %v, want the sleep and caffeinate", pid, procs)
	}
	var sleep int
	for _, p := range procs {
		if p.name == "sleep" {
			sleep = p.pid
		}
	}
	ts.Lock()
	orphans, err := ts.Orphans()
	ts.Unlock()
	if !slices.Equal(orphans, []int{sleep}) || err != nil {
		t.Errorf("Orphans() = %v, %v; want only the sleep [%d]", orphans, err, sleep)
	}
	ts.waitClosed(t)
}
