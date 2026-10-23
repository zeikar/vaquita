package session

import (
	"bytes"
	"encoding/base64"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/status"
)

// feedText feeds n bytes of plain text in reads of at most 64KB, as the PTY
// reader does, so the ring gets a cut boundary per read.
func feedText(o *Output, n int) {
	chunk := bytes.Repeat([]byte("text\r\n"), (64<<10)/6)
	for n > 0 {
		k := min(n, len(chunk))
		o.Feed(chunk[:k])
		n -= k
	}
}

func checkPrefix(t *testing.T, o *Output, want string) {
	t.Helper()
	if got := string(o.ReplayPrefix()); got != want {
		t.Fatalf("ReplayPrefix = %q, want %q (ring [%d, %d))", got, want, o.Ring().Start(), o.Ring().End())
	}
}

func TestOutputPrefixIsRingStartModes(t *testing.T) {
	o := NewOutput()
	o.Feed([]byte("\x1b[?2004h"))
	// Still in the ring: replaying it sets the mode.
	checkPrefix(t, o, "")

	feedText(o, 2<<20)
	if o.Ring().Start() == 0 {
		t.Fatal("nothing was evicted")
	}
	checkPrefix(t, o, "\x1b[?2004h")

	// The current mode changes, but the ring start's does not until the
	// reset is evicted too.
	o.Feed([]byte("\x1b[?2004l"))
	checkPrefix(t, o, "\x1b[?2004h")
	feedText(o, 2<<20)
	checkPrefix(t, o, "")
}

func TestOutputAltScreenFirst(t *testing.T) {
	o := NewOutput()
	o.Feed([]byte("\x1b[?2004h\x1b[?1049h\x1b[>7u\x1b[?25l"))
	feedText(o, 2<<20)
	checkPrefix(t, o, "\x1b[?1049h\x1b[>7u\x1b[?25l\x1b[?2004h")
}

// recordEvictions makes o's ring report each OnEvict call to calls as well.
func recordEvictions(o *Output) *[][]byte {
	var calls [][]byte
	next := o.ring.OnEvict
	o.ring.OnEvict = func(p []byte) {
		calls = append(calls, bytes.Clone(p))
		next(p)
	}
	return &calls
}

// checkSplit fails unless one OnEvict call ended with head and the next one
// began with tail.
func checkSplit(t *testing.T, calls [][]byte, head, tail string) {
	t.Helper()
	for i := 1; i < len(calls); i++ {
		if bytes.HasSuffix(calls[i-1], []byte(head)) && bytes.HasPrefix(calls[i], []byte(tail)) {
			return
		}
	}
	t.Fatalf("no OnEvict call ending in %q followed by one beginning with %q", head, tail)
}

func TestOutputSequenceSplitAcrossEvictions(t *testing.T) {
	t.Run("ring buffer wrap", func(t *testing.T) {
		o := NewOutput()
		calls := recordEvictions(o)
		o.Feed(bytes.Repeat([]byte("x"), DefaultRingCap-4))
		// Its first four bytes end the buffer, the rest wrap to its start.
		o.Feed([]byte("\x1b[?2004h"))
		checkPrefix(t, o, "")
		feedText(o, DefaultRingCap)
		checkSplit(t, *calls, "\x1b[?2", "004h")
		checkPrefix(t, o, "\x1b[?2004h")
	})

	t.Run("buffered tail and appended head", func(t *testing.T) {
		o := NewOutput()
		calls := recordEvictions(o)
		o.Feed([]byte("\x1b[?20"))
		o.Feed(append([]byte("04h"), bytes.Repeat([]byte("x"), 2*DefaultRingCap)...))
		checkSplit(t, *calls, "\x1b[?20", "04h")
		checkPrefix(t, o, "\x1b[?2004h")
	})

	t.Run("cut inside the sequence", func(t *testing.T) {
		o := NewOutput()
		// The boundary after the sequence lies within markGap of the one
		// after "a" and is not recorded, and the unterminated CSI that
		// follows has none, so eviction falls back to cutting at exactly
		// End-cap.
		o.Feed([]byte("a"))
		o.Feed(append([]byte("\x1b[?2004h\x1b["), bytes.Repeat([]byte(";"), DefaultRingCap-11)...))
		o.Feed([]byte(";;;;;"))
		if o.Ring().Start() != 5 {
			t.Fatalf("Start = %d, want the fallback cut at 5", o.Ring().Start())
		}
		// "a\x1b[?2" is gone, so the tracker is inside the sequence.
		checkPrefix(t, o, "")
		o.Feed([]byte(";;;;;"))
		if o.Ring().Start() != 10 {
			t.Fatalf("Start = %d, want the fallback cut at 10", o.Ring().Start())
		}
		checkPrefix(t, o, "\x1b[?2004h")
	})
}

