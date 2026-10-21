package session

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

// retained reports how many bytes the scanner holds for the sequence in
// progress.
func (s *Scanner) retained() int {
	switch s.state {
	case scanCSI:
		return s.csiLen
	case scanOSC, scanOSCEsc:
		return s.oscLen
	}
	return 0
}

type scanEvent struct {
	kind          byte   // 'O'SC, 'C'SI or 'E'SC
	num           int    // OSC number
	data          string // OSC payload or CSI parameters
	intermediates string
	final         byte
	oversized     bool
}

func (e scanEvent) String() string {
	switch e.kind {
	case 'O':
		return fmt.Sprintf("OSC(%d, %q, %v)", e.num, e.data, e.oversized)
	case 'C':
		return fmt.Sprintf("CSI(%q, %q, %q)", e.data, e.intermediates, e.final)
	}
	return fmt.Sprintf("ESC(%q)", e.final)
}

func oscEv(num int, payload string) scanEvent {
	return scanEvent{kind: 'O', num: num, data: payload}
}

func csiEv(params, intermediates string, final byte) scanEvent {
	return scanEvent{kind: 'C', data: params, intermediates: intermediates, final: final}
}

func escEv(final byte) scanEvent { return scanEvent{kind: 'E', final: final} }

// scanRecorder copies every event, since the slices are only valid during
// the callback.
type scanRecorder struct{ events []scanEvent }

func (r *scanRecorder) OSC(num int, payload []byte, oversized bool) {
	r.events = append(r.events, scanEvent{kind: 'O', num: num, data: string(payload), oversized: oversized})
}

func (r *scanRecorder) CSI(params, intermediates []byte, final byte) {
	r.events = append(r.events, csiEv(string(params), string(intermediates), final))
}

func (r *scanRecorder) ESC(final byte) { r.events = append(r.events, escEv(final)) }

