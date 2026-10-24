package session

import (
	"strings"
	"testing"
)

func TestNormalizeTitle(t *testing.T) {
	for in, want := range map[string]string{
		"Pong reply":       "Pong reply",
		"⠋ my-folder":      "my-folder",
		"✳ Claude Code":    "Claude Code",
		"  · ✶ Fix tests ": "Fix tests",
		"42 files":         "42 files",
		"한글 제목":            "한글 제목",
		"⠙ ⠙":              "",
		" ":                "",
	} {
		if got := normalizeTitle([]byte(in)); got != want {
			t.Errorf("normalizeTitle(%q) = %q, want %q", in, got, want)
		}
	}
}

const (
	idleClaude = "\x1b]7501;state=idle:app=claude-code\x07"
	clearAgent = "\x1b]7501;state=clear\x07"
)

// claudeOutput returns an Output that claude-code has reported to, with the
// app change taken.
func claudeOutput(t *testing.T) *Output {
	t.Helper()
	o, _ := statusOutput()
	o.Feed([]byte(idleClaude))
	o.TakeStatus()
	if !o.TakeAppChange() || o.NeedsDrain() {
		t.Fatal("the report left something to drain besides the app change")
	}
	return o
}

// checkTitle fails unless o keeps title and has a change to take exactly when
// changed is set, and no title dropped.
func checkTitle(t *testing.T, o *Output, title string, changed bool) {
	t.Helper()
	drain := o.NeedsDrain()
	c, dropped := o.TakeTitleChange()
	again, _ := o.TakeTitleChange()
	if o.Title() != title || drain != changed || c != changed || dropped || again {
		t.Fatalf("title %q, drain %v, change %v, dropped %v; want %q with a change %v taken once", o.Title(), drain, c, dropped, title, changed)
	}
}

func TestOutputTitleFromClaude(t *testing.T) {
	for _, seq := range []string{
		"\x1b]0;Pong reply\x07",
		"\x1b]0;Pong reply\x1b\\",
		"\x1b]2;✳ Pong reply\x07",
		"\x1b]2;Pong reply \x1b\\",
	} {
		o := claudeOutput(t)
		o.Feed([]byte(seq))
		checkTitle(t, o, "Pong reply", true)
		// The same title again is no change.
		o.Feed([]byte(seq))
		checkTitle(t, o, "Pong reply", false)
	}
	o := claudeOutput(t)
	o.Feed([]byte("\x1b]0;Claude Code\x07\x1b]0;\x07\x1b]1;Icon\x07"))
	checkTitle(t, o, "Claude Code", true)
	o.Feed([]byte("\x1b]0;" + strings.Repeat("x", 5000) + "\x07"))
	checkTitle(t, o, "Claude Code", false)
}

const workingCodex = "\x1b]7501;state=working:app=codex\x07"

// codexOutput returns an Output whose session's command started codex with
// the session's options, as Start sets it, and that codex has reported to,
// with the app change taken.
func codexOutput(t *testing.T) *Output {
	t.Helper()
	o, _ := statusOutput()
	o.codexTitled = true
	o.Feed([]byte(workingCodex))
	o.TakeStatus()
	if !o.TakeAppChange() || o.NeedsDrain() {
		t.Fatal("the report left something to drain besides the app change")
	}
	return o
}

// The thread name of the codex the session's command started titles it as
// claude's topic does.
func TestOutputTitleFromCodex(t *testing.T) {
	o := codexOutput(t)
	o.Feed([]byte("\x1b]0;Reply pong\x07"))
	checkTitle(t, o, "Reply pong", true)
	o.Feed([]byte("\x1b]0;Reply pong\x07"))
	checkTitle(t, o, "Reply pong", false)
}

// A codex started without the session's options shows its folder behind
// spinner frames, before its first report too: none of it is a title.
func TestOutputTitleFromCodexWithoutOptions(t *testing.T) {
	o, _ := statusOutput()
	o.Feed([]byte("\x1b]0;⠋ my-folder\x07"))
	checkTitle(t, o, "my-folder", false)
	o.Feed([]byte(workingCodex))
	o.TakeStatus()
	o.TakeAppChange()
	checkTitle(t, o, "", false)
	for _, frame := range []string{"⠋", "⠙", "⠹"} {
		o.Feed([]byte("\x1b]0;" + frame + " my-folder\x07"))
		checkTitle(t, o, "", false)
	}
}

// Only the codex the session's command started has the session's options: once
// it has stopped, by its clear report or an interrupt, a codex typed into the
// shell after it titles nothing, although the app stays the same.
func TestOutputCodexTitlesEndWithItsCommand(t *testing.T) {
	for _, gone := range []string{clearAgent, "\x1b]133;A\x07"} {
		o := codexOutput(t)
		o.Feed([]byte("\x1b]0;Reply pong\x07"))
		o.TakeTitleChange()
		o.Feed([]byte(gone + workingCodex + "\x1b]0;⠋ other\x07\x1b]0;other\x07"))
		o.TakeStatus()
		if o.TakeAppChange() {
			t.Fatal("the same app counted as a change")
		}
		checkTitle(t, o, "Reply pong", false)
	}
}