func TestOutputReplaceScanner(t *testing.T) {
	o := NewOutput()
	o.Feed([]byte("\x1b[?20"))
	if o.live.AtBoundary() {
		t.Fatal("live scanner at a boundary inside a sequence")
	}
	sink := o.live.sink
	o.ReplaceScanner()
	if !o.live.AtBoundary() || o.live.sink != sink {
		t.Fatal("replacement scanner is not in ground state with the same sink")
	}
	// In ground state ';' is text rather than a CSI parameter, so this read
	// ends at a boundary, which the next eviction cuts at.
	o.Feed(bytes.Repeat([]byte(";"), markGap))
	end := o.Ring().End()
	feedText(o, DefaultRingCap-markGap/2)
	if o.Ring().Start() != end {
		t.Fatalf("Start = %d, want the boundary at %d", o.Ring().Start(), end)
	}
}

func TestOutputFeedDoesNotAllocate(t *testing.T) {
	o := NewOutput()
	chunk := append(bytes.Repeat([]byte("text "), 4<<10),
		"\x1b[?2004h\x1b[>1u\x1b[=3;2u\x1b[<u\x1b[?1000;1006h\x1b[!p\x1b[1;31m\x1bc"...)
	feedText(o, DefaultRingCap) // from here on every Feed evicts
	if n := testing.AllocsPerRun(100, func() { o.Feed(chunk) }); n != 0 {
		t.Fatalf("Feed allocates %v times per call", n)
	}
}

func TestOutputStatusReportSplitAcrossFeeds(t *testing.T) {
	o := NewOutput()
	msg := base64.StdEncoding.EncodeToString([]byte("Need approval"))
	seq := "\x1b]7501;state=blocked:kind=permission:app=claude-code:msg=" + msg + "\x1b\\"
	for k := 1; k < len(seq); k++ {
		o = NewOutput()
		o.Feed([]byte(seq[:k]))
		if n := len(o.Status().Records); n != 0 {
			t.Fatalf("split %d: %d records before the sequence ended", k, n)
		}
		o.Feed([]byte(seq[k:]))
		recs := o.Status().Records
		if len(recs) != 1 || recs[0].State != "blocked" || recs[0].Msg != "Need approval" || recs[0].App != "claude-code" {
			t.Fatalf("split %d: records %+v", k, recs)
		}
	}
}

func TestOutputStatusIgnoresQueryAndOversized(t *testing.T) {
	o := NewOutput()
	o.Feed([]byte("\x1b]7501;?\x07"))
	o.Feed([]byte("\x1b]7501;state=working:app=" + strings.Repeat("x", 5000) + "\x07"))
	if recs := o.Status().Records; len(recs) != 0 {
		t.Fatalf("records %+v", recs)
	}
}

func TestOutputStatusLifetimes(t *testing.T) {
	o := NewOutput()
	o.Feed([]byte("\x1b]7501;state=working\x07\x1b]7501;id=a:state=x\x07\x1b]7501;state=done:id=b\x07"))
	if n := len(o.Status().Records); n != 2 {
		t.Fatalf("%d records, want 2 (invalid state dropped)", n)
	}
	o.Feed([]byte("\x1b]133;A\x07"))
	if recs := o.Status().Records; len(recs) != 1 || recs[0].ID != "b" {
		t.Fatalf("after prompt start: %+v", recs)
	}
	// Only A, not B or an A that merely starts a longer word.
	o.Feed([]byte("\x1b]133;B\x07\x1b]133;Ax\x07"))
	if n := len(o.Status().Records); n != 1 {
		t.Fatalf("%d records after 133;B", n)
	}
	o.Feed([]byte("\x1bc"))
	if n := len(o.Status().Records); n != 0 {
		t.Fatalf("%d records after RIS", n)
	}
}

