package session

// Limits on what a Scanner retains or waits for, so hostile or runaway output
// can neither grow its memory nor keep it out of ground state for good.
const (
	// maxOSCRetain covers a whole OSC 7501 status report, which is capped at
	// 4096 bytes; longer strings reach the sink truncated.
	maxOSCRetain = 4 << 10
	// maxStringLen abandons an OSC or DCS/SOS/PM/APC string that has not
	// terminated by then: otherwise a program killed mid-string would leave
	// all later output unscanned and without cut boundaries.
	maxStringLen = 64 << 10
	// maxCSIRetain bounds CSI parameters and intermediates together; real
	// sequences are far shorter, so a longer one is ignored.
	maxCSIRetain = 64
	// maxOSCDigits only keeps hostile input from overflowing the OSC number;
	// real ones have at most four digits.
	maxOSCDigits = 9
)

const (
	ctrlBEL = 0x07
	ctrlCAN = 0x18
	ctrlSUB = 0x1a
	ctrlESC = 0x1b
)

type scanState uint8

const (
	scanGround scanState = iota
	scanEsc
	scanEscIntermediate
	scanCSI
	scanOSC
	scanOSCEsc
	scanStr // DCS, SOS, PM or APC: skipped up to ST
	scanStrEsc
)

// Sink receives the sequences a Scanner completes, synchronously from Scan
// and in stream order. Slices passed to it alias the scanner's buffers and
// are only valid during the call; a sink that keeps them must copy. A sink
// must not call back into the Scanner.
type Sink interface {
	// OSC reports an operating system command terminated by BEL or ST. num
	// is the leading decimal number, ended by ';' or the end of the string,
	// and payload is what follows the ';'. A string without such a number
	// has num -1 and the whole string as payload. oversized means the string
	// was longer than the 4KB retained, so payload is truncated.
	OSC(num int, payload []byte, oversized bool)
	// CSI reports a control sequence. params are the 0x30-0x3F bytes,
	// private markers such as '?' included; intermediates are the 0x20-0x2F
	// bytes after them.
	CSI(params, intermediates []byte, final byte)
	// ESC reports a two-byte escape sequence such as RIS (ESC c). A stray
	// ST outside a string is reported as ESC('\\').
	ESC(final byte)
}

// Scanner follows the escape-sequence structure of terminal output without
// emulating a terminal. It finds cut boundaries, where a replay may begin
// without starting inside an escape sequence or a UTF-8 character, and
// reports the sequences it completes to a Sink.
//
// Bytes from 0x80 up are UTF-8, never C1 controls, as in a terminal running
// in UTF-8 mode. One right after an ESC (or its intermediates) abandons the
// escape and is read as text, and one inside a CSI makes the CSI ignored:
// deliberately, so malformed input never yields a false event such as RIS
// from "ESC é c". DEL and C0 controls other than ESC, CAN and SUB are skipped
// inside ESC and CSI sequences without ending them, the way a VT parser
// executes C0 controls in place.
//
// A Scanner is not safe for concurrent use.
type Scanner struct {
	sink  Sink
	state scanState
	// utf8Pending counts the continuation bytes still expected for a
	// character begun in ground state. It is only ever nonzero there, since
	// leaving ground takes an ESC, which ends any pending character.
	utf8Pending int

	// strLen counts the content bytes of the OSC or string in progress.
	strLen int

	osc          [maxOSCRetain]byte
	oscLen       int
	oscOversized bool

	// csi[:csiParams] holds parameters and csi[csiParams:csiLen]
	// intermediates.
	csi       [maxCSIRetain]byte
	csiLen    int
	csiParams int
	csiIgnore bool
}

// NewScanner returns a scanner in ground state that reports to sink.
func NewScanner(sink Sink) *Scanner {
	return &Scanner{sink: sink}
}

// AtBoundary reports whether the scanner is in ground state with no partial
// UTF-8 character pending, i.e. whether the next byte may start a replay.
func (s *Scanner) AtBoundary() bool {
	return s.state == scanGround && s.utf8Pending == 0
}

// Scan feeds p to the scanner and returns the last cut boundary within p, or
// -1 if there is none. Offset i in [0, len(p)] is a cut boundary when the
// scanner is AtBoundary after consuming p[:i]. So 0 counts only if the
// scanner was at a boundary when Scan was called, and len(p) only if it is
// at one when Scan returns. The result is what Ring.Append expects.
func (s *Scanner) Scan(p []byte) (lastBoundary int) {
	lastBoundary = -1
	for i, b := range p {
		if s.AtBoundary() {
			lastBoundary = i
		}
		s.step(b)
	}
	if s.AtBoundary() {
		lastBoundary = len(p)
	}
	return lastBoundary
}