// A title set before any app has reported is kept, to be taken with the app
// change.
func TestOutputTitleBeforeApp(t *testing.T) {
	o, _ := statusOutput()
	o.Feed([]byte("\x1b]0;Pong reply\x07"))
	checkTitle(t, o, "Pong reply", false)
	o.Feed([]byte(idleClaude))
	if !o.TakeAppChange() {
		t.Fatal("no app change")
	}
	checkTitle(t, o, "Pong reply", false)
}

// Once the agent has gone, by its clear report or an interrupt, titles are
// the shell's until it reports again.
func TestOutputTitleAfterAgentGone(t *testing.T) {
	for _, gone := range []string{clearAgent, "\x1b]133;A\x07"} {
		o := claudeOutput(t)
		o.Feed([]byte("\x1b]0;Pong reply\x07"))
		o.TakeTitleChange()
		o.Feed([]byte(gone + "\x1b]2;user@host: ~/src/example\x07"))
		o.TakeStatus()
		checkTitle(t, o, "Pong reply", false)
		o.Feed([]byte(idleClaude + "\x1b]0;Claude Code\x07"))
		o.TakeStatus()
		checkTitle(t, o, "Claude Code", true)
	}
}

// With a watch, a title counts as claude's only while its reporter holds the
// terminal: a shell that takes it back after a SIGKILL, which sends no clear,
// sets its own before the next poll finds the reporter gone.
func TestOutputTitleNeedsReporterInForeground(t *testing.T) {
	o, now := statusOutput()
	fg, alive := 42, true
	o.leader = 7
	o.Foreground = func() (int, error) { return fg, nil }
	o.GroupAlive = func(pgid int) bool { return alive && pgid == 42 }
	o.Feed([]byte(idleClaude + "\x1b]0;Pong reply\x07"))
	o.TakeStatus()
	o.TakeAppChange()
	// Arms the timer for the poll, due a second later.
	o.Tick(*now)
	checkTitle(t, o, "Pong reply", true)

	fg = 7
	o.Feed([]byte("\x1b]2;user@host: ~/src/example\x07"))
	checkTitle(t, o, "Pong reply", false)
	fg, alive = 42, false
	o.Feed([]byte("\x1b]2;user@host: ~/src/example\x07"))
	checkTitle(t, o, "Pong reply", false)
}

// A title belongs to the agent that set it: another app reporting drops it,
// and says so, so that neither the record nor an agent started later keeps
// it. The first app to report drops nothing.
func TestOutputTitleDroppedOnAgentSwitch(t *testing.T) {
	o := codexOutput(t)
	o.Feed([]byte("\x1b]0;Reply pong\x07"))
	if changed, dropped := o.TakeTitleChange(); !changed || dropped {
		t.Fatalf("change %v, dropped %v; want a change with nothing dropped", changed, dropped)
	}
	o.Feed([]byte(idleClaude + "\x1b]0;Claude Code\x07"))
	o.TakeStatus()
	if !o.TakeAppChange() {
		t.Fatal("no app change to claude")
	}
	if changed, dropped := o.TakeTitleChange(); o.Title() != "Claude Code" || !changed || !dropped {
		t.Fatalf("title %q, change %v, dropped %v; want claude's title, changed, with codex's dropped", o.Title(), changed, dropped)
	}
	o.Feed([]byte("\x1b]0;Pong reply\x07" + clearAgent + workingCodex))
	o.TakeStatus()
	if !o.TakeAppChange() {
		t.Fatal("no app change back to codex")
	}
	if changed, dropped := o.TakeTitleChange(); o.Title() != "" || !changed || !dropped {
		t.Fatalf("title %q, change %v, dropped %v; want claude's dropped", o.Title(), changed, dropped)
	}
}

// A report from another process group is another invocation, here a codex
// typed into the shell after the session's own was killed, before any poll
// found it gone: its folder titles change nothing.
func TestOutputCodexTitlesEndWithItsReporter(t *testing.T) {
	o, _ := statusOutput()
	fg := 42
	o.leader = 7
	o.codexTitled = true
	o.Foreground = func() (int, error) { return fg, nil }
	o.GroupAlive = func(pgid int) bool { return pgid == fg }
	o.Feed([]byte(workingCodex + "\x1b]0;Reply pong\x07"))
	o.TakeStatus()
	o.TakeAppChange()
	o.TakeTitleChange()

	fg = 43
	o.Feed([]byte(workingCodex + "\x1b]0;⠋ other\x07\x1b]0;other\x07"))
	o.TakeStatus()
	if o.reporter != 43 {
		t.Fatalf("reporter %d, want the new group", o.reporter)
	}
	if changed, _ := o.TakeTitleChange(); o.Title() != "Reply pong" || changed {
		t.Fatalf("title %q, change %v; want the first codex's kept", o.Title(), changed)
	}
}