// statusOutput returns an Output whose clock the test moves through *now.
func statusOutput() (*Output, *time.Time) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	o := NewOutput()
	o.Now = func() time.Time { return now }
	return o, &now
}

const (
	codexPong = "\x1b]9;pong\x1b\\\x1b]7501;state=idle:app=codex\x1b\\"
	working   = "\x1b]7501;state=working\x07"
)

func TestOutputCodexCompletion(t *testing.T) {
	want := status.View{State: status.ViewDone, Msg: "pong"}
	t.Run("one feed", func(t *testing.T) {
		o, _ := statusOutput()
		o.Feed([]byte(codexPong))
		if v, unread := o.View(); v != want || !unread {
			t.Fatalf("view %+v unread %v", v, unread)
		}
	})
	t.Run("split", func(t *testing.T) {
		for k := 1; k < len(codexPong); k++ {
			o, _ := statusOutput()
			o.Feed([]byte(codexPong[:k]))
			o.Feed([]byte(codexPong[k:]))
			if v, _ := o.View(); v != want {
				t.Fatalf("split %d: view %+v", k, v)
			}
		}
	})
}

// A lone number is a valid Codex reply; progress commands are not replies.
func TestOutputCodexNumericCompletion(t *testing.T) {
	o, _ := statusOutput()
	o.Feed([]byte("\x1b]9;42\x1b\\\x1b]7501;state=idle:app=codex\x1b\\"))
	if v, unread := o.View(); v != (status.View{State: status.ViewDone, Msg: "42"}) || !unread {
		t.Fatalf("view %+v unread %v", v, unread)
	}

	o, _ = statusOutput()
	o.Feed([]byte("\x1b]9;4;1;50\x1b\\\x1b]7501;state=idle:app=codex\x1b\\"))
	if v, _ := o.View(); v.State == status.ViewDone {
		t.Fatalf("progress report completed the turn: %+v", v)
	}
}

func TestOutputChildReportChangesNothing(t *testing.T) {
	o, _ := statusOutput()
	o.Feed([]byte("\x1b]7501;id=sub:state=done\x07"))
	if v, _ := o.View(); v != (status.View{}) || o.HasStatus() {
		t.Fatalf("view %+v, pending %v", v, o.HasStatus())
	}
	if n := len(o.Status().Records); n != 1 {
		t.Fatalf("%d records", n)
	}
}

func TestOutputTakeStatusOnce(t *testing.T) {
	o, _ := statusOutput()
	if o.HasStatus() {
		t.Fatal("status pending before any output")
	}
	o.Feed([]byte(working))
	if !o.HasStatus() {
		t.Fatal("no status pending after working")
	}
	if changed, notes := o.TakeStatus(); !changed || len(notes) != 0 {
		t.Fatalf("changed %v, notes %v", changed, notes)
	}
	if o.HasStatus() {
		t.Fatal("status still pending after TakeStatus")
	}
	if changed, notes := o.TakeStatus(); changed || len(notes) != 0 {
		t.Fatalf("second take: changed %v, notes %v", changed, notes)
	}
}

func TestOutputRISClearsView(t *testing.T) {
	o, _ := statusOutput()
	o.Feed([]byte(working))
	o.Feed([]byte("\x1bc"))
	if v, _ := o.View(); v != (status.View{}) {
		t.Fatalf("view %+v after RIS", v)
	}
}

func TestOutputRISRaisesDueDone(t *testing.T) {
	o, now := statusOutput()
	o.Feed([]byte(working + "\x1b]7501;state=done:msg=" + base64.StdEncoding.EncodeToString([]byte("ok")) + "\x07"))
	o.TakeStatus()
	*now = now.Add(2 * time.Second) // past DoneQuiet, no Tick
	o.Feed([]byte("\x1bc"))
	changed, notes := o.TakeStatus()
	if want := []status.Notification{{Kind: status.NotifyDone, Msg: "ok"}}; !changed || !slices.Equal(notes, want) {
		t.Fatalf("changed %v, notes %v", changed, notes)
	}
	if v, _ := o.View(); v != (status.View{}) {
		t.Fatalf("view %+v after RIS", v)
	}
	if _, ok := o.NextDeadline(); ok {
		t.Fatal("deadline left after RIS")
	}
}

