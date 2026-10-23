package session

import "strconv"

const (
	// maxKeyFlags bounds each kitty keyboard flag stack; a push onto a full
	// stack drops the oldest entry, as the protocol asks of terminals. kitty
	// and Ghostty keep 8, and a different depth would let a later pop leave
	// the tracker and the terminal with different flags.
	maxKeyFlags = 8
	// maxParam saturates parsed parameters, so a long digit run cannot wrap
	// around to a tracked mode number. No tracked mode or flag value is near
	// it.
	maxParam = 1<<16 - 1
)

const (
	mainScreen = iota
	altScreen
)

// flagModes are the tracked DEC private modes that terminals keep as
// independent on/off flags, in the order Prefix and ResetSeq emit them.
var flagModes = [...]struct {
	n         int
	defaultOn bool
	// decstr is whether DECSTR resets the mode. Terminals disagree here
	// (xterm keeps 1004 and 2004, xterm.js clears 2026); leaving 2026 set is
	// deliberate and harmless, since ResetSeq always ends it.
	decstr bool
	// shell is whether shells' line editors set the mode for their prompt
	// themselves, so that ReleaseSeq leaves it to them.
	shell bool
}{
	{1, false, true, true},      // application cursor keys
	{7, true, true, false},      // autowrap
	{25, true, true, false},     // cursor visible
	{1004, false, true, false},  // focus events
	{2004, false, true, true},   // bracketed paste
	{2026, false, false, false}, // synchronized output
}

// Modes follows the terminal modes that a stream of output sets: DEC private
// modes 1, 7, 9, 25, 47, 1047, 1049, 1000-1006, 2004 and 2026, and the kitty
// keyboard flag stacks of the main and the alternate screen. Prefix
// re-establishes them on a terminal fresh from reset and ResetSeq returns a
// terminal to its defaults. Feed it output through a Scanner.
//
// The alternate screen (47, 1047, 1049), mouse tracking (9, 1000-1003) and
// mouse encoding (1005, 1006) are each a single setting in xterm and xterm.js
// rather than independent flags: setting a mode replaces the others of its
// group. Resetting any screen or tracking mode turns its group off, so
// ?1002h ?1000h ?1000l leaves mouse reporting off where flags would leave
// 1002 on; an encoding is only reset by its own mode, as in xterm.
//
// For the keyboard protocol, a missing or zero pop count and set mode mean 1.
// The current flags of an empty stack are 0, and setting them creates an
// entry, so that a later pop drops the change again and Prefix can reproduce
// it with a push.
//
// The zero Modes is a terminal fresh from reset. A Modes is not safe for
// concurrent use.
type Modes struct {
	// changed has bit i set while flagModes[i] differs from its default.
	changed uint8
	// alt is the last of 47, 1047 and 1049 set, which selects the alternate
	// screen, or 0 while the main screen is selected.
	alt      int
	mouse    int // 9 or 1000-1003, or 0 for no mouse tracking
	mouseEnc int // 1005 or 1006, or 0 for the default encoding
	keys     [2]keyStack
}

// keyStack is a kitty keyboard flag stack, bottom first.
type keyStack struct {
	flags [maxKeyFlags]int
	n     int
}

func (s *keyStack) push(f int) {
	if s.n == maxKeyFlags {
		copy(s.flags[:], s.flags[1:])
		s.n--
	}
	s.flags[s.n] = f
	s.n++
}

// appendPushes appends the pushes that rebuild s on an empty stack.
func (s *keyStack) appendPushes(b []byte) []byte {
	for _, f := range s.flags[:s.n] {
		b = appendKeySeq(b, '>', f)
	}
	return b
}

// appendPop appends the pop that removes what appendPushes added.
func (s *keyStack) appendPop(b []byte) []byte {
	if s.n == 0 {
		return b
	}
	return appendKeySeq(b, '<', s.n)
}

// OSC implements Sink; no tracked mode is set by an OSC.
func (m *Modes) OSC(int, []byte, bool) {}

// ESC implements Sink: RIS (ESC c) resets everything tracked.
func (m *Modes) ESC(final byte) {
	if final == 'c' {
		*m = Modes{}
	}
}

// CSI implements Sink.
func (m *Modes) CSI(params, intermediates []byte, final byte) {
	if len(intermediates) > 0 {
		if final == 'p' && len(params) == 0 && string(intermediates) == "!" {
			m.softReset()
		}
		return
	}
	if len(params) == 0 {
		return
	}
	switch marker, p := params[0], params[1:]; {
	case marker == '?' && (final == 'h' || final == 'l'):
		if !numericParams(p) {
			return
		}
		for len(p) > 0 {
			var n int
			n, p = nextParam(p)
			m.setMode(n, final == 'h')
		}
	case final == 'u' && (marker == '>' || marker == '<' || marker == '='):
		if numericParams(p) {
			m.keyFlags(marker, p)
		}
	}
}

