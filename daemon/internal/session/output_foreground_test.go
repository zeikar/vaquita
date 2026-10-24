package session

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/status"
)

// watchedOutput returns a statusOutput whose foreground process group is 42
// and whose groups are alive while *alive is true, counting the polls in
// *polls.
func watchedOutput() (o *Output, now *time.Time, alive *bool, polls *int) {
	o, now = statusOutput()
	alive, polls = new(bool), new(int)
	*alive = true
	// The reporter shares the leader's group, so the shell counts as holding
	// the terminal once the reporter is dead; LeaderIsShell is nil, so the
	// group is polled like any other.
	o.leader = 42
	o.Foreground = func() (int, error) { return 42, nil }
	o.GroupAlive = func(pgid int) bool {
		*polls++
		return *alive && pgid == 42
	}
	return o, now, alive, polls
}

func TestOutputForegroundGroupPoll(t *testing.T) {
	o, now, alive, polls := watchedOutput()
	t0 := *now
	o.Feed([]byte(working + "\x1b]7501;id=a:state=done\x07\x1b]7501;id=b:state=working\x07"))
	o.TakeStatus()
	if o.reporter != 42 {
		t.Fatalf("reporter %d, want 42", o.reporter)
	}
	d, ok := o.NextDeadline()
	if !ok || !d.Equal(t0.Add(time.Second)) {
		t.Fatalf("deadline %v, %v; want the poll at %v", d, ok, t0.Add(time.Second))
	}
	o.Tick(t0.Add(500 * time.Millisecond))
	if *polls != 0 {
		t.Fatalf("%d polls before the deadline", *polls)
	}

	o.Tick(d)
	if *polls != 1 || o.HasStatus() {
		t.Fatalf("%d polls, pending %v", *polls, o.HasStatus())
	}
	if d2, ok := o.NextDeadline(); !ok || !d2.Equal(d.Add(time.Second)) {
		t.Fatalf("deadline after a live poll %v, %v; want %v", d2, ok, d.Add(time.Second))
	}

	*alive = false
	o.Tick(d.Add(time.Second))
	changed, notes := o.TakeStatus()
	if v, _ := o.View(); !changed || len(notes) != 0 || v != (status.View{}) {
		t.Fatalf("changed %v, notes %v, view %+v; want an empty view and no notification", changed, notes, v)
	}
	// As at a new prompt, only the done record outlives the reporter.
	if recs := o.Status().Records; len(recs) != 1 || recs[0].ID != "a" {
		t.Fatalf("records after the group died: %+v", recs)
	}
	if _, ok := o.NextDeadline(); ok {
		t.Fatal("deadline left after the group died")
	}
}

// A helper left in the reporter's group keeps it alive after the reporter
// died; the shell taking the terminal back is what clears the view. A failed
// foreground lookup leaves the decision to the group check.
func TestOutputForegroundMovedClearsView(t *testing.T) {
	o, now, _, polls := watchedOutput()
	t0 := *now
	fg, fgErr := 42, error(nil)
	o.Foreground = func() (int, error) { return fg, fgErr }
	o.Feed([]byte(working))
	o.TakeStatus()
	o.Tick(t0.Add(fgPollGap))
	fgErr = ErrClosed
	o.Tick(t0.Add(2 * fgPollGap))
	if v, _ := o.View(); v.State != status.ViewWorking || *polls != 2 {
		t.Fatalf("view %+v after %d group checks; want working and 2", v, *polls)
	}

	fg, fgErr = 7, nil
	o.Tick(t0.Add(3 * fgPollGap))
	changed, notes := o.TakeStatus()
	if v, _ := o.View(); !changed || len(notes) != 0 || v != (status.View{}) {
		t.Fatalf("changed %v, notes %v, view %+v; want an empty view and no notification", changed, notes, v)
	}
	// The mode release waits for the shell to have the terminal.
	if _, ok := o.NextDeadline(); !ok {
		t.Fatal("no poll for the pending release")
	}
	fg = 42
	o.Tick(t0.Add(4 * fgPollGap))
	if _, ok := o.NextDeadline(); ok {
		t.Fatal("deadline left after the release")
	}
}

