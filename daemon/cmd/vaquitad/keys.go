package main

import (
	"bytes"
	"time"
)

// detachKey is Ctrl-\ as terminals send it by default. attach consumes the
// key in every encoding, so the session never sees it: in a session with
// ISIG set it would otherwise send SIGQUIT to the foreground job.
const detachKey = 0x1c

// escWait is how long a bare ESC or ESC [ is held for the rest of a key
// report; a terminal sends a report in one write, so a pause this long means
// the Escape key was pressed.
const escWait = 25 * time.Millisecond

// maxKeySeq bounds the CSI sequence a keyScanner collects; key reports are
// far shorter.
const maxKeySeq = 64

// keyScanner finds the detach key in what the terminal sends. Besides 0x1c
// it knows the encodings a terminal switches to when a program in the
// session asks for them: the kitty keyboard protocol's CSI 92;5u, with
// alternate keys, event types, associated text and lock bits as flagged,
// and xterm's modifyOtherKeys CSI 27;5;92~. A terminal only sends those
// while they are enabled, so they are recognised whatever modes attach has
// seen set. A release of the key is dropped, as its press never reaches the
// session.
//
// A sequence cut off at the end of a read is held back until the next read
// shows what it is, so that a key report split at any byte is still
// recognised; the program in the session could not act on half a sequence
// anyway. A bare ESC or ESC [ may also be the Escape key, or Alt-[: the
// caller flushes it when nothing follows within escWait, as programs tell
// the two apart by timing too.
type keyScanner struct {
	seq []byte // the sequence in progress from its ESC; empty in ground
}

// scan returns what of p to pass on, and whether p holds the detach key, in
// which case only what came before the key is passed on.
func (k *keyScanner) scan(p []byte) (fwd []byte, detach bool) {
	for _, b := range p {
		if fwd, detach = k.step(fwd, b); detach {
			k.seq = k.seq[:0]
			return fwd, true
		}
	}
	return fwd, false
}

// bare reports whether the scanner holds only ESC or ESC [, which may be a
// complete key rather than the start of a report.
func (k *keyScanner) bare() bool { return len(k.seq) > 0 && len(k.seq) <= 2 }

// flush returns what the scanner holds, to be passed on as it is.
func (k *keyScanner) flush() []byte {
	p := bytes.Clone(k.seq)
	k.seq = k.seq[:0]
	return p
}

func (k *keyScanner) step(fwd []byte, b byte) ([]byte, bool) {
	n := len(k.seq)
	switch {
	case n == 0:
		switch b {
		case detachKey:
			return fwd, true
		case 0x1b:
			k.seq = append(k.seq, b)
			return fwd, false
		}
		return append(fwd, b), false
	case n == 1 && b == '[', n >= 2 && n < maxKeySeq && b >= 0x30 && b <= 0x3f:
		k.seq = append(k.seq, b)
		return fwd, false
	case n >= 2 && b >= 0x40 && b <= 0x7e:
		seq := append(k.seq, b)
		k.seq = k.seq[:0]
		switch classifyKey(seq[2:n], b) {
		case keyDetach:
			return fwd, true
		case keyRelease:
			return fwd, false
		}
		return append(fwd, seq...), false
	}
	// Not a sequence this scanner follows: what was collected goes on as it
	// is, and b is looked at afresh.
	fwd = append(fwd, k.seq...)
	k.seq = k.seq[:0]
	return k.step(fwd, b)
}

type keyKind uint8

const (
	keyOther keyKind = iota
	keyDetach
	keyRelease
)

// classifyKey tells whether the CSI sequence with params and final reports
// Ctrl-\: kitty's key[:alternates];mods[:event][;text]u, where the key is
// the codepoint of '\', or modifyOtherKeys' 27;mods;key~.
func classifyKey(params []byte, final byte) keyKind {
	f := bytes.Split(params, []byte{';'})
	switch {
	case final == 'u' && (len(f) == 2 || len(f) == 3):
		key, mods := bytes.Split(f[0], []byte{':'}), bytes.Split(f[1], []byte{':'})
		if num(key[0]) != '\\' || len(mods) > 2 || !ctrlOnly(num(mods[0])) {
			return keyOther
		}
		if len(mods) == 2 && num(mods[1]) == 3 {
			return keyRelease
		}
		return keyDetach
	case final == '~' && len(f) == 3:
		if num(f[0]) == 27 && ctrlOnly(num(f[1])) && num(f[2]) == '\\' {
			return keyDetach
		}
	}
	return keyOther
}

// ctrlOnly reports whether a key report's modifier parameter, 1 plus the
// modifier bits, is Ctrl alone. Caps Lock (64) and Num Lock (128) do not
// count.
func ctrlOnly(m int) bool {
	return m >= 1 && (m-1)&^(64|128) == 4
}

// num parses a decimal parameter, or returns -1 for an empty or malformed
// one.
func num(b []byte) int {
	if len(b) == 0 || len(b) > 6 {
		return -1
	}
	n := 0
	for _, c := range b {
		if c < '0' || c > '9' {
			return -1
		}
		n = n*10 + int(c-'0')
	}
	return n
}
