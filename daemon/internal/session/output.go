package session

import (
	"time"

	"github.com/zeikar/vaquita/daemon/internal/status"
)

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
	proj    status.Projector

	// Now stamps the reports the projector sees; tests replace it.
	Now func() time.Time
}

// Status is what the program in a session has reported about itself.
type Status struct {
	Records []status.Record
	View    status.View
	Unread  bool
}

// NewOutput returns an Output with an empty ring of DefaultRingCap bytes.
func NewOutput() *Output {
	o := &Output{ring: NewRing(DefaultRingCap), Now: time.Now}
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

// Status returns a copy of the session's status records and its view.
func (o *Output) Status() Status {
	v, unread := o.proj.View()
	return Status{Records: o.records.Snapshot(), View: v, Unread: unread}
}

// The methods below expose the status projection. Like Feed, they require the
// session lock.

// View returns what the sidebar shows and whether it is unread.
func (o *Output) View() (status.View, bool) { return o.proj.View() }

// HasStatus reports whether TakeStatus has a view change or notification.
func (o *Output) HasStatus() bool { return o.proj.Pending() }

// TakeStatus hands over the view change and notifications since the last call.
func (o *Output) TakeStatus() (changed bool, notes []status.Notification) { return o.proj.Take() }

// Seen marks the session as looked at.
func (o *Output) Seen() { o.proj.Seen() }

// Tick raises a notification whose deadline has passed.
func (o *Output) Tick(now time.Time) { o.proj.Tick(now) }

// NextDeadline reports when Tick next has something to raise. now is unused
// until the foreground process group poll joins the deadline.
func (o *Output) NextDeadline(_ time.Time) (time.Time, bool) { return o.proj.Deadline() }

// ClearStatus empties the view and drops pending notifications, deadlines and
// the held OSC 9, as the session's exit does.
func (o *Output) ClearStatus() { o.proj = status.Projector{} }

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
			// Child reports stay in the records: a child's done must not
			// complete its parent.
			if r.ID == "" {
				o.proj.Report(r, o.Now())
			}
		}
	// Only OSC 9 feeds the projection. Claude Code's OSC 777 arrives seconds
	// after the blocked report that already says the same, and words a
	// permission and a question alike.
	case 9:
		if n, ok := status.ParseNotify(num, payload); ok {
			o.proj.OSC9(n.Body)
		}
	case 133:
		// Shell integration: A marks the start of a prompt.
		if len(payload) > 0 && payload[0] == 'A' && (len(payload) == 1 || payload[1] == ';') {
			o.records.PromptStart()
			o.proj.Interrupt()
		}
	}
}

func (statusSink) CSI(_, _ []byte, _ byte) {}

func (s statusSink) ESC(final byte) {
	if final == 'c' {
		s.o.records.Reset()
		// A done already due is raised before the clear drops it, so the
		// outcome does not depend on how late the timer fired.
		s.o.proj.Tick(s.o.Now())
		s.o.proj.Clear()
	}
}
