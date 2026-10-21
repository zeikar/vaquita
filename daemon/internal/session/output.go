package session

import "github.com/zeikar/vaquita/daemon/internal/status"

// maxRecentNotifies bounds the notifications Output remembers.
const maxRecentNotifies = 16

// Output is the path a session's PTY output takes: the live scanner finds
// cut boundaries in each read, and the read is kept in the ring for replay.
//
// A tail tracker scans exactly the bytes the ring evicts, in order, so it
// knows the modes in effect at the ring start. Those are what a replay from
// Ring().Start() needs re-established first; modes changed later are
// reproduced by the replayed bytes themselves.
//
// Output is not safe for concurrent use; the session lock guards it.
type Output struct {
	live *Scanner
	ring *Ring

	tailModes   Modes
	tailScanner *Scanner

	records status.Records
	recent  []status.Notify // oldest first, at most maxRecentNotifies
}

// Status is what the program in a session has reported about itself.
type Status struct {
	Records    []status.Record
	LastNotify *status.Notify
	// Recent holds the latest notifications, oldest first.
	Recent []status.Notify
}

// NewOutput returns an Output with an empty ring of DefaultRingCap bytes.
func NewOutput() *Output {
	o := &Output{ring: NewRing(DefaultRingCap)}
	o.live = NewScanner(statusSink{o})
	o.tailScanner = NewScanner(&o.tailModes)
	// The ring may evict in several pieces per append; the tail scanner
	// keeps its state between them, so a sequence split across pieces is
	// still seen whole.
	o.ring.OnEvict = func(p []byte) { o.tailScanner.Scan(p) }
	return o
}

// Feed scans p and appends it to the ring. Like Status, it requires the
// session lock.
func (o *Output) Feed(p []byte) {
	o.ring.Append(p, o.live.Scan(p))
}

// Ring returns the ring holding the recent output.
func (o *Output) Ring() *Ring { return o.ring }

// ReplayPrefix returns what to write to a terminal fresh from reset before
// replaying the ring from its Start, possibly nothing.
func (o *Output) ReplayPrefix() []byte { return o.tailModes.Prefix() }

// ReplaceScanner restarts live scanning in ground state with the same sink.
// The reader calls it after recovering from a panic, which may have left the
// scanner halfway through an update. It recovers only the live scanner, which
// runs before the ring is touched: a panic in the tail scanner would happen
// inside OnEvict and leave the ring inconsistent, so Modes must never panic.
func (o *Output) ReplaceScanner() {
	o.live = NewScanner(o.live.sink)
}

// Status returns a copy of the session's status records and notifications.
func (o *Output) Status() Status {
	st := Status{Records: o.records.Snapshot(), Recent: append([]status.Notify(nil), o.recent...)}
	if n := len(st.Recent); n > 0 {
		last := st.Recent[n-1]
		st.LastNotify = &last
	}
	return st
}

// statusSink feeds the live output's status sequences to an Output. Parsers
// copy what they keep, as the scanner's slices are only valid during a call.
type statusSink struct{ o *Output }

func (s statusSink) OSC(num int, payload []byte, oversized bool) {
	o := s.o
	switch num {
	case 7501:
		// A truncated report may have lost its tail, including a clear or a
		// later value of a key, so it is not worth acting on.
		if oversized {
			return
		}
		if r, ok := status.ParseReport(payload); ok && !r.Query {
			o.records.Apply(r)
		}
	case 9, 777:
		if n, ok := status.ParseNotify(num, payload); ok {
			if len(o.recent) == maxRecentNotifies {
				o.recent = append(o.recent[:0], o.recent[1:]...)
			}
			o.recent = append(o.recent, n)
		}
	case 133:
		// Shell integration: A marks the start of a prompt.
		if len(payload) > 0 && payload[0] == 'A' && (len(payload) == 1 || payload[1] == ';') {
			o.records.PromptStart()
		}
	}
}

func (statusSink) CSI(_, _ []byte, _ byte) {}

func (s statusSink) ESC(final byte) {
	if final == 'c' {
		s.o.records.Reset()
	}
}