// A report read while the shell's own group is in the foreground comes from a
// program that has already exited: the next poll clears it without asking
// whether the shell's group is alive.
func TestOutputReportFromShellGroupClears(t *testing.T) {
	o, now, _, polls := watchedOutput()
	t0 := *now
	o.leader = 42
	o.LeaderIsShell = func() bool { return true }
	o.Feed([]byte(working))
	if changed, _ := o.TakeStatus(); !changed {
		t.Fatal("working report not published before the clear")
	}
	if v, _ := o.View(); v.State != status.ViewWorking {
		t.Fatalf("view %+v, want working until the poll", v)
	}
	d, ok := o.NextDeadline()
	if !ok || !d.Equal(t0.Add(fgPollGap)) {
		t.Fatalf("deadline %v, %v; want the poll at %v", d, ok, t0.Add(fgPollGap))
	}
	o.Tick(d)
	if v, _ := o.View(); v != (status.View{}) || *polls != 0 {
		t.Fatalf("view %+v after %d group checks; want it cleared with none", v, *polls)
	}
	if _, ok := o.NextDeadline(); ok {
		t.Fatal("deadline left after the clear")
	}
}

// An agent that replaced the shell with exec shares the leader's group; it is
// watched like any reporter, and its completion is still notified.
func TestOutputReportFromReplacedLeaderIsWatched(t *testing.T) {
	for name, fn := range map[string]func() bool{
		"not a shell":      func() bool { return false },
		"no LeaderIsShell": nil,
	} {
		o, now, _, polls := watchedOutput()
		t0 := *now
		o.leader = 42
		o.LeaderIsShell = fn
		o.Feed([]byte(working))
		o.TakeStatus()
		for i := 1; i <= 3; i++ {
			o.Tick(t0.Add(time.Duration(i) * fgPollGap))
		}
		if v, _ := o.View(); v.State != status.ViewWorking || *polls != 3 {
			t.Fatalf("%s: view %+v after %d group checks; want working and 3", name, v, *polls)
		}
		*now = t0.Add(3 * fgPollGap)
		o.Feed([]byte(codexPong))
		o.Tick(now.Add(2 * time.Second))
		if _, notes := o.TakeStatus(); len(notes) != 1 || notes[0].Kind != status.NotifyDone {
			t.Fatalf("%s: notes %v, want the done", name, notes)
		}
	}
}

// appended returns what f appends to o's ring.
func appended(o *Output, f func()) string {
	end := o.Ring().End()
	f()
	return string(o.Ring().CopyRange(end, o.Ring().End(), nil))
}

// A done view is polled too, as an agent killed at its prompt leaves its
// modes on just the same. Its death keeps the done view, and the done is
// still notified once it has stood for its quiet period.
func TestOutputForegroundGroupPollKeepsDone(t *testing.T) {
	o, now, alive, polls := watchedOutput()
	t0 := *now
	o.Feed([]byte("\x1b[?1003h" + working + codexPong))
	o.TakeStatus()
	*alive = false
	// The poll a second after the working comes before the done's deadline.
	if d, ok := o.NextDeadline(); !ok || !d.Equal(t0.Add(fgPollGap)) {
		t.Fatalf("deadline %v, %v; want the poll at %v", d, ok, t0.Add(fgPollGap))
	}
	if got := appended(o, func() { o.Tick(t0.Add(fgPollGap)) }); got != "\x1b[?1003l" || *polls != 1 {
		t.Fatalf("appended %q after %d polls; want %q after 1", got, *polls, "\x1b[?1003l")
	}
	if changed, notes := o.TakeStatus(); changed || len(notes) != 0 {
		t.Fatalf("changed %v, notes %v; want the done view kept and its notification still pending", changed, notes)
	}
	d, ok := o.NextDeadline()
	if !ok || !d.Equal(t0.Add(status.DoneQuiet)) {
		t.Fatalf("deadline %v, %v; want the done's at %v", d, ok, t0.Add(status.DoneQuiet))
	}
	o.Tick(d)
	_, notes := o.TakeStatus()
	if want := []status.Notification{{Kind: status.NotifyDone, Msg: "pong"}}; !slices.Equal(notes, want) {
		t.Fatalf("notes %v", notes)
	}
	if v, unread := o.View(); v != (status.View{State: status.ViewDone, Msg: "pong"}) || !unread {
		t.Fatalf("view %+v unread %v; want the done unread", v, unread)
	}
}