var scannerCases = []struct {
	name   string
	in     string
	events []scanEvent
	// boundaries lists every offset in [0, len(in)] at which a fresh
	// scanner fed in[:offset] is AtBoundary.
	boundaries []int
}{
	{"DA1", "\x1b[c", []scanEvent{csiEv("", "", 'c')}, []int{0, 3}},
	{"DA1 with zero", "\x1b[0c", []scanEvent{csiEv("0", "", 'c')}, []int{0, 4}},
	{"DA2", "\x1b[>c", []scanEvent{csiEv(">", "", 'c')}, []int{0, 4}},
	{"alternate screen", "\x1b[?1049h", []scanEvent{csiEv("?1049", "", 'h')}, []int{0, 8}},
	{"SGR between text", "a\x1b[1;31mb", []scanEvent{csiEv("1;31", "", 'm')}, []int{0, 1, 8, 9}},
	{"cursor style intermediate", "\x1b[2 q", []scanEvent{csiEv("2", " ", 'q')}, []int{0, 5}},
	{"soft reset", "\x1b[!p", []scanEvent{csiEv("", "!", 'p')}, []int{0, 4}},
	{"keyboard flags push", "\x1b[>7u", []scanEvent{csiEv(">7", "", 'u')}, []int{0, 5}},
	{"keyboard flags set", "\x1b[=1;2u", []scanEvent{csiEv("=1;2", "", 'u')}, []int{0, 7}},
	{"parameter after intermediate", "\x1b[ 2q", nil, []int{0, 5}},
	{"C0 inside CSI", "\x1b[1\n2m", []scanEvent{csiEv("12", "", 'm')}, []int{0, 6}},
	{"DEL inside CSI", "\x1b[1\x7fm", []scanEvent{csiEv("1", "", 'm')}, []int{0, 5}},
	{"ESC aborts CSI", "\x1b[1\x1bc", []scanEvent{escEv('c')}, []int{0, 5}},
	{"UTF-8 inside CSI", "\x1b[?1\xc3\xa9049h", nil, []int{0, 10}},
	{"UTF-8 after ESC", "\x1b\xc3\xa9c", nil, []int{0, 3, 4}},
	{"UTF-8 after ESC intermediate", "\x1b(\xc3\xa9B", nil, []int{0, 4, 5}},
	{"OSC 11 query BEL", "\x1b]11;?\x07", []scanEvent{oscEv(11, "?")}, []int{0, 7}},
	{"OSC 11 query ST", "\x1b]11;?\x1b\\", []scanEvent{oscEv(11, "?")}, []int{0, 8}},
	{"OSC 7501 report", "\x1b]7501;{\"state\":\"busy\"}\x07", []scanEvent{oscEv(7501, `{"state":"busy"}`)}, []int{0, 24}},
	{"OSC without number", "\x1b]abc\x07", []scanEvent{oscEv(-1, "abc")}, []int{0, 6}},
	{"OSC number only", "\x1b]112\x07", []scanEvent{oscEv(112, "")}, []int{0, 6}},
	{"OSC empty", "\x1b]\x07", []scanEvent{oscEv(-1, "")}, []int{0, 3}},
	{"OSC 9-digit number", "\x1b]123456789;x\x07", []scanEvent{oscEv(123456789, "x")}, []int{0, 14}},
	{"OSC 10-digit number", "\x1b]1234567890;x\x07", []scanEvent{oscEv(-1, "1234567890;x")}, []int{0, 15}},
	{"OSC ignores C0", "\x1b]0;a\nb\x07", []scanEvent{oscEv(0, "ab")}, []int{0, 8}},
	{"OSC UTF-8 title", "\x1b]2;한\x07", []scanEvent{oscEv(2, "한")}, []int{0, 8}},
	{"DCS", "\x1bP1$r0m\x1b\\x", nil, []int{0, 9, 10}},
	{"BEL does not end DCS", "\x1bPq\x07x\x1b\\y", nil, []int{0, 7, 8}},
	{"APC", "\x1b_Gi=1;AAAA\x1b\\", nil, []int{0, 13}},
	{"RIS", "\x1bc", []scanEvent{escEv('c')}, []int{0, 2}},
	{"stray ST", "\x1b\\", []scanEvent{escEv('\\')}, []int{0, 2}},
	{"charset designation", "\x1b(Bx", nil, []int{0, 3, 4}},
	{"ESC ESC", "\x1b\x1b[c", []scanEvent{csiEv("", "", 'c')}, []int{0, 4}},
	{"ESC after intermediate", "\x1b(\x1b[c", []scanEvent{csiEv("", "", 'c')}, []int{0, 5}},
	{"4-byte UTF-8", "a\U0001F600b", nil, []int{0, 1, 5, 6}},
	{"Korean", "한글", nil, []int{0, 3, 6}},
	{"CAN aborts CSI", "\x1b[12\x18x", nil, []int{0, 5, 6}},
	{"SUB aborts OSC", "\x1b]0;t\x1ax", nil, []int{0, 6, 7}},
	{"CAN aborts ESC", "\x1b\x18c", nil, []int{0, 2, 3}},
	{"ESC in OSC", "\x1b]0;ti\x1b[1mx", []scanEvent{csiEv("1", "", 'm')}, []int{0, 10, 11}},
	{"ESC in DCS", "\x1bPq\x1bc", []scanEvent{escEv('c')}, []int{0, 5}},
	{"UTF-8 cut by ESC", "\xea\xb0\x1b[c", []scanEvent{csiEv("", "", 'c')}, []int{0, 5}},
}

func TestScannerSequences(t *testing.T) {
	for _, tc := range scannerCases {
		t.Run(tc.name, func(t *testing.T) {
			in := []byte(tc.in)
			isBoundary := make([]bool, len(in)+1)
			for _, b := range tc.boundaries {
				isBoundary[b] = true
			}

			var whole scanRecorder
			s := NewScanner(&whole)
			if got, want := s.Scan(in), slices.Max(tc.boundaries); got != want {
				t.Errorf("whole: boundary %d, want %d", got, want)
			}
			if !slices.Equal(whole.events, tc.events) {
				t.Errorf("whole: events %v, want %v", whole.events, tc.events)
			}

			var bytewise scanRecorder
			s = NewScanner(&bytewise)
			for i := range in {
				want := -1
				switch {
				case isBoundary[i+1]:
					want = 1
				case isBoundary[i]:
					want = 0
				}
				if got := s.Scan(in[i : i+1]); got != want {
					t.Errorf("byte %d (%q): boundary %d, want %d", i, in[i], got, want)
				}
			}
			if !slices.Equal(bytewise.events, tc.events) {
				t.Errorf("bytewise: events %v, want %v", bytewise.events, tc.events)
			}
		})
	}
}

func TestScannerUnterminatedOSCThenText(t *testing.T) {
	var rec scanRecorder
	s := NewScanner(&rec)
	s.Scan([]byte("\x1b]0;" + strings.Repeat("x", 70<<10)))
	for _, c := range []byte("abc") {
		if got := s.Scan([]byte{c}); got != 1 {
			t.Fatalf("%q: boundary %d, want 1 (ground before and after)", c, got)
		}
	}
	if len(rec.events) != 0 {
		t.Fatalf("events %v, want none", rec.events)
	}
}

