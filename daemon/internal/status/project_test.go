package status

import (
	"fmt"
	"math"
	"slices"
	"testing"
	"time"
)

// event is one input to a Projector at time now.
type event func(p *Projector, now time.Time)

func report(r Report) event  { return func(p *Projector, now time.Time) { p.Report(r, now) } }
func osc9(body string) event { return func(p *Projector, _ time.Time) { p.OSC9(body) } }

var (
	tick      event = (*Projector).Tick
	seen      event = func(p *Projector, _ time.Time) { p.Seen() }
	interrupt event = func(p *Projector, _ time.Time) { p.Interrupt() }
	clearAll  event = func(p *Projector, _ time.Time) { p.Clear() }
)

func cc(state string) Report { return Report{State: state, App: "claude-code"} }
func cx(state string) Report { return Report{State: state, App: "codex"} }

// step feeds ev at `at` seconds after the scenario's start, then expects the
// view, the unread flag, the notifications Take yields and the deadline in
// seconds after the start (0: none).
type step struct {
	at     float64
	ev     event
	view   View
	unread bool
	notes  []Notification
	due    float64
}

var base = time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)

// at rounds to milliseconds so that offsets added in float compare exactly.
func at(sec float64) time.Time {
	return base.Add(time.Duration(math.Round(sec*1000)) * time.Millisecond)
}

// run feeds steps to a new Projector. Take must report a change exactly when
// the view or the unread flag differs from the step before.
func run(t *testing.T, steps []step) {
	t.Helper()
	var p Projector
	var lastView View
	var lastUnread bool
	for i, s := range steps {
		now := at(s.at)
		s.ev(&p, now)
		view, unread := p.View()
		if view != s.view || unread != s.unread {
			t.Fatalf("step %d (%+.3f): view %+v unread %v, want %+v unread %v", i, s.at, view, unread, s.view, s.unread)
		}
		changed, notes := p.Take()
		if want := view != lastView || unread != lastUnread; changed != want {
			t.Fatalf("step %d (%+.3f): changed %v, want %v", i, s.at, changed, want)
		}
		if !slices.Equal(notes, s.notes) {
			t.Fatalf("step %d (%+.3f): notes %+v, want %+v", i, s.at, notes, s.notes)
		}
		d, ok := p.Deadline()
		if s.due == 0 && ok {
			t.Fatalf("step %d (%+.3f): deadline %v, want none", i, s.at, d.Sub(base))
		}
		if s.due != 0 && (!ok || !d.Equal(at(s.due))) {
			t.Fatalf("step %d (%+.3f): deadline %v %v, want %+.3fs", i, s.at, d.Sub(base), ok, s.due)
		}
		lastView, lastUnread = view, unread
	}
}

var (
	none    = View{}
	working = View{State: ViewWorking}
)

func input(kind, msg string) View { return View{State: ViewInput, Kind: kind, Msg: msg} }
func done(msg string) View        { return View{State: ViewDone, Msg: msg} }
func note(kind, msg string) []Notification {
	return []Notification{{Kind: kind, Msg: msg}}
}