// The poll that finds the reporter gone undoes the modes it left on, but not
// those a line editor sets for its prompt, which the shell may have drawn by
// then.
func TestOutputReporterDeathReleasesModes(t *testing.T) {
	o, now, alive, _ := watchedOutput()
	t0 := *now
	o.Feed([]byte("\x1b[?1049h\x1b[>1u\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?2026h" + working))
	*alive = false
	o.Feed([]byte("\x1b[?2004h\x1b[?1h$ "))
	const want = "\x1b[<1u\x1b[?1049l\x1b[?25h\x1b[?2026l\x1b[?1002l\x1b[?1006l"
	if got := appended(o, func() { o.Tick(t0.Add(fgPollGap)) }); got != want {
		t.Fatalf("appended %q, want %q", got, want)
	}
	if got := string(o.liveModes.Prefix()); got != "\x1b[?1h\x1b[?2004h" {
		t.Fatalf("modes left on %q, want only the prompt's", got)
	}
	if v, _ := o.View(); v != (status.View{}) {
		t.Fatalf("view %+v, want it cleared", v)
	}
	if _, ok := o.NextDeadline(); ok {
		t.Fatal("deadline left after the reporter's death")
	}
}

// A reporter killed in the middle of a sequence leaves the live scanner inside
// it; the release starts with ESC, which abandons it, so it still takes effect.
func TestOutputReleaseAfterUnfinishedSequence(t *testing.T) {
	for _, unfinished := range []string{"\x1b[?10", "\x1b]0;title", "\x1b]0;title\x1b", "\x1bP1$r", "\x1b(", "\xe2\x94"} {
		o, now, alive, _ := watchedOutput()
		o.Feed([]byte("\x1b[?1049h\x1b[?1003h\x1b[?1006h" + working + unfinished))
		*alive = false
		o.Tick(now.Add(fgPollGap))
		if m := canonical(o.liveModes); m != (Modes{}) || !o.live.AtBoundary() {
			t.Errorf("after %q: modes %+v, scanner at a boundary %v; want the defaults at a boundary", unfinished, m, o.live.AtBoundary())
		}
	}
}

// Only a reporter's death undoes modes: not without a watch, not while the
// reporter lives, and not after the clear an agent sends as it exits.
func TestOutputReleaseNeedsReporterDeath(t *testing.T) {
	const modes = "\x1b[?1049h\x1b[?1003h"
	for _, tc := range []struct {
		name         string
		watch, alive bool
		in           string
		reporter     int // after the polls
	}{
		{"no watch", false, false, modes + working, 0},
		{"reporter alive", true, true, modes + working, 42},
		{"after clear", true, false, modes + working + "\x1b]7501;state=clear\x07", 0},
		{"no modes on", true, false, working, 0},
	} {
		o, now := statusOutput()
		if tc.watch {
			var alive *bool
			o, now, alive, _ = watchedOutput()
			*alive = tc.alive
		}
		t0 := *now
		o.Feed([]byte(tc.in))
		got := appended(o, func() {
			for i := 1; i <= 3; i++ {
				o.Tick(t0.Add(time.Duration(i) * fgPollGap))
			}
		})
		if got != "" || o.reporter != tc.reporter {
			t.Errorf("%s: appended %q with reporter %d; want nothing and %d", tc.name, got, o.reporter, tc.reporter)
		}
	}
}

// A program in front of the shell when the poll finds the agent dead keeps
// the release pending, polled at the usual gap, until the shell has the
// terminal back, as in `claude; sleep 10`. A successor TUI restores its own
// modes by then, so the release emits only what is still on.
func TestOutputReleaseWaitsForShellForeground(t *testing.T) {
	o, now, alive, _ := watchedOutput()
	t0 := *now
	fg := 42
	o.Foreground = func() (int, error) { return fg, nil }
	o.Feed([]byte("\x1b[?1003h" + working))
	*alive = false
	fg = 77
	for i := 1; i <= 3; i++ {
		at := t0.Add(time.Duration(i) * fgPollGap)
		if got := appended(o, func() { o.Tick(at) }); got != "" {
			t.Fatalf("appended %q while another job held the terminal", got)
		}
		if d, ok := o.NextDeadline(); !ok || !d.Equal(at.Add(fgPollGap)) {
			t.Fatalf("deadline %v, %v; want the next poll at %v", d, ok, at.Add(fgPollGap))
		}
	}
	fg = 42
	if got := appended(o, func() { o.Tick(t0.Add(4 * fgPollGap)) }); got != "\x1b[?1003l" {
		t.Fatalf("appended %q, want %q", got, "\x1b[?1003l")
	}
	if _, ok := o.NextDeadline(); ok {
		t.Fatal("deadline left after the release")
	}
}

