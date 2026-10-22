package session

import (
	"encoding/base64"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/zeikar/vaquita/daemon/internal/status"
)

// withoutSink returns a copy of the scanner's state for comparison.
func (s *Scanner) withoutSink() Scanner {
	c := *s
	c.sink = nil
	return c
}

// FuzzScanner feeds the input whole, split at a fuzzed point, and one byte at
// a time. All three must report the same events, end in the same state and
// agree on the last boundary; the boundary must be a valid Ring.Append
// argument, no boundary may fall inside a valid UTF-8 character, and
// retention must stay bounded.
func FuzzScanner(f *testing.F) {
	for _, tc := range scannerCases {
		f.Add([]byte(tc.in), uint32(len(tc.in)/2))
	}
	// No seed reaches maxStringLen: the engine minimizes new inputs by
	// dropping bytes one at a time, which at that size stalls fuzzing for
	// longer than a typical run. The unit tests cover abandonment.
	f.Add([]byte("\x1b]7501;"+strings.Repeat("p", 5<<10)+"\x07"), uint32(maxOSCRetain))
	for _, s := range statusSeeds {
		f.Add([]byte(s), uint32(len(s)/2))
	}
	f.Add([]byte("\x1b["+strings.Repeat(" ", 200)+"m"), uint32(70))
	f.Add([]byte("\xff\x80\xc3(\xe3\x81a\xf0\xf0\x9f\x98\x80"), uint32(5))

	f.Fuzz(func(t *testing.T, in []byte, split uint32) {
		const maxRetained = maxOSCRetain + maxCSIRetain
		checkRetained := func(s *Scanner, at int) {
			if r := s.retained(); r > maxRetained {
				t.Fatalf("retained %d bytes after %d of input, want <= %d", r, at, maxRetained)
			}
		}

		var whole scanRecorder
		ws := NewScanner(&whole)
		wb := ws.Scan(in)
		if wb < -1 || wb > len(in) {
			t.Fatalf("boundary %d outside [-1, %d]", wb, len(in))
		}
		checkRetained(ws, len(in))

		k := int(split % uint32(len(in)+1))
		var halves scanRecorder
		hs := NewScanner(&halves)
		hb := hs.Scan(in[:k])
		checkRetained(hs, k)
		if b := hs.Scan(in[k:]); b >= 0 {
			hb = k + b
		}
		checkRetained(hs, len(in))

		// inRune marks offsets strictly inside a character that decodes as
		// valid. It is only checked on inputs too short to reach
		// maxStringLen: abandoning a string drops the byte past the cap,
		// which may be a lead byte whose continuation bytes then reach ground
		// state as strays.
		var inRune []bool
		if len(in) <= maxStringLen {
			inRune = make([]bool, len(in)+1)
			for j := 0; j < len(in); {
				_, n := utf8.DecodeRune(in[j:])
				for m := j + 1; m < j+n; m++ {
					inRune[m] = true
				}
				j += n
			}
		}

		var bytewise scanRecorder
		bs := NewScanner(&bytewise)
		bb := bs.Scan(in[:0])
		for i := range in {
			if b := bs.Scan(in[i : i+1]); b >= 0 {
				bb = i + b
			}
			checkRetained(bs, i+1)
			if inRune != nil && inRune[i+1] && bs.AtBoundary() {
				t.Fatalf("boundary %d is inside the character at %q", i+1, in[max(0, i-3):min(len(in), i+4)])
			}
		}

		for _, feed := range []struct {
			name     string
			s        *Scanner
			rec      *scanRecorder
			boundary int
		}{{"split", hs, &halves, hb}, {"bytewise", bs, &bytewise, bb}} {
			if feed.boundary != wb {
				t.Fatalf("%s (at %d): boundary %d, whole %d", feed.name, k, feed.boundary, wb)
			}
			if !slices.Equal(feed.rec.events, whole.events) {
				t.Fatalf("%s (at %d): events %v, whole %v", feed.name, k, feed.rec.events, whole.events)
			}
			if feed.s.withoutSink() != ws.withoutSink() {
				t.Fatalf("%s (at %d): final state %d/%d, whole %d/%d", feed.name, k,
					feed.s.state, feed.s.utf8Pending, ws.state, ws.utf8Pending)
			}
		}
	})
}

// statusSeeds are status sequences as real agents emit them.
var statusSeeds = []string{
	"\x1b]7501;state=working:app=claude-code:msg=" + base64.StdEncoding.EncodeToString([]byte("Reading files")) + "\x07",
	"\x1b]7501;state=blocked:kind=permission:id=sub/1:title=VGl0bGU\x1b\\",
	"\x1b]7501;state=clear\x07\x1b]7501;?\x07\x1b]7501;state=idle:progress=50:progress=x\x07",
	"\x1b]777;notify;Claude Code;Claude needs your permission\x07",
	"\x1b]9;Approval requested: rm -rf build\x1b\\",
	"\x1b]133;A\x07\x1bc",
}

// FuzzOutput feeds arbitrary bytes through the real Output sink in two reads
// and checks that nothing panics and what it stores stays bounded.
func FuzzOutput(f *testing.F) {
	for _, s := range statusSeeds {
		f.Add([]byte(s), uint32(len(s)/2))
	}
	f.Add([]byte("\x1b]7501;state=working:id=a/b/c\x07\x1b]7501;state=clear:id=a\x07"), uint32(10))
	f.Fuzz(func(t *testing.T, in []byte, split uint32) {
		o := NewOutput()
		k := int(split % uint32(len(in)+1))
		o.Feed(in[:k])
		o.Feed(in[k:])
		st := o.Status()
		// An OSC 9 body is cut to 2048 bytes before invalid UTF-8 is replaced
		// by the 3-byte U+FFFD, which at most doubles it.
		_, notes := o.TakeStatus()
		if len(st.Records) > status.MaxRecords || len(st.View.Msg) > 2*2048 || len(notes) > status.MaxPendingNotes {
			t.Fatalf("%d records, view msg %d bytes, %d notifications", len(st.Records), len(st.View.Msg), len(notes))
		}
	})
}
