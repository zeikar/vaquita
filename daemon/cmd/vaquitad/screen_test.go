package main

import (
	"bytes"
	"testing"
)

func newTestScreen() (*screen, *bytes.Buffer) {
	var buf bytes.Buffer
	return newScreen(&buf, NewFence()), &buf
}

func mustWrite(t *testing.T, s *screen, p string) {
	t.Helper()
	if err := s.write([]byte(p)); err != nil {
		t.Fatal(err)
	}
}

// liveFrame writes p as live output and reports whether the fence went in.
func liveFrame(t *testing.T, s *screen, p string) bool {
	t.Helper()
	fenced, err := s.live([]byte(p))
	if err != nil {
		t.Fatal(err)
	}
	return fenced
}

func TestScreenCountsPlainDA1(t *testing.T) {
	s, _ := newTestScreen()
	mustWrite(t, s, "\x1b[c\x1b[0c")
	// DA2, DA3 and private sequences ending in 'c' are not DA1, and their
	// replies do not look like one.
	mustWrite(t, s, "\x1b[>c\x1b[=c\x1b[?c\x1b[1c")
	if s.fence.queries != 2 {
		t.Errorf("queries = %d, want 2", s.fence.queries)
	}
}

func TestScreenFenceRightAwayAtBoundary(t *testing.T) {
	s, buf := newTestScreen()
	mustWrite(t, s, "prompt$ ")
	fenced, err := s.armFence()
	if err != nil || !fenced {
		t.Fatalf("armFence = %v, %v; want the fence written", fenced, err)
	}
	if got := buf.String(); got != "prompt$ \x1b[c" {
		t.Errorf("output = %q", got)
	}
	if s.fence.expected != 1 {
		t.Errorf("expected = %d, want 1", s.fence.expected)
	}
	// Nothing more is due.
	if liveFrame(t, s, "x") || buf.String() != "prompt$ \x1b[cx" {
		t.Errorf("output = %q after the fence", buf.String())
	}
}

// Output that stops inside a sequence gets the fence at the first boundary of
// the following live output: never inside the sequence.
func TestScreenFenceWaitsForBoundary(t *testing.T) {
	for _, tc := range []struct {
		name         string
		replay       string
		frames       []string
		want         string
		wantExpected uint64
	}{
		{
			name:   "CSI",
			replay: "a\x1b[3",
			frames: []string{"1mb"},
			want:   "a\x1b[31m\x1b[cb",
		},
		{
			// The DA1 that the frame completes is written, so counted,
			// before the fence.
			name:         "DA1 completed by the frame",
			replay:       "\x1b[",
			frames:       []string{"c\x1b[cz"},
			want:         "\x1b[c\x1b[c\x1b[cz",
			wantExpected: 2,
		},
		{
			name:   "UTF-8",
			replay: "caf\xc3",
			frames: []string{"\xa9!"},
			want:   "caf\xc3\xa9\x1b[c!",
		},
		{
			name:   "OSC over several frames",
			replay: "\x1b]0;ti",
			frames: []string{"tle", "\x07rest"},
			want:   "\x1b]0;title\x07\x1b[crest",
		},
		{
			name:   "frame ending at the boundary",
			replay: "\x1b",
			frames: []string{"[m", "next"},
			want:   "\x1b[m\x1b[cnext",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, buf := newTestScreen()
			mustWrite(t, s, tc.replay)
			if fenced, err := s.armFence(); err != nil || fenced {
				t.Fatalf("armFence = %v, %v; want it held back", fenced, err)
			}
			fences := 0
			for _, f := range tc.frames {
				if liveFrame(t, s, f) {
					fences++
				}
			}
			if fences != 1 {
				t.Errorf("fence written %d times, want once", fences)
			}
			if got := buf.String(); got != tc.want {
				t.Errorf("output = %q, want %q", got, tc.want)
			}
			want := max(tc.wantExpected, 1)
			if s.fence.expected != want {
				t.Errorf("expected = %d, want %d", s.fence.expected, want)
			}
			if !s.scanner.AtBoundary() {
				t.Error("scanner not at a boundary after the frames")
			}
		})
	}
}

// A replay of a later generation first returns the terminal to its defaults
// and closes the gate; a sequence the old stream left open is cancelled so
// that the reset is not read as part of it.
func TestScreenLaterReplayResets(t *testing.T) {
	s, buf := newTestScreen()
	if err := s.beginReplay(true); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, s, "\x1b[?2004h\x1b[?1049h")
	if _, err := s.armFence(); err != nil {
		t.Fatal(err)
	}
	s.fence.Filter([]byte(da1Reply))
	if !s.fence.Open() {
		t.Fatal("gate not open")
	}
	mustWrite(t, s, "\x1b]0;cut")
	buf.Reset()

	if err := s.beginReplay(false); err != nil {
		t.Fatal(err)
	}
	if got, want := buf.String(), "\x18\x1b[?1049l\x1b[?2004l"; got != want {
		t.Errorf("output = %q, want %q", got, want)
	}
	if s.fence.Open() {
		t.Error("gate still open")
	}
	if s.modes.ResetSeq() != nil {
		t.Errorf("modes not back to the defaults: ResetSeq %q", s.modes.ResetSeq())
	}
}

func TestScreenFirstReplayWritesNothing(t *testing.T) {
	s, buf := newTestScreen()
	if err := s.beginReplay(true); err != nil {
		t.Fatal(err)
	}
	if buf.Len() != 0 {
		t.Errorf("output = %q, want nothing", buf.String())
	}
}

// A new generation drops a fence still waiting for its boundary; the next
// live arms a fresh one.
func TestScreenReplayDropsDueFence(t *testing.T) {
	s, buf := newTestScreen()
	mustWrite(t, s, "\x1b[")
	if _, err := s.armFence(); err != nil {
		t.Fatal(err)
	}
	if err := s.beginReplay(false); err != nil {
		t.Fatal(err)
	}
	buf.Reset()
	if liveFrame(t, s, "text") {
		t.Errorf("fence written before the new generation's live; output %q", buf.String())
	}
}

// A notice written while the output stands inside a sequence cancels it
// first, or the terminal would read the notice as part of it.
func TestScreenNoticeCancelsSequence(t *testing.T) {
	s, buf := newTestScreen()
	mustWrite(t, s, "\x1b]0;title")
	buf.Reset()
	if err := s.notice("note"); err != nil {
		t.Fatal(err)
	}
	if got, want := buf.String(), "\x18\r\nnote\r\n"; got != want {
		t.Errorf("output = %q, want %q", got, want)
	}
	buf.Reset()
	if err := s.notice("again"); err != nil {
		t.Fatal(err)
	}
	if got, want := buf.String(), "\r\nagain\r\n"; got != want {
		t.Errorf("output at a boundary = %q, want %q", got, want)
	}
}
