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

	// reporter is the foreground process group when the last root working or
	// blocked report was read, 0 when unknown. While the view is working or
	// waiting for input, Tick polls it from nextPoll on: the program runs in
	// a group of its own under the session's shell, so its death, even by
	// SIGKILL, ends neither the session nor anything the projector sees.
	//
	// leader is the process group of the session's shell, 0 in unit tests. An
	// agent normally runs as a foreground job of its own, so a report read
	// while the leader's group is in the foreground means either that the
	// reporter has already exited and the shell has control again, or that the
	// agent replaced the shell with exec and shares its group. LeaderIsShell
	// tells them apart; for a shell, gone is set and Tick clears the view at
	// the next poll without asking GroupAlive, which the shell's group would
	// pass forever. Clearing waits for the poll so the report is still
	// published first. A replaced leader is watched like any reporter: its
	// group lasts as long as the session, whose exit clears the status.
	reporter int
	leader   int
	gone     bool
	nextPoll time.Time

	// Now stamps the reports the projector sees; tests replace it.
	Now func() time.Time
	// Foreground returns the PTY's foreground process group, and GroupAlive
	// reports whether a process group still exists. Both are set or both
	// nil, as in unit tests, which means no watch: only Foreground produces
	// a reporter, and Tick calls GroupAlive only for one. A group Foreground
	// cannot tell, or one at most 1, leaves a report without a reporter.
	Foreground func() (int, error)
	GroupAlive func(pgid int) bool
	// LeaderIsShell reports whether the session leader is running a shell. It
	// is nil in unit tests that need no such evidence, and must say false when
	// it cannot tell: a live agent is never cleared on a guess.
	LeaderIsShell func() bool
}

// fgPollGap is how often the reporter's process group is polled.
const fgPollGap = time.Second

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

// Tick raises a notification whose deadline has passed and, once the poll is
// due, checks that the reporter's process group is still there.
func (o *Output) Tick(now time.Time) {
	o.proj.Tick(now)
	if !o.polling() || now.Before(o.nextPoll) {
		return
	}
	if !o.gone && o.GroupAlive(o.reporter) {
		o.nextPoll = now.Add(fgPollGap)
		return
	}
	o.interrupt()
}

// interrupt ends whatever was working or waiting for input, in the records
// and the view, as a new shell prompt or the reporter's death does. Done and
// error outcomes stay.
func (o *Output) interrupt() {
	o.records.PromptStart()
	o.proj.Interrupt()
	o.reporter, o.gone = 0, false
}

// NextDeadline reports when Tick next has something to do. now is unused:
// both deadlines are kept as times.
func (o *Output) NextDeadline(_ time.Time) (time.Time, bool) {
	d, ok := o.proj.Deadline()
	if o.polling() && (!ok || o.nextPoll.Before(d)) {
		return o.nextPoll, true
	}
	return d, ok
}

// polling reports whether Tick polls the reporter's process group: only a
// view that is working or waiting for input can be left behind by its death.
func (o *Output) polling() bool {
	if o.reporter == 0 {
		return false
	}
	v, _ := o.proj.View()
	switch v.State {
	case status.ViewWorking, status.ViewInput, status.ViewAuth:
		return true
	}
	return false
}

// watch records the foreground process group as the reporter of a root
// report, or forgets it. The leader's group is recorded as gone when the
// leader is a shell, for the next poll to find.
func (o *Output) watch(state string, now time.Time) {
	switch state {
	case status.StateWorking, status.StateBlocked:
		o.reporter, o.gone = 0, false
		if o.Foreground == nil {
			return
		}
		if pgid, err := o.Foreground(); err == nil && pgid > 1 {
			o.reporter, o.nextPoll = pgid, now.Add(fgPollGap)
			o.gone = pgid == o.leader && o.LeaderIsShell != nil && o.LeaderIsShell()
		}
	case status.StateClear:
		o.reporter = 0
	}
}

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
				now := o.Now()
				o.watch(r.State, now)
				o.proj.Report(r, now)
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
			o.interrupt()
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
		s.o.reporter = 0
	}
}