// TestProjectorRecordings replays the recorded sessions of Claude Code 2.1.308
// and Codex 0.163.0, with the offsets from each scenario's input.
func TestProjectorRecordings(t *testing.T) {
	const (
		summary   = `replied "pong" as requested`
		bash      = "approve Bash: touch probe.txt"
		write     = "approve Write: /tmp/repo/probe2.txt"
		tea       = "answer: Do you prefer tea or coffee? (Tea · Coffee)"
		approval  = "Approval requested: /bin/zsh -lc 'touch probe.txt'"
		implement = "Plan mode prompt: Implement this plan?"
		newline   = "Plan mode prompt: Newline"
		answer    = "Yes—`hello.txt` should end with a newline."
		question  = "Question: Tea or coffee?"
	)
	prompted := []step{
		{0.686, report(cx("working")), working, false, nil, 0},
		{5.147, osc9(implement), working, false, nil, 0},
		{5.147, report(cx("idle")), input("", implement), false, note(NotifyInput, implement), 0},
	}
	tests := []struct {
		name  string
		steps []step
	}{
		{"claude turn", []step{
			{-3.157, report(cc("idle")), none, false, nil, 0},
			{0.491, report(cc("working")), working, false, nil, 0},
			{4.114, report(cc("done")), done(""), true, nil, 7.114},
			{6.668, report(Report{State: "done", App: "claude-code", Msg: summary}), done(summary), true, note(NotifyDone, summary), 0},
			{7.114, tick, done(summary), true, nil, 0},
		}},
		{"claude bash permission", []step{
			{0.414, report(cc("working")), working, false, nil, 0},
			{2.050, report(Report{State: "blocked", Kind: "permission", Msg: bash, App: "claude-code"}), input("permission", bash), false, note(NotifyInput, bash), 0},
			{4.163, report(cc("idle")), none, false, nil, 0},
		}},
		{"claude write permission", []step{
			{0.468, report(cc("working")), working, false, nil, 0},
			{2.877, report(Report{State: "blocked", Kind: "permission", Msg: write, App: "claude-code"}), input("permission", write), false, note(NotifyInput, write), 0},
			{4.011, report(cc("idle")), none, false, nil, 0},
		}},
		{"claude question", []step{
			{0.432, report(cc("working")), working, false, nil, 0},
			{1.937, report(Report{State: "blocked", Kind: "question", Msg: tea, App: "claude-code"}), input("question", tea), false, note(NotifyInput, tea), 0},
			{3.066, report(cc("idle")), none, false, nil, 0},
		}},
		{"claude esc-cancel", []step{
			{0.454, report(cc("working")), working, false, nil, 0},
			{2.105, report(cc("idle")), none, false, nil, 0},
		}},
		{"claude exit", []step{
			{0.941, report(cc("working")), working, false, nil, 0},
			{0.949, report(Report{State: "clear"}), none, false, nil, 0},
			{0.952, report(Report{State: "clear"}), none, false, nil, 0},
			{0.953, report(Report{State: "clear"}), none, false, nil, 0},
		}},
		{"codex start", []step{
			{1.605, report(cx("idle")), none, false, nil, 0},
			{1.698, report(cx("working")), working, false, nil, 0},
			{2.638, report(cx("idle")), none, false, nil, 0},
		}},
		{"codex turn without OSC 9", []step{
			{0.565, report(cx("working")), working, false, nil, 0},
			{2.487, report(cx("idle")), none, false, nil, 0},
		}},
		{"codex approval without OSC 9", []step{
			{0.427, report(cx("working")), working, false, nil, 0},
			{2.164, report(cx("blocked")), input("", ""), false, note(NotifyInput, ""), 0},
			{4.176, report(cx("working")), working, false, nil, 0},
			{4.217, report(cx("idle")), none, false, nil, 0},
		}},
		{"codex exit", []step{
			{0.021, report(Report{State: "clear"}), none, false, nil, 0},
		}},
		{"codex-notify turn", []step{
			{0.763, report(cx("working")), working, false, nil, 0},
			{2.459, osc9("pong"), working, false, nil, 0},
			{2.459, report(cx("idle")), done("pong"), true, nil, 3.959},
			{3.959, tick, done("pong"), true, note(NotifyDone, "pong"), 0},
		}},
		{"codex-notify approval", []step{
			{0.443, report(cx("working")), working, false, nil, 0},
			{2.368, osc9(approval), working, false, nil, 0},
			{2.368, report(cx("blocked")), input("", approval), false, note(NotifyInput, approval), 0},
			{4.380, report(cx("working")), working, false, nil, 0},
			{4.412, report(cx("idle")), none, false, nil, 0},
		}},
		// Esc on the popup at +7.189 sends no report.
		{"codex-plan prompt released by seen", append(slices.Clone(prompted),
			step{7.189, seen, none, false, nil, 0},
		)},
		{"codex-plan prompt released by working", append(slices.Clone(prompted),
			step{9.000, report(cx("working")), working, false, nil, 0},
			step{9.500, seen, working, false, nil, 0},
		)},
		{"codex-plan prompt released by clear", append(slices.Clone(prompted),
			step{9.000, report(Report{State: "clear"}), none, false, nil, 0},
		)},
		{"codex-plan question", []step{
			{0.430, report(cx("working")), working, false, nil, 0},
			{2.235, osc9(newline), working, false, nil, 0},
			{2.235, report(cx("blocked")), input("", newline), false, note(NotifyInput, newline), 0},
			{4.288, report(cx("working")), working, false, nil, 0},
			{6.127, osc9(answer), working, false, nil, 0},
			{6.127, report(cx("idle")), done(answer), true, nil, 7.627},
			{7.627, tick, done(answer), true, note(NotifyDone, answer), 0},
		}},
		{"codex-question", []step{
			{0.573, report(cx("working")), working, false, nil, 0},
			{2.805, osc9(question), working, false, nil, 0},
			{2.805, report(cx("blocked")), input("", question), false, note(NotifyInput, question), 0},
			{5.917, report(cx("working")), working, false, nil, 0},
			{7.754, osc9("Tea"), working, false, nil, 0},
			{7.754, report(cx("idle")), done("Tea"), true, nil, 9.254},
			{9.254, tick, done("Tea"), true, note(NotifyDone, "Tea"), 0},
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { run(t, tc.steps) })
	}
}

func TestProjectorRules(t *testing.T) {
	failed := View{State: ViewError, Msg: "boom"}
	tests := []struct {
		name  string
		steps []step
	}{
		{"working within the quiet period cancels the done", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, report(Report{State: "done", Msg: "m"}), done("m"), true, nil, 2.5},
			{2.0, report(cc("working")), working, false, nil, 0},
			{2.5, tick, working, false, nil, 0},
		}},
		{"working after the quiet period raises the due done first", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, report(Report{State: "done", Msg: "m"}), done("m"), true, nil, 2.5},
			{2.6, report(cc("working")), working, false, note(NotifyDone, "m"), 0},
		}},
		{"done without a msg waits for one", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, report(cc("done")), done(""), true, nil, 4.0},
			{2.5, tick, done(""), true, nil, 4.0},
			{4.0, tick, done(""), true, note(NotifyDone, ""), 0},
		}},
		{"msg within the quiet period is notified at its end", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, report(cc("done")), done(""), true, nil, 4.0},
			{2.0, report(Report{State: "done", Msg: "m"}), done("m"), true, nil, 2.5},
			{2.5, tick, done("m"), true, note(NotifyDone, "m"), 0},
		}},
		{"done after done updates the msg only", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, report(Report{State: "done", Msg: "a"}), done("a"), true, nil, 2.5},
			{2.5, tick, done("a"), true, note(NotifyDone, "a"), 0},
			{3.0, report(Report{State: "done", Msg: "b"}), done("b"), true, nil, 0},
			{4.0, report(cc("done")), done("b"), true, nil, 0},
			{5.0, seen, done("b"), false, nil, 0},
			{6.0, report(Report{State: "done", Msg: "c"}), done("c"), false, nil, 0},
		}},
		{"done without a working is not notified", []step{
			{0, report(cc("done")), done(""), true, nil, 0},
		}},
		{"a done after an interrupt is not notified", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, interrupt, none, false, nil, 0},
			{2.0, report(Report{State: "done", Msg: "m"}), done("m"), true, nil, 0},
		}},
		{"a done after a clear is not notified", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, clearAll, none, false, nil, 0},
			{2.0, report(Report{State: "done", Msg: "m"}), done("m"), true, nil, 0},
		}},
		{"a done after an error is not notified", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, report(Report{State: "error", Msg: "boom"}), failed, true, note(NotifyError, "boom"), 0},
			{2.0, report(Report{State: "done", Msg: "m"}), done("m"), true, nil, 0},
		}},
		{"done survives idle", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, report(Report{State: "done", Msg: "m"}), done("m"), true, nil, 2.5},
			{1.2, report(cc("idle")), done("m"), true, nil, 2.5},
			{2.5, tick, done("m"), true, note(NotifyDone, "m"), 0},
		}},
		{"error notifies at once and survives idle", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, report(Report{State: "error", Msg: "boom"}), failed, true, note(NotifyError, "boom"), 0},
			{2.0, report(cc("idle")), failed, true, nil, 0},
		}},
		{"auth", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, report(Report{State: "blocked", Kind: "auth", Msg: "log in"}), View{State: ViewAuth, Msg: "log in"}, false, note(NotifyAuth, "log in"), 0},
		}},
		{"seen keeps a reported input", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, report(Report{State: "blocked", Kind: "question", Msg: "q"}), input("question", "q"), false, note(NotifyInput, "q"), 0},
			{2.0, seen, input("question", "q"), false, nil, 0},
		}},
		{"interrupt clears working and keeps done", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, interrupt, none, false, nil, 0},
			{2.0, report(cc("working")), working, false, nil, 0},
			{3.0, report(Report{State: "done", Msg: "m"}), done("m"), true, nil, 4.5},
			{3.5, interrupt, done("m"), true, nil, 4.5},
			{4.5, tick, done("m"), true, note(NotifyDone, "m"), 0},
		}},
		{"interrupt drops the OSC 9", []step{
			{0, report(cx("working")), working, false, nil, 0},
			{1.0, osc9("pong"), working, false, nil, 0},
			{1.0, interrupt, none, false, nil, 0},
			{1.1, report(cx("idle")), none, false, nil, 0},
		}},
		{"clear drops the done notification", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, report(Report{State: "done", Msg: "m"}), done("m"), true, nil, 2.5},
			{2.0, clearAll, none, false, nil, 0},
			{2.5, tick, none, false, nil, 0},
		}},
		{"stale OSC 9 before a Claude idle is ignored", []step{
			{0, report(cc("working")), working, false, nil, 0},
			{1.0, osc9("pong"), working, false, nil, 0},
			{1.0, report(cc("idle")), none, false, nil, 0},
			// The idle consumed it.
			{2.0, report(cx("idle")), none, false, nil, 0},
		}},
		{"Codex's OSC 9 overrides its own blocked msg", []step{
			{0, osc9("Approval requested: ls"), none, false, nil, 0},
			{0, report(Report{State: "blocked", App: "codex", Msg: "own"}), input("", "Approval requested: ls"), false, note(NotifyInput, "Approval requested: ls"), 0},
		}},
		{"a stale OSC 9 does not override Claude's blocked msg", []step{
			{0, osc9("stale"), none, false, nil, 0},
			{0, report(Report{State: "blocked", App: "claude-code", Kind: "permission", Msg: "own"}), input("permission", "own"), false, note(NotifyInput, "own"), 0},
		}},
		{"the OSC 9 fills another app's empty blocked msg", []step{
			{0, osc9("body"), none, false, nil, 0},
			{0, report(Report{State: "blocked", App: "other"}), input("", "body"), false, note(NotifyInput, "body"), 0},
		}},
		{"plan prompt ends the turn without a done", []step{
			{0, report(cx("working")), working, false, nil, 0},
			{1.0, osc9("Plan mode prompt: Implement this plan?"), working, false, nil, 0},
			{1.0, report(cx("idle")), input("", "Plan mode prompt: Implement this plan?"), false, note(NotifyInput, "Plan mode prompt: Implement this plan?"), 0},
			{2.0, osc9("pong"), input("", "Plan mode prompt: Implement this plan?"), false, nil, 0},
			{2.0, report(cx("idle")), done("pong"), true, nil, 0},
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { run(t, tc.steps) })
	}
}

func TestProjectorZeroValue(t *testing.T) {
	var p Projector
	if v, unread := p.View(); v != none || unread {
		t.Fatalf("view %+v unread %v", v, unread)
	}
	if changed, notes := p.Take(); changed || notes != nil {
		t.Fatalf("Take = %v, %+v", changed, notes)
	}
	if _, ok := p.Deadline(); ok {
		t.Fatal("deadline set")
	}
}

func TestProjectorKeepsNewestNotes(t *testing.T) {
	var p Projector
	for i := range 20 {
		p.Report(Report{State: "error", Msg: fmt.Sprint(i)}, base)
	}
	_, notes := p.Take()
	if len(notes) != MaxPendingNotes || notes[0].Msg != "4" || notes[len(notes)-1].Msg != "19" {
		t.Fatalf("%d notes: %+v", len(notes), notes)
	}
}