func TestOutputPromptStart(t *testing.T) {
	o, _ := statusOutput()
	o.Feed([]byte(working + "\x1b]133;A\x07"))
	if v, _ := o.View(); v != (status.View{}) {
		t.Fatalf("working view %+v survived the prompt", v)
	}
	o.Feed([]byte(codexPong + "\x1b]133;A\x07"))
	if v, _ := o.View(); v.State != status.ViewDone {
		t.Fatalf("done view %+v did not survive the prompt", v)
	}
}

func TestOutputDoneDeadlineAndTick(t *testing.T) {
	o, now := statusOutput()
	t0 := *now
	o.Feed([]byte(working + codexPong))
	o.TakeStatus()
	d, ok := o.NextDeadline()
	if !ok || !d.Equal(t0.Add(1500*time.Millisecond)) {
		t.Fatalf("deadline %v, %v", d, ok)
	}
	o.Tick(t0.Add(time.Second))
	if o.HasStatus() {
		t.Fatal("notified before the deadline")
	}
	o.Tick(d)
	_, notes := o.TakeStatus()
	if want := []status.Notification{{Kind: status.NotifyDone, Msg: "pong"}}; !slices.Equal(notes, want) {
		t.Fatalf("notes %v", notes)
	}
	if _, ok := o.NextDeadline(); ok {
		t.Fatal("deadline after the notification")
	}
}

func TestOutputClearStatus(t *testing.T) {
	o, _ := statusOutput()
	o.Feed([]byte("\x1b]7501;state=error:msg=" + base64.StdEncoding.EncodeToString([]byte("boom")) + "\x07"))
	o.ClearStatus()
	if v, unread := o.View(); v != (status.View{}) || unread {
		t.Fatalf("view %+v unread %v", v, unread)
	}
	if changed, notes := o.TakeStatus(); changed || len(notes) != 0 {
		t.Fatalf("changed %v, notes %v", changed, notes)
	}
	if _, ok := o.NextDeadline(); ok {
		t.Fatal("deadline after ClearStatus")
	}
}

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

func TestOutputReplaceScannerKeepsStatusSink(t *testing.T) {
	o := NewOutput()
	o.ReplaceScanner()
	o.Feed([]byte("\x1b]7501;state=idle\x07"))
	if n := len(o.Status().Records); n != 1 {
		t.Fatalf("%d records", n)
	}
}

func TestOutputAppChange(t *testing.T) {
	const idleClaude = "\x1b]7501;state=idle:app=claude-code\x07"
	o, _ := statusOutput()
	if o.App() != "" || o.NeedsDrain() {
		t.Fatalf("app %q, drain %v before any output", o.App(), o.NeedsDrain())
	}
	o.Feed([]byte(idleClaude))
	if o.App() != "claude-code" || !o.NeedsDrain() {
		t.Fatalf("app %q, drain %v after a report", o.App(), o.NeedsDrain())
	}
	if !o.TakeAppChange() || o.NeedsDrain() || o.TakeAppChange() {
		t.Fatal("the change was not taken exactly once")
	}
	o.Feed([]byte(idleClaude))
	if o.NeedsDrain() || o.TakeAppChange() {
		t.Fatal("the same app counted as a change")
	}
	o.Feed([]byte("\x1b]7501;id=sub:state=idle:app=codex\x07"))
	if o.App() != "claude-code" || o.NeedsDrain() {
		t.Fatalf("a child report changed app to %q, drain %v", o.App(), o.NeedsDrain())
	}
	o.Feed([]byte("\x1bc"))
	if o.App() != "claude-code" {
		t.Fatalf("RIS changed app to %q", o.App())
	}
}

// An app change that moves no view still asks for a drain.
func TestOutputAppChangeWithoutViewChange(t *testing.T) {
	o, _ := statusOutput()
	o.Feed([]byte("\x1b]7501;state=working:app=claude-code\x07"))
	o.TakeStatus()
	o.TakeAppChange()
	o.Feed([]byte("\x1b]7501;state=working:app=codex\x07"))
	if o.App() != "codex" || !o.NeedsDrain() || !o.TakeAppChange() {
		t.Fatalf("app %q, drain %v", o.App(), o.NeedsDrain())
	}
	if changed, _ := o.TakeStatus(); changed {
		t.Fatal("the view changed")
	}
}
