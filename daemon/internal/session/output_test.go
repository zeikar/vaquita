package session

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
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

func TestOutputNotifications(t *testing.T) {
	o := NewOutput()
	if o.Status().LastNotify != nil {
		t.Fatal("notification before any output")
	}
	o.Feed([]byte("\x1b]777;notify;Claude Code;Claude needs your permission\x07"))
	o.Feed([]byte("\x1b]777;precmd\x07"))
	st := o.Status()
	if st.LastNotify == nil || st.LastNotify.Title != "Claude Code" || len(st.Recent) != 1 {
		t.Fatalf("status %+v", st)
	}
	for i := 0; i < 20; i++ {
		o.Feed([]byte(fmt.Sprintf("\x1b]9;n%d\x1b\\", i)))
	}
	st = o.Status()
	if len(st.Recent) != maxRecentNotifies || st.Recent[0].Body != "n4" || st.LastNotify.Body != "n19" {
		t.Fatalf("recent %d, first %q, last %+v", len(st.Recent), st.Recent[0].Body, st.LastNotify)
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