func TestScannerStringLengthCap(t *testing.T) {
	for _, intro := range []string{"\x1b]", "\x1bP", "\x1bX", "\x1b^", "\x1b_"} {
		t.Run(fmt.Sprintf("%q", intro), func(t *testing.T) {
			var rec scanRecorder
			s := NewScanner(&rec)
			atCap := []byte(intro + "0;" + strings.Repeat("x", maxStringLen-2))
			if got := s.Scan(atCap); got != 0 {
				t.Fatalf("string at the cap: boundary %d, want 0 (still open)", got)
			}
			if got := s.Scan([]byte("x")); got != 1 {
				t.Fatalf("byte past the cap: boundary %d, want 1 (abandoned)", got)
			}
			// What remains of the abandoned string is ordinary output.
			rest := []byte("abc\x1b[c")
			if got := s.Scan(rest); got != len(rest) {
				t.Fatalf("after abandoning: boundary %d, want %d", got, len(rest))
			}
			if want := []scanEvent{csiEv("", "", 'c')}; !slices.Equal(rec.events, want) {
				t.Fatalf("events %v, want %v", rec.events, want)
			}
		})
	}

	// A terminated OSC exactly at the cap is still reported.
	var rec scanRecorder
	s := NewScanner(&rec)
	s.Scan([]byte("\x1b]0;" + strings.Repeat("x", maxStringLen-2) + "\x07"))
	if len(rec.events) != 1 || rec.events[0].num != 0 || !rec.events[0].oversized {
		t.Fatalf("events %v, want one oversized OSC 0", rec.events)
	}
}

func TestScannerOversizedOSC(t *testing.T) {
	const prefix = "7501;"
	payload := strings.Repeat("p", 5<<10)
	for _, tc := range []struct {
		n         int // length of the OSC string
		oversized bool
	}{
		{maxOSCRetain, false},
		{maxOSCRetain + 1, true},
		{len(prefix) + len(payload), true},
	} {
		var rec scanRecorder
		s := NewScanner(&rec)
		str := prefix + payload[:tc.n-len(prefix)]
		s.Scan([]byte("\x1b]" + str))
		if got := s.retained(); got != min(tc.n, maxOSCRetain) {
			t.Errorf("%d bytes: retained %d", tc.n, got)
		}
		s.Scan([]byte("\x1b\\"))
		want := []scanEvent{{kind: 'O', num: 7501, data: payload[:min(tc.n, maxOSCRetain)-len(prefix)], oversized: tc.oversized}}
		if !slices.Equal(rec.events, want) {
			t.Errorf("%d bytes: events %v, want %v", tc.n, rec.events, want)
		}
		if got := s.retained(); got != 0 {
			t.Errorf("%d bytes: retained %d after the terminator", tc.n, got)
		}
	}
}

func TestScannerLongCSIIgnored(t *testing.T) {
	var rec scanRecorder
	s := NewScanner(&rec)
	s.Scan([]byte("\x1b[" + strings.Repeat(" ", 200)))
	if got := s.retained(); got > maxCSIRetain {
		t.Fatalf("retained %d, want <= %d", got, maxCSIRetain)
	}
	if got := s.Scan([]byte("m")); got != 1 {
		t.Fatalf("final byte: boundary %d, want 1", got)
	}
	if len(rec.events) != 0 {
		t.Fatalf("events %v, want none", rec.events)
	}

	params := strings.Repeat("1", maxCSIRetain)
	s.Scan([]byte("\x1b[" + params + "m"))      // at the cap: reported
	s.Scan([]byte("\x1b[" + params + "1m"))     // one past: ignored
	s.Scan([]byte("\x1b[" + params[1:] + " m")) // the cap counts intermediates too
	s.Scan([]byte("\x1b[" + params + " m"))
	want := []scanEvent{csiEv(params, "", 'm'), csiEv(params[1:], " ", 'm')}
	if !slices.Equal(rec.events, want) {
		t.Fatalf("events %v, want %v", rec.events, want)
	}
}

func TestScannerInvalidUTF8DoesNotStall(t *testing.T) {
	for _, bad := range []string{
		"\xff", "\xc0\xaf", "\x80\x80\x80", "\xc3", "\xe3\x81", "\xf0\x9f\x98",
		"\xed\xa0\x80", "\xe0\x80", "\xf0\xf0\xf0", "\xf4\x90\x80\x80",
	} {
		var rec scanRecorder
		s := NewScanner(&rec)
		in := []byte(bad + "a")
		if got := s.Scan(in); got != len(in) {
			t.Errorf("%q: boundary %d, want %d", in, got, len(in))
		}
	}
}
