package main

import (
	"bytes"
	"io"

	"github.com/zeikar/vaquita/daemon/internal/session"
)

const ctrlCAN = 0x18

// da1Query is the fence query: primary device attributes, which every
// terminal answers.
var da1Query = []byte("\x1b[c")

// screen is attach's output to the user's terminal. Every byte goes through
// a Scanner first, so that modes follows the modes the terminal has been
// put in (to leave it as it was found) and the fence counts each DA1 query
// the terminal will answer. The fence query alone bypasses the scanner,
// since Register counts it; it is only written at a boundary, so the
// scanner's state is the same with or without it.
type screen struct {
	w       io.Writer
	fence   *Fence
	scanner *session.Scanner
	modes   session.Modes
	// fenceDue is set from live until the fence is written. It waits for a
	// boundary so that it never lands inside a sequence or a character the
	// output has begun, where the terminal would not read it as a query.
	fenceDue bool
}

func newScreen(w io.Writer, f *Fence) *screen {
	s := &screen{w: w, fence: f}
	s.scanner = session.NewScanner(s)
	return s
}

// OSC, CSI and ESC make the screen its scanner's sink.

func (s *screen) OSC(num int, payload []byte, oversized bool) { s.modes.OSC(num, payload, oversized) }
func (s *screen) ESC(final byte)                              { s.modes.ESC(final) }

func (s *screen) CSI(params, intermediates []byte, final byte) {
	// A private marker (DA2's '>', DA3's '=') makes another query, one
	// whose reply is not a DA1 reply either.
	if final == 'c' && len(intermediates) == 0 && len(bytes.TrimLeft(params, "0")) == 0 {
		s.fence.Query()
	}
	s.modes.CSI(params, intermediates, final)
}

// write scans p and writes it.
func (s *screen) write(p []byte) error {
	s.scanner.Scan(p)
	return s.out(p)
}

// out writes p without scanning it.
func (s *screen) out(p []byte) error {
	if len(p) == 0 {
		return nil
	}
	_, err := s.w.Write(p)
	return err
}

// settle cuts off output that stopped inside a sequence or a character with
// CAN, which is ignored in ground state. Otherwise the terminal would read
// what attach writes next as part of it, and an unterminated OSC would
// swallow everything up to the next BEL. If the rest of the sequence
// follows, it shows as text: a notice or a reset matters more.
func (s *screen) settle() error {
	if s.scanner.AtBoundary() {
		return nil
	}
	return s.write([]byte{ctrlCAN})
}

// notice writes msg on a line of its own.
func (s *screen) notice(msg string) error {
	if err := s.settle(); err != nil {
		return err
	}
	return s.write([]byte("\r\n" + msg + "\r\n"))
}

// reset returns the terminal to its default modes, ending at a boundary.
func (s *screen) reset() error {
	if err := s.settle(); err != nil {
		return err
	}
	return s.write(s.modes.ResetSeq())
}

// beginReplay prepares for a replay before its prefix frame: a generation
// after the first is written over a terminal still in the old one's modes,
// which its prefix assumes are the defaults. The gate closes either way,
// as the terminal's answers to the replay must not leak, and a fence still
// due for the old generation is dropped; the next live arms a new one.
func (s *screen) beginReplay(first bool) error {
	if !first {
		if err := s.reset(); err != nil {
			return err
		}
	}
	s.fence.Begin()
	s.fenceDue = false
	return nil
}

// armFence asks for the fence at the next boundary and writes it right away
// if the output stands at one. It reports whether the fence was written.
func (s *screen) armFence() (bool, error) {
	s.fenceDue = true
	if !s.scanner.AtBoundary() {
		return false, nil
	}
	return true, s.writeFence()
}

// live writes live output. A fence that is due goes in at its first
// boundary: the bytes before it are counted and written first, so that
// their queries come before the fence, and the rest follows the fence. It
// reports whether the fence was written.
func (s *screen) live(p []byte) (bool, error) {
	if !s.fenceDue {
		return false, s.write(p)
	}
	k := firstBoundary(s.scanner, p)
	if k < 0 {
		return false, s.out(p)
	}
	if err := s.out(p[:k]); err != nil {
		return false, err
	}
	if err := s.writeFence(); err != nil {
		return false, err
	}
	return true, s.write(p[k:])
}

func (s *screen) writeFence() error {
	s.fenceDue = false
	s.fence.Register()
	return s.out(da1Query)
}

// firstBoundary scans the shortest prefix of p after which sc stands at a
// boundary and returns its length, or scans all of p and returns -1 when
// there is none.
func firstBoundary(sc *session.Scanner, p []byte) int {
	for i := 0; ; i++ {
		if sc.AtBoundary() {
			return i
		}
		if i == len(p) {
			return -1
		}
		sc.Scan(p[i : i+1])
	}
}
