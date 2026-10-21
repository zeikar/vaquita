package session

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
}

// NewOutput returns an Output with an empty ring of DefaultRingCap bytes.
func NewOutput() *Output {
	o := &Output{live: NewScanner(nopSink{}), ring: NewRing(DefaultRingCap)}
	o.tailScanner = NewScanner(&o.tailModes)
	// The ring may evict in several pieces per append; the tail scanner
	// keeps its state between them, so a sequence split across pieces is
	// still seen whole.
	o.ring.OnEvict = func(p []byte) { o.tailScanner.Scan(p) }
	return o
}

// Feed scans p and appends it to the ring.
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

// nopSink discards the sequences of the live output.
type nopSink struct{}

func (nopSink) OSC(int, []byte, bool)   {}
func (nopSink) CSI(_, _ []byte, _ byte) {}
func (nopSink) ESC(byte)                {}
