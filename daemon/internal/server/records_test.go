package server

import (
	"os/exec"
	"slices"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

// A record whose PTY session still has a process lists it; kill and dismiss
// answer with it and keep the record, until the process is gone and a kill
// leaves the record restorable.
func TestRecordWithOrphansIsCleanedByKill(t *testing.T) {
	sleep := exec.Command("/bin/sleep", "60")
	sleep.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := sleep.Start(); err != nil {
		t.Fatal(err)
	}
	pid := sleep.Process.Pid
	t.Cleanup(func() {
		sleep.Process.Kill()
		sleep.Wait()
	})
	rec := state.SessionRecord{SID: 5, PID: pid, Started: time.Now(), Cwd: "/tmp", Cmd: "claude"}
	srv := startSessionServer(t, Options{State: state.State{Shell: "/bin/sh", Sessions: []state.SessionRecord{rec}}})
	a := dialClient(t, srv)

	// Options.State is taken as given, so the orphans are found by the first
	// rescan.
	if err := a.c.Kill(5); err != nil {
		t.Fatal(err)
	}
	a.waitFor("orphans error", func() bool { return len(a.errs) == 1 })
	if e := a.errs[0]; e.Code != protocol.CodeOrphans || e.SID != 5 || !slices.Equal(e.PIDs, []int{pid}) {
		t.Errorf("kill answered %+v, want %q with [%d]", e, protocol.CodeOrphans, pid)
	}
	if i := a.info(5); i == nil || i.Restorable || !slices.Equal(i.Orphans, []int{pid}) {
		t.Errorf("listed %+v, want orphans [%d] and not restorable", i, pid)
	}

	if err := a.c.Dismiss(5); err != nil {
		t.Fatal(err)
	}
	a.waitFor("second orphans error", func() bool { return len(a.errs) == 2 })
	if e := a.errs[1]; e.Code != protocol.CodeOrphans || e.SID != 5 || !slices.Equal(e.PIDs, []int{pid}) {
		t.Errorf("dismiss answered %+v, want %q with [%d]", e, protocol.CodeOrphans, pid)
	}
	if savedRecord(t, srv, 5) == nil {
		t.Fatal("dismiss removed a record that holds a process")
	}

	if err := sleep.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	sleep.Wait()
	deadline := time.Now().Add(sessTimeout)
	for {
		if _, err := unix.Getsid(pid); err != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("process %d still alive", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
	n := len(a.lists)
	if err := a.c.Kill(5); err != nil {
		t.Fatal(err)
	}
	a.waitFor("list after the kill", func() bool { return len(a.lists) > n })
	if i := a.info(5); i == nil || !i.Restorable || len(i.Orphans) != 0 {
		t.Errorf("listed %+v, want restorable without orphans", i)
	}
	if len(a.errs) != 2 {
		t.Errorf("errors %+v, want only the first two", a.errs)
	}

	if err := a.c.Dismiss(5); err != nil {
		t.Fatal(err)
	}
	a.waitFor("record dismissed", func() bool { return a.info(5) == nil })
	if r := savedRecord(t, srv, 5); r != nil {
		t.Errorf("state.json still holds %+v", r)
	}
}
