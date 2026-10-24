package session

import (
	"encoding/base64"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/status"
)

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

func TestOutputReplaceScannerKeepsStatusSink(t *testing.T) {
	o := NewOutput()
	o.ReplaceScanner()
	o.Feed([]byte("\x1b]7501;state=idle\x07"))
	if n := len(o.Status().Records); n != 1 {
		t.Fatalf("%d records", n)
	}
}

func TestOutputAppChange(t *testing.T) {
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
