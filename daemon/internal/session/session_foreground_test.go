package session

import (
	"regexp"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/status"
	"golang.org/x/sys/unix"
)

// A program that reports and dies before the daemon reads the report leaves
// the shell's group in the foreground. That group never goes away, so the
// view must not be left to watch it.
func TestReporterGoneBeforeReadClearsView(t *testing.T) {
	ts := startSession(t, `set -m; sh -c 'printf "\033]7501;state=working:app=x\007"'; read l; printf "after:%s" "$l"`, nil)
	deadline := time.After(testTimeout)
	for {
		ts.Lock()
		v, _ := ts.out.View()
		ts.Unlock()
		if v.State == status.ViewWorking {
			break
		}
		select {
		case <-ts.output:
		case <-deadline:
			t.Fatalf("view never turned working; output ends %q", tail(ringText(ts.Session)))
		}
	}
	stop := time.Now().Add(testTimeout)
	for {
		ts.Lock()
		v, _ := ts.out.View()
		d, ok := ts.out.NextDeadline()
		if v == (status.View{}) {
			ts.Unlock()
			return
		}
		if !ok {
			ts.Unlock()
			t.Fatalf("no poll scheduled for view %+v", v)
		}
		ts.out.Tick(d)
		ts.Unlock()
		if time.Now().After(stop) {
			t.Fatalf("view %+v outlived its reporter", v)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// An agent started with exec replaces the shell and keeps its process group,
// so the shell's group is in the foreground and alive for as long as the agent
// is. The leader is no shell then, and the view must outlast several polls.
func TestExecAgentKeepsView(t *testing.T) {
	ts := startSession(t, `sleep 0.2; exec /usr/bin/perl -e '$|=1; print "\e]7501;state=working:app=x\a"; sleep 60'`, nil)
	deadline := time.After(testTimeout)
	for {
		ts.Lock()
		v, _ := ts.out.View()
		ts.Unlock()
		if v.State == status.ViewWorking {
			break
		}
		select {
		case <-ts.output:
		case <-deadline:
			t.Fatalf("view never turned working; output ends %q", tail(ringText(ts.Session)))
		}
	}
	stop := time.Now().Add(3 * fgPollGap)
	for time.Now().Before(stop) {
		ts.Lock()
		reporter, gone := ts.out.reporter, ts.out.gone
		d, _ := ts.out.NextDeadline()
		ts.out.Tick(d)
		v, _ := ts.out.View()
		ts.Unlock()
		if reporter != ts.PID() || gone {
			t.Fatalf("reporter %d gone %v, want the leader %d watched", reporter, gone, ts.PID())
		}
		if v.State != status.ViewWorking {
			t.Fatalf("view %+v cleared while the agent lives", v)
		}
		time.Sleep(10 * time.Millisecond)
	}
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
		d, ok := ts.out.NextDeadline()
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

// A helper an agent starts in its own process group can outlive it, as the
// caffeinate Claude Code runs does, so the group outlasts a SIGKILL of the
// agent alone. The shell takes the terminal back once it has reaped the job,
// and that clears the view. The job's sh prints its pid, which the main process
// keeps when the sh replaces itself with it.
func TestHelperOutlivingReporterClearsView(t *testing.T) {
	ts := startSession(t, `set -m; sh -c 'sleep 30 & printf "main:%s;" $$; sleep 0.2; printf "\033]7501;state=working:app=x\007"; exec sleep 60'; read l; printf "after:%s" "$l"`, nil)
	var reporter int
	deadline := time.After(testTimeout)
	for {
		ts.Lock()
		v, _ := ts.out.View()
		reporter = ts.out.reporter
		fg, fgErr := ts.out.Foreground()
		ts.Unlock()
		if v.State == status.ViewWorking {
			if reporter <= 1 || reporter == ts.PID() || reporter != fg || fgErr != nil {
				t.Fatalf("reporter %d, foreground %d (%v), shell %d; want the job's own group", reporter, fg, fgErr, ts.PID())
			}
			break
		}
		select {
		case <-ts.output:
		case <-deadline:
			t.Fatalf("view never turned working; output ends %q", tail(ringText(ts.Session)))
		}
	}
	m := regexp.MustCompile(`main:(\d+);`).FindStringSubmatch(ringText(ts.Session))
	if m == nil {
		t.Fatalf("no main pid in the output %q", tail(ringText(ts.Session)))
	}
	mainPID, err := strconv.Atoi(m[1])
	if err != nil {
		t.Fatal(err)
	}
	// Only a process of this test's job is ever signalled.
	pgid, pgErr := unix.Getpgid(mainPID)
	sid, sidErr := unix.Getsid(mainPID)
	if pgErr != nil || sidErr != nil || pgid != reporter || sid != ts.PID() {
		t.Fatalf("main %d: group %d (%v), session %d (%v); want %d, %d", mainPID, pgid, pgErr, sid, sidErr, reporter, ts.PID())
	}
	if err := unix.Kill(mainPID, unix.SIGKILL); err != nil {
		t.Fatalf("kill main %d: %v", mainPID, err)
	}

	stop := time.Now().Add(testTimeout)
	for {
		ts.Lock()
		v, _ := ts.out.View()
		d, ok := ts.out.NextDeadline()
		if v == (status.View{}) {
			ts.Unlock()
			break
		}
		if !ok {
			ts.Unlock()
			t.Fatalf("no poll scheduled for view %+v", v)
		}
		ts.out.Tick(d)
		fg, _ := ts.out.Foreground()
		ts.Unlock()
		if time.Now().After(stop) {
			t.Fatalf("view %+v outlived the job's main process; its group %d alive %v, foreground %d", v, reporter, groupAlive(reporter), fg)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The helper keeps the group alive, so only the terminal can have told.
	if !groupAlive(reporter) {
		t.Fatalf("group %d died with its main process; the helper did not outlive it", reporter)
	}

	ts.write(t, "x\n")
	ts.waitOutput(t, "after:x")
}

// agentModes are terminal modes full-screen agents such as Claude Code and
// Codex turn on: the alternate screen, mouse tracking with SGR encoding and
// focus events, written for printf. releaseModes is what the daemon writes to
// undo them once such an agent has died.
const (
	agentModes   = `\033[?1049h\033[?1003h\033[?1006h\033[?1004h`
	releaseModes = "\x1b[?1049l\x1b[?1004l\x1b[?1003l\x1b[?1006l"
)

// waitView waits for the session's view to show state.
func (ts *testSession) waitView(t *testing.T, state string) {
	t.Helper()
	deadline := time.After(testTimeout)
	for {
		ts.Lock()
		v, _ := ts.out.View()
		ts.Unlock()
		if v.State == state {
			return
		}
		select {
		case <-ts.output:
		case <-deadline:
			t.Fatalf("view never showed %s; output ends %q", state, tail(ringText(ts.Session)))
		}
	}
}

// killReporter SIGKILLs the process group the session's status came from,
// which must be a job of this test's PTY session other than the shell, still
// in the foreground.
func (ts *testSession) killReporter(t *testing.T) {
	t.Helper()
	ts.Lock()
	reporter := ts.out.reporter
	fg, fgErr := ts.out.Foreground()
	ts.Unlock()
	if reporter <= 1 || reporter == ts.PID() || reporter != fg || fgErr != nil {
		t.Fatalf("reporter %d, foreground %d (%v), shell %d; want the job's own group", reporter, fg, fgErr, ts.PID())
	}
	if sid, err := unix.Getsid(reporter); err != nil || sid != ts.PID() {
		t.Fatalf("Getsid(%d) = %d, %v; want %d", reporter, sid, err, ts.PID())
	}
	if err := unix.Kill(-reporter, unix.SIGKILL); err != nil {
		t.Fatalf("kill job group %d: %v", reporter, err)
	}
}

// tickUntilGone ticks the output at each of its deadlines until the poll has
// found the reporter gone, and returns what that Tick appended to the ring,
// with the status taken meanwhile. The shell reaps a killed job some time
// after the kill; until then its group is still there.
func (ts *testSession) tickUntilGone(t *testing.T) (added string, changed bool, notes []status.Notification) {
	t.Helper()
	stop := time.Now().Add(testTimeout)
	for {
		ts.Lock()
		d, ok := ts.out.NextDeadline()
		if !ok {
			ts.Unlock()
			t.Fatal("no poll scheduled while the reporter is known")
		}
		r := ts.out.Ring()
		end := r.End()
		ts.out.Tick(d)
		c, n := ts.out.TakeStatus()
		changed, notes = changed || c, append(notes, n...)
		gone := ts.out.reporter == 0
		added = string(r.CopyRange(end, r.End(), nil))
		ts.Unlock()
		if gone {
			return added, changed, notes
		}
		if time.Now().After(stop) {
			t.Fatal("the reporter's death was never noticed")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// checkModesReleased checks that the modes in effect at the ring end are the
// defaults again. The session's sh runs without a line editor, so it sets
// none of its own.
func (ts *testSession) checkModesReleased(t *testing.T) {
	t.Helper()
	ts.Lock()
	m := canonical(ts.out.liveModes)
	ts.Unlock()
	if m != (Modes{}) {
		t.Fatalf("modes at the ring end %+v, want the defaults", m)
	}
}

// A program killed in its own process group leaves on the terminal modes it
// set, and with mouse tracking left on, every mouse move over the terminal
// types a report into the shell. The poll that finds the program gone undoes
// them in the output, which every terminal showing the session then gets.
func TestForegroundGroupDeathReleasesModes(t *testing.T) {
	ts := startSession(t, `set -m; sh -c 'sleep 0.2; printf "`+agentModes+`\033]7501;state=working:app=x\007"; exec sleep 60'; read l; printf "after:%s" "$l"`, nil)
	ts.waitView(t, status.ViewWorking)
	ts.killReporter(t)
	if added, _, _ := ts.tickUntilGone(t); added != releaseModes {
		t.Fatalf("the poll that found the reporter gone appended %q, want %q", added, releaseModes)
	}
	ts.checkModesReleased(t)

	ts.write(t, "x\n")
	ts.waitOutput(t, "after:x")
}

// An agent killed at its prompt after a finished turn leaves its modes on
// just the same. Its death undoes them, and the done view and its
// notification stay as they were.
func TestDoneAgentDeathReleasesModes(t *testing.T) {
	ts := startSession(t, `set -m; sh -c 'sleep 0.2; printf "`+agentModes+`\033]7501;state=working:app=x\007\033]7501;state=done:app=x:msg=b2s=\007"; exec sleep 60'; read l; printf "after:%s" "$l"`, nil)
	ts.waitView(t, status.ViewDone)
	ts.Lock()
	ts.out.TakeStatus()
	ts.Unlock()
	ts.killReporter(t)
	added, changed, notes := ts.tickUntilGone(t)
	if added != releaseModes {
		t.Fatalf("the poll that found the reporter gone appended %q, want %q", added, releaseModes)
	}
	ts.checkModesReleased(t)

	ts.Lock()
	if d, ok := ts.out.NextDeadline(); ok {
		ts.out.Tick(d)
	}
	c, n := ts.out.TakeStatus()
	changed, notes = changed || c, append(notes, n...)
	v, unread := ts.out.View()
	ts.Unlock()
	if want := (status.View{State: status.ViewDone, Msg: "ok"}); changed || v != want || !unread {
		t.Errorf("view %+v unread %v, changed %v; want %+v unread and unchanged", v, unread, changed, want)
	}
	if want := []status.Notification{{Kind: status.NotifyDone, Msg: "ok"}}; !slices.Equal(notes, want) {
		t.Errorf("notifications %v, want %v", notes, want)
	}

	ts.write(t, "x\n")
	ts.waitOutput(t, "after:x")
}