func (m *Modes) setMode(n int, on bool) {
	v := 0
	if on {
		v = n
	}
	switch n {
	case 47, 1047, 1049:
		m.alt = v
	case 9, 1000, 1001, 1002, 1003:
		m.mouse = v
	case 1005, 1006:
		if on || m.mouseEnc == n {
			m.mouseEnc = v
		}
	default:
		for i, f := range flagModes {
			if f.n == n {
				if on == f.defaultOn {
					m.changed &^= 1 << i
				} else {
					m.changed |= 1 << i
				}
			}
		}
	}
}

// softReset applies DECSTR.
func (m *Modes) softReset() {
	for i, f := range flagModes {
		if f.decstr {
			m.changed &^= 1 << i
		}
	}
}

// keyFlags applies a kitty keyboard push ('>'), pop ('<') or set ('=') to
// the stack of the selected screen.
func (m *Modes) keyFlags(marker byte, p []byte) {
	s := &m.keys[mainScreen]
	if m.alt != 0 {
		s = &m.keys[altScreen]
	}
	v, rest := nextParam(p)
	switch marker {
	case '>':
		s.push(v)
	case '<':
		s.n -= min(max(v, 1), s.n)
	case '=':
		how, _ := nextParam(rest)
		how = max(how, 1)
		if how > 3 {
			return
		}
		if s.n == 0 {
			s.push(0)
		}
		top := &s.flags[s.n-1]
		switch how {
		case 1:
			*top = v
		case 2:
			*top |= v
		case 3:
			*top &^= v
		}
	}
}

// Prefix returns the sequence that brings a terminal fresh from reset into
// the tracked state, or nil when that is the default state. Keyboard flags
// are pushed while their own screen is selected, so the alternate screen is
// entered briefly to rebuild its stack when the main screen is selected.
func (m *Modes) Prefix() []byte {
	var b []byte
	if m.alt == 0 && m.keys[altScreen].n > 0 {
		b = appendMode(b, 1049, true)
		b = m.keys[altScreen].appendPushes(b)
		b = appendMode(b, 1049, false)
	}
	b = m.keys[mainScreen].appendPushes(b)
	if m.alt != 0 {
		b = appendMode(b, m.alt, true)
		b = m.keys[altScreen].appendPushes(b)
	}
	return m.appendModes(b, false)
}

// ResetSeq returns the sequence that returns a terminal in the tracked state
// to the defaults, or nil when it is there already. It pops only the
// keyboard flags that were tracked, so entries pushed before tracking began
// stay in place.
func (m *Modes) ResetSeq() []byte {
	var b []byte
	if m.alt != 0 {
		b = m.keys[altScreen].appendPop(b)
		b = appendMode(b, m.alt, false)
	} else if m.keys[altScreen].n > 0 {
		b = appendMode(b, 1049, true)
		b = m.keys[altScreen].appendPop(b)
		b = appendMode(b, 1049, false)
	}
	b = m.keys[mainScreen].appendPop(b)
	return m.appendModes(b, true)
}

// ReleaseSeq returns the sequence that undoes what a program that died
// without restoring the terminal left on, for the shell that gets the
// terminal back, or nil when there is nothing to undo. Unlike ResetSeq it
// leaves application cursor keys and bracketed paste as they are: line
// editors set those for their own prompt, which may already be on the
// screen, and resetting them under it would break arrow keys or pasting
// there. Leaving the alternate screen hides such a prompt if the shell drew
// it there; Enter brings a new one.
func (m *Modes) ReleaseSeq() []byte {
	rest := *m
	for i, f := range flagModes {
		if f.shell {
			rest.changed &^= 1 << i
		}
	}
	return rest.ResetSeq()
}

// appendModes appends a DECSET or DECRST for each mode other than the
// alternate screen that is away from its default, establishing the tracked
// value or, with toDefault, undoing it.
func (m *Modes) appendModes(b []byte, toDefault bool) []byte {
	for i, f := range flagModes {
		if m.changed&(1<<i) != 0 {
			b = appendMode(b, f.n, f.defaultOn == toDefault)
		}
	}
	for _, n := range [...]int{m.mouse, m.mouseEnc} {
		if n != 0 {
			b = appendMode(b, n, !toDefault)
		}
	}
	return b
}

func appendMode(b []byte, n int, on bool) []byte {
	b = append(b, ctrlESC, '[', '?')
	b = strconv.AppendInt(b, int64(n), 10)
	if on {
		return append(b, 'h')
	}
	return append(b, 'l')
}

func appendKeySeq(b []byte, marker byte, n int) []byte {
	b = append(b, ctrlESC, '[', marker)
	b = strconv.AppendInt(b, int64(n), 10)
	return append(b, 'u')
}

// numericParams reports whether p holds only digits and ';' separators,
// which is all the tracked sequences use; anything else, such as a ':'
// subparameter, makes the sequence one this tracker ignores.
func numericParams(p []byte) bool {
	for _, c := range p {
		if (c < '0' || c > '9') && c != ';' {
			return false
		}
	}
	return true
}

// nextParam parses the first ';'-separated parameter of p, which must pass
// numericParams, and returns it with what follows its separator. An empty
// parameter is 0, as for any VT parser.
func nextParam(p []byte) (v int, rest []byte) {
	for i, c := range p {
		if c == ';' {
			return v, p[i+1:]
		}
		v = min(v*10+int(c-'0'), maxParam)
	}
	return v, nil
}
