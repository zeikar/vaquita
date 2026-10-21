package session

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

const (
	// hupGrace is how long the members of a PTY session get to exit after
	// SIGHUP before the rest are killed.
	hupGrace = 3 * time.Second
	// killGrace bounds the wait for SIGKILLed members to go away; one stuck
	// in an uninterruptible wait can outlast it.
	killGrace       = 2 * time.Second
	livenessPollGap = 100 * time.Millisecond
)

// listProcs lists every process on the system; a variable so that tests can
// make it fail.
var listProcs = func() ([]unix.KinfoProc, error) {
	return unix.SysctlKinfoProcSlice("kern.proc.all")
}

// proc is a member of a PTY session.
type proc struct {
	pid, pgid int
	start     time.Time
}

// sessionProcs lists the processes whose POSIX session id is sid.
//
// It asks every process for its session id because macOS has no
// KERN_PROC_SESSION (nor pgrep -s) to list a session's members, and a lookup
// by controlling tty loses HUP-ignoring children once the leader is gone: the
// tty is revoked and they show none, yet getsid still reports the old leader's
// pid for them.
func sessionProcs(sid int) ([]proc, error) {
	// Session 1 is launchd's, and sid comes from state.json among others.
	if sid <= 1 {
		return nil, nil
	}
	kps, err := listProcs()
	if err != nil {
		return nil, fmt.Errorf("list processes: %w", err)
	}
	var procs []proc
	for i := range kps {
		pid := int(kps[i].Proc.P_pid)
		// getsid(0) would report the daemon's own session.
		if pid <= 0 || !inSession(pid, sid) {
			continue
		}
		procs = append(procs, proc{
			pid:   pid,
			pgid:  int(kps[i].Eproc.Pgid),
			start: time.Unix(kps[i].Proc.P_starttime.Unix()),
		})
	}
	return procs, nil
}

// inSession reports whether pid is a live member of session sid. getsid fails
// with ESRCH for a process that is gone or a zombie, neither of which is a
// member to report or wait for.
func inSession(pid, sid int) bool {
	got, err := unix.Getsid(pid)
	return err == nil && got == sid
}

// SessionPIDs lists the pids of the processes in the PTY session sid, nil if
// there are none. leaderStart is when the process with pid sid started if it
// is among them (it leads the session), and zero otherwise; a mismatch with
// the recorded start shows the pid now leads some other session. An error
// means the members are unknown, not that there are none.
func SessionPIDs(sid int) (pids []int, leaderStart time.Time, err error) {
	procs, err := sessionProcs(sid)
	for _, p := range procs {
		if p.pid == sid {
			leaderStart = p.start
		}
	}
	return pidsOf(procs), leaderStart, err
}

func pidsOf(procs []proc) []int {
	var pids []int
	for _, p := range procs {
		pids = append(pids, p.pid)
	}
	return pids
}

// killSession ends every process in the PTY session sid: SIGHUP to each of
// its process groups, then SIGKILL to whatever is left after hupGrace. It
// returns the pids still alive killGrace after the SIGKILL.
func killSession(sid int) (survivors []int) {
	first := killTargets(sid, "SIGHUP")
	// A stopped job only acts on the HUP once continued, so shells send
	// SIGCONT along with it.
	signalGroups(first, unix.SIGHUP, unix.SIGCONT)
	waitGone(sid, pidsOf(first), hupGrace)

	// The SIGKILL goes by a fresh scan rather than by what outlived the wait:
	// a pid that died meanwhile may already belong to an unrelated process,
	// while members forked since are only in the new scan. Members keep the
	// session id after the leader has died, so the scan still finds them.
	rest := killTargets(sid, "SIGKILL")
	if len(rest) == 0 {
		return nil
	}
	signalGroups(rest, unix.SIGKILL)
	// A member may have changed its group since the scan.
	self := os.Getpid()
	for _, p := range rest {
		if p.pid > 1 && p.pid != self {
			signal(p.pid, unix.SIGKILL)
		}
	}
	return waitGone(sid, pidsOf(rest), killGrace)
}

// killTargets scans session sid for a kill stage. When the scan fails it
// falls back to the shell alone: it leads both the session and its own
// process group, whose id is sid.
func killTargets(sid int, stage string) []proc {
	procs, err := sessionProcs(sid)
	if err != nil {
		slog.Error("session: kill falls back to the shell's process group", "sid", sid, "stage", stage, "err", err)
		return []proc{{pid: sid, pgid: sid}}
	}
	return procs
}

// signalGroups sends sigs, in order, to each process group in procs. The
// daemon's own group cannot be among them, as it is in another session, but a
// bad scan must never take the daemon or launchd down with it.
func signalGroups(procs []proc, sigs ...unix.Signal) {
	own := unix.Getpgrp()
	seen := make(map[int]bool)
	for _, p := range procs {
		if p.pgid <= 1 || p.pgid == own || seen[p.pgid] {
			continue
		}
		seen[p.pgid] = true
		for _, sig := range sigs {
			signal(-p.pgid, sig)
		}
	}
}

func signal(target int, sig unix.Signal) {
	// ESRCH: the target is already gone, which is the point.
	if err := unix.Kill(target, sig); err != nil && !errors.Is(err, unix.ESRCH) {
		slog.Warn("session: signal", "target", target, "signal", unix.SignalName(sig), "err", err)
	}
}

// waitGone polls until none of pids is a live member of session sid or d has
// passed, and returns the ones still there. Asking by session rather than
// with kill(pid, 0) counts zombies as gone and never waits on a pid reused
// by an unrelated process.
func waitGone(sid int, pids []int, d time.Duration) []int {
	deadline := time.Now().Add(d)
	for {
		var alive []int
		for _, pid := range pids {
			if inSession(pid, sid) {
				alive = append(alive, pid)
			}
		}
		if len(alive) == 0 || !time.Now().Before(deadline) {
			return alive
		}
		pids = alive
		time.Sleep(livenessPollGap)
	}
}