func (s *Scanner) step(b byte) {
	if b == ctrlCAN || b == ctrlSUB {
		// CAN and SUB cancel any sequence in progress. In ground they are
		// plain controls, which end a pending character all the same.
		s.state = scanGround
		s.utf8Pending = 0
		return
	}
	switch s.state {
	case scanGround:
		s.ground(b)
	case scanEsc:
		s.escape(b)
	case scanEscIntermediate:
		switch {
		case b == ctrlESC:
			s.state = scanEsc
		case b >= 0x30 && b <= 0x7E:
			// Not reported: no sink needs designations like ESC ( B, and as
			// ESC(final) ESC ( c would look like RIS.
			s.state = scanGround
		case b >= 0x80:
			s.state = scanGround
			s.ground(b)
		}
	case scanCSI:
		s.csiByte(b)
	case scanOSC:
		switch b {
		case ctrlBEL:
			s.state = scanGround
			s.dispatchOSC()
		case ctrlESC:
			s.state = scanOSCEsc
		default:
			s.oscByte(b)
		}
	case scanStr:
		if b == ctrlESC {
			s.state = scanStrEsc
		} else {
			s.countString()
		}
	case scanOSCEsc, scanStrEsc:
		if b == '\\' {
			osc := s.state == scanOSCEsc
			s.state = scanGround
			if osc {
				s.dispatchOSC()
			}
			return
		}
		// An ESC not followed by '\' abandons the string and begins a new
		// sequence.
		s.state = scanEsc
		s.escape(b)
	}
}

func (s *Scanner) ground(b byte) {
	switch {
	case b == ctrlESC:
		s.utf8Pending = 0
		s.state = scanEsc
	case b < 0x80:
		s.utf8Pending = 0
	case b < 0xC0:
		// A stray continuation byte stands alone, so it leaves nothing
		// pending.
		if s.utf8Pending > 0 {
			s.utf8Pending--
		}
	default:
		s.utf8Pending = utf8Continuations(b)
	}
}

// escape handles the byte after an ESC. Another ESC stays in scanEsc.
func (s *Scanner) escape(b byte) {
	switch {
	case b >= 0x80:
		s.state = scanGround
		s.ground(b)
	case b >= 0x20 && b <= 0x2F:
		s.state = scanEscIntermediate
	case b == '[':
		s.state = scanCSI
		s.csiLen, s.csiParams, s.csiIgnore = 0, 0, false
	case b == ']':
		s.state = scanOSC
		s.strLen, s.oscLen, s.oscOversized = 0, 0, false
	case b == 'P' || b == 'X' || b == '^' || b == '_':
		s.state = scanStr
		s.strLen = 0
	case b >= 0x30 && b <= 0x7E:
		s.state = scanGround
		s.sink.ESC(b)
	}
}

func (s *Scanner) csiByte(b byte) {
	switch {
	case b >= 0x40 && b <= 0x7E:
		s.state = scanGround
		if !s.csiIgnore {
			s.sink.CSI(s.csi[:s.csiParams], s.csi[s.csiParams:s.csiLen], b)
		}
	case b == ctrlESC:
		s.state = scanEsc
	case b >= 0x80:
		// Malformed: the CSI is consumed to its final byte without a
		// callback, as with the cases below.
		s.csiIgnore = true
	case b >= 0x20 && b <= 0x3F:
		param := b >= 0x30
		switch {
		case s.csiIgnore:
		case param && s.csiLen > s.csiParams, s.csiLen == maxCSIRetain:
			// A parameter after an intermediate is malformed, and an
			// overlong sequence not worth parsing.
			s.csiIgnore = true
		default:
			s.csi[s.csiLen] = b
			s.csiLen++
			if param {
				s.csiParams = s.csiLen
			}
		}
	}
}

func (s *Scanner) oscByte(b byte) {
	if !s.countString() {
		return
	}
	switch {
	case b < 0x20:
		// C0 controls inside an OSC are ignored, as terminals do.
	case s.oscLen == maxOSCRetain:
		s.oscOversized = true
	default:
		s.osc[s.oscLen] = b
		s.oscLen++
	}
}

// countString counts a content byte of an OSC or string, abandoning it in
// favor of ground state once it is longer than maxStringLen. It reports
// whether the string is still open.
func (s *Scanner) countString() bool {
	s.strLen++
	if s.strLen > maxStringLen {
		s.state = scanGround
		return false
	}
	return true
}

func (s *Scanner) dispatchOSC() {
	num, payload := splitOSC(s.osc[:s.oscLen])
	s.sink.OSC(num, payload, s.oscOversized)
}

// splitOSC splits an OSC string into its leading number and the payload
// after the ';', as documented on Sink.OSC.
func splitOSC(str []byte) (num int, payload []byte) {
	for i, c := range str {
		if c == ';' && i > 0 {
			return num, str[i+1:]
		}
		if c < '0' || c > '9' || i == maxOSCDigits {
			return -1, str
		}
		num = num*10 + int(c-'0')
	}
	if len(str) == 0 {
		return -1, str
	}
	return num, str[len(str):]
}

// utf8Continuations is how many continuation bytes lead byte b announces.
// Bytes that can never start a character (0xC0, 0xC1, 0xF5-0xFF) stand
// alone, as decoders replace them at once. Range limits on the second byte
// are not checked: missing one only withholds a boundary until the next
// character.
func utf8Continuations(b byte) int {
	switch {
	case b >= 0xC2 && b <= 0xDF:
		return 1
	case b >= 0xE0 && b <= 0xEF:
		return 2
	case b >= 0xF0 && b <= 0xF4:
		return 3
	}
	return 0
}