func TestOutputReleaseAfterSuccessorRestoredItsModes(t *testing.T) {
	o, now, alive, _ := watchedOutput()
	t0 := *now
	fg := 42
	o.Foreground = func() (int, error) { return fg, nil }
	o.Feed([]byte("\x1b[?1003h" + working))
	*alive = false
	fg = 77
	o.Feed([]byte("\x1b[?1049h\x1b[?1000h"))
	o.Tick(t0.Add(fgPollGap))
	o.Feed([]byte("\x1b[?1000l\x1b[?1049l"))
	fg = 42
	if got := appended(o, func() { o.Tick(t0.Add(2 * fgPollGap)) }); got != "" {
		t.Fatalf("appended %q after the successor restored its modes", got)
	}
}

// A shell that draws its prompt before the poll forgets the reporter, but the
// modes are still undone by the next Tick.
func TestOutputReleaseSurvivesPromptStart(t *testing.T) {
	o, now, _, _ := watchedOutput()
	t0 := *now
	o.Feed([]byte("\x1b[?1003h" + working))
	if got := appended(o, func() { o.Feed([]byte("\x1b]133;A\x07")) }); !strings.HasSuffix(got, "\x1b]133;A\x07") || strings.Contains(got, "1003l") {
		t.Fatalf("scanner callback appended %q", got)
	}
	if d, ok := o.NextDeadline(); !ok || d.After(t0) {
		t.Fatalf("deadline %v, %v; want the release due now", d, ok)
	}
	if got := appended(o, func() { o.Tick(t0) }); got != "\x1b[?1003l" {
		t.Fatalf("appended %q, want %q", got, "\x1b[?1003l")
	}
	if _, ok := o.NextDeadline(); ok {
		t.Fatal("deadline left after the release")
	}
}

// An agent that reported only its startup idle is watched too.
func TestOutputIdleOnlyReporterReleasedOnDeath(t *testing.T) {
	o, now, alive, _ := watchedOutput()
	t0 := *now
	o.Feed([]byte("\x1b[?1003h\x1b]7501;state=idle\x07"))
	if v, _ := o.View(); v != (status.View{}) {
		t.Fatalf("view %+v, want the projection unchanged", v)
	}
	if !o.NeedsDrain() {
		t.Fatal("no drain asked for the new watch")
	}
	*alive = false
	if got := appended(o, func() { o.Tick(t0.Add(fgPollGap)) }); got != "\x1b[?1003l" {
		t.Fatalf("appended %q, want %q", got, "\x1b[?1003l")
	}
}

func TestOutputForegroundGroupUnknown(t *testing.T) {
	for _, fg := range []func() (int, error){
		func() (int, error) { return 0, nil }, // no foreground group
		func() (int, error) { return 1, nil },
		func() (int, error) { return 0, ErrClosed },
	} {
		o, _, _, _ := watchedOutput()
		o.Feed([]byte(working))
		o.Foreground = fg
		o.Feed([]byte("\x1b]7501;state=blocked:kind=permission\x07"))
		if _, ok := o.NextDeadline(); ok || o.reporter != 0 {
			t.Fatalf("deadline %v with reporter %d; want no poll", ok, o.reporter)
		}
	}
}

func TestOutputForegroundGroupForgotten(t *testing.T) {
	for name, seq := range map[string]string{
		"clear":        "\x1b]7501;state=clear\x07",
		"RIS":          "\x1bc",
		"prompt start": "\x1b]133;A\x07",
	} {
		o, _, _, _ := watchedOutput()
		o.Feed([]byte(working))
		o.Feed([]byte(seq))
		if o.reporter != 0 {
			t.Errorf("%s: reporter %d left", name, o.reporter)
		}
	}
}
