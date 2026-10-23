package session

import (
	"strings"
	"time"
	"unicode"

	"github.com/zeikar/vaquita/daemon/internal/status"
)

// Output is the path a session's PTY output takes: the live scanner finds
// cut boundaries in each read, and the read is kept in the ring for replay.
//
// A tail tracker scans exactly the bytes the ring evicts, in order, so it
// knows the modes in effect at the ring start. Those are what a replay from
// Ring().Start() needs re-established first; modes changed later are
// reproduced by the replayed bytes themselves. The live scanner's sink tracks
// the modes in effect at the ring end the same way.
//
// Output is not safe for concurrent use; the session lock guards it.
type Output struct {
	live      *Scanner
	ring      *Ring
	liveModes Modes

	tailModes   Modes
	tailScanner *Scanner

	records status.Records
	proj    status.Projector

	// reporter is the foreground process group when the last root report that
	// left an agent running was read (idle, working, blocked, done or error;
	// a working or blocked one replaces it, the others keep a known one), 0
	// when unknown. As long as it is known, Tick polls it from nextPoll on:
	// the program runs in a group of its own under the session's shell, so its
	// death, even by SIGKILL, ends neither the session nor anything the
	// projector sees. The poll takes the reporter for gone once its group no
	// longer exists or is no longer the PTY's foreground group. The group alone
	// is not enough: a helper the program started, such as the caffeinate
	// Claude Code runs, can outlive it there for minutes. The shell takes the
	// terminal back as soon as it reaps the dead job, so the foreground says
	// whether the program still holds the session.
	//
	// A reporter found gone can leave a working or input view behind, which
	// Tick ends at once, and terminal modes on: with mouse tracking left on,
	// every mouse move over the terminal types a report into the shell. Undoing
	// the modes is the separate step release marks pending, which a Tick
	// performs only once the leader's group holds the foreground: another job
	// in front, a successor TUI or the sleep in `claude; sleep 10`, keeps it
	// pending and polled until the shell has the terminal back, as a program
	// there may be mid-way through setting its own modes. A prompt start
	// also forgets the reporter but leaves the release pending, as a shell
	// that draws its prompt before the poll has taken the terminal back. The
	// poll goes on after a done or idle report, as an agent killed at its
	// prompt leaves its modes on just the same; the clear report an agent sends
	// as it exits forgets the reporter and the release.
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
	// group stays in the foreground and lasts as long as the session, whose
	// exit clears the status.
	reporter int
	leader   int
	gone     bool
	release  bool
	// rearm is set when a report or prompt start gave the watch a deadline of
	// its own, which a drain must arm a timer for although no status changed.
	rearm    bool
	nextPoll time.Time

	// app is the app of the last root report that named one, and appChanged
	// says it differs from what TakeAppChange last handed over. The record of
	// a session keeps the agent last seen, so nothing here clears them.
	app        string
	appChanged bool

	// title is the last non-empty window title (OSC 0 or 2) that may be the
	// agent's, without the glyphs an agent puts before it, and titleChanged
	// says it changed under claude-code since TakeTitleChange last handed it
	// over. agentUp is set by a root report that leaves an agent running and
	// cleared by the clear report an agent sends as it exits and by an
	// interrupt. Once an app is known, a title set while no agent holds the
	// terminal (see agentHolds) is the shell's, such as the one a zsh precmd
	// sets after the agent has exited, and is dropped; so are those of an app
	// other than claude-code: codex shows its folder behind a spinner frame
	// redrawn about ten times a second. A report from another app drops a
	// title claude-code set, which belongs to claude's conversation.
	title        string
	titleChanged bool
	agentUp      bool

	// Now stamps the reports the projector sees; tests replace it.
	Now func() time.Time
	// Foreground returns the PTY's foreground process group, and GroupAlive
	// reports whether a process group still exists. Both are set or both
	// nil, as in unit tests, which means no watch: only Foreground produces
	// a reporter, and Tick calls both only for one. A group Foreground
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

// NeedsDrain reports whether a Tick should follow the last read: there is a
// status to take, or the watch has a deadline no timer was armed for, as when
// an agent reports only idle, which changes no view.
func (o *Output) NeedsDrain() bool {
	return o.proj.Pending() || o.rearm || o.appChanged || o.titleChanged
}

// App returns the app named by the last root report that had one, "" if none
// has. Like Feed, it requires the session lock.
func (o *Output) App() string { return o.app }

// TakeAppChange reports whether App changed since the last call. A change of
// app can leave the view as it was, so it asks for a drain of its own, and the
// status drain takes it. Like App, it requires the session lock.
func (o *Output) TakeAppChange() bool {
	c := o.appChanged
	o.appChanged = false
	return c
}

// claudeApp is the app Claude Code names in its reports.
const claudeApp = "claude-code"

// Title returns the window title kept by the rules on Output.title, "" if
// none. Like App, it requires the session lock.
func (o *Output) Title() string { return o.title }

// TakeTitleChange reports whether Title changed under claude-code since the
// last call. Like App, it requires the session lock.
func (o *Output) TakeTitleChange() bool {
	c := o.titleChanged
	o.titleChanged = false
	return c
}

// setTitle keeps title, already normalized, by the rules on Output.title. One
// set before any app has reported is kept without a change: the app change
// that follows asks for the drain that takes it.
func (o *Output) setTitle(title string) {
	switch {
	case title == "":
	case o.app == "":
		o.title = title
	case o.app == claudeApp && title != o.title && o.agentHolds():
		o.title, o.titleChanged = title, true
	}
}

// agentHolds reports whether the agent that last reported can still be what
// writes to the terminal: it is up and, when the session is watched, its
// reporter holds the session. An agent killed by SIGKILL sends no clear, and
// its shell takes the terminal back, and may set a title, before the next
// poll finds the reporter gone. Without a watch, as in unit tests, agentUp
// alone decides. Like the poll, it costs a signal and an ioctl, never a wait,
// and runs only for claude-code's titles.
func (o *Output) agentHolds() bool {
	if !o.agentUp {
		return false
	}
	if o.Foreground == nil {
		return true
	}
	return o.reporter != 0 && o.reporterHolds()
}

// normalizeTitle trims a window title and drops the runes before its first
// letter or digit: Codex and older Claude Code versions put spinner or status
// glyphs there.
func normalizeTitle(p []byte) string {
	return strings.TrimRightFunc(strings.TrimLeftFunc(string(p), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}), unicode.IsSpace)
}

// TakeStatus hands over the view change and notifications since the last call.
func (o *Output) TakeStatus() (changed bool, notes []status.Notification) { return o.proj.Take() }

// Seen marks the session as looked at.
func (o *Output) Seen() { o.proj.Seen() }

// Tick raises a notification whose deadline has passed and, once the poll is
// due, checks that the reporter's process group is still there and still in
// the foreground. When it is not, Tick ends the view and, if the shell has
// the terminal, appends to the output the sequence that undoes the modes the
// reporter left on, so that every terminal showing the session, and every
// later replay, gets it. The caller sends it on, as it would a read.
func (o *Output) Tick(now time.Time) {
	o.rearm = false
	o.proj.Tick(now)
	if (o.reporter == 0 && !o.release) || now.Before(o.nextPoll) {
		return
	}
	if o.reporter != 0 {
		if o.reporterHolds() {
			o.nextPoll = now.Add(fgPollGap)
			return
		}
		o.interrupt()
	}
	// While another job holds the foreground, such as the sleep in
	// `claude; sleep 10`, the release stays pending and is polled for: it is
	// performed when the shell has the terminal back. If that job was a TUI,
	// it has restored its own modes by then, so the release emits only what
	// is still on, possibly nothing. A failed lookup means the session is
	// ending.
	fg, err := o.Foreground()
	if err != nil || o.leader == 0 {
		o.release = false
		return
	}
	if fg != o.leader {
		o.release, o.nextPoll = true, now.Add(fgPollGap)
		return
	}
	o.release = false
	// Each sequence starts with ESC, which abandons one the reporter left
	// unfinished, in the live scanner and in terminals alike.
	if seq := o.liveModes.ReleaseSeq(); seq != nil {
		o.Feed(seq)
	}
}

// reporterHolds reports whether the reporter still holds the session: no
// report has marked it gone, its group still exists and it is the PTY's
// foreground group.
func (o *Output) reporterHolds() bool {
	return !o.gone && o.GroupAlive(o.reporter) && o.inForeground()
}

// inForeground reports whether the reporter's group is the PTY's foreground
// group. A failed lookup says nothing about who holds the terminal, so it
// counts as yes and leaves the decision to GroupAlive: the one expected is
// ErrClosed after the shell's exit, which clears the status anyway.
func (o *Output) inForeground() bool {
	fg, err := o.Foreground()
	return err != nil || fg == o.reporter
}

// interrupt ends whatever was working or waiting for input, in the records
// and the view, as a new shell prompt or the reporter's death does, and takes
// the agent for no longer up. Done and error outcomes stay.
func (o *Output) interrupt() {
	o.records.PromptStart()
	o.proj.Interrupt()
	o.reporter, o.gone, o.agentUp = 0, false, false
}

// NextDeadline reports when Tick next has something to do.
func (o *Output) NextDeadline() (time.Time, bool) {
	d, ok := o.proj.Deadline()
	if (o.reporter != 0 || o.release) && (!ok || o.nextPoll.Before(d)) {
		return o.nextPoll, true
	}
	return d, ok
}

// watch records the foreground process group as the reporter of a root
// report, or forgets it. A working or blocked report replaces the reporter; an
// idle, done or error one only arms the watch when there is none, so an agent
// killed before its first turn is found too. The leader's group is recorded
// as gone when the leader is a shell, for the next poll to find.
func (o *Output) watch(state string, now time.Time) {
	switch state {
	case status.StateClear:
		o.reporter, o.release = 0, false
		return
	case status.StateWorking, status.StateBlocked:
		o.reporter, o.gone = 0, false
	default:
		if o.reporter != 0 {
			return
		}
	}
	if o.Foreground == nil {
		return
	}
	if pgid, err := o.Foreground(); err == nil && pgid > 1 {
		o.reporter, o.nextPoll, o.rearm = pgid, now.Add(fgPollGap), true
		o.gone = pgid == o.leader && o.LeaderIsShell != nil && o.LeaderIsShell()
	}
}

// ClearStatus empties the view and drops pending notifications, deadlines and
// the held OSC 9, as the session's exit does.
func (o *Output) ClearStatus() { o.proj = status.Projector{} }

// statusSink feeds the live output's status sequences and terminal modes to
// an Output. Parsers copy what they keep, as the scanner's slices are only
// valid during a call.
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
				if r.App != "" && r.App != o.app {
					if o.app == claudeApp {
						o.title = ""
					}
					o.app, o.appChanged = r.App, true
				}
				o.agentUp = r.State != status.StateClear
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
	case 0, 2:
		// A truncated title is not the one the program set.
		if !oversized {
			o.setTitle(normalizeTitle(payload))
		}
	case 133:
		// Shell integration: A marks the start of a prompt.
		if len(payload) > 0 && payload[0] == 'A' && (len(payload) == 1 || payload[1] == ';') {
			// The scanner is mid-callback, so the next Tick undoes the modes.
			if o.reporter != 0 {
				o.release, o.nextPoll, o.rearm = true, o.Now(), true
			}
			o.interrupt()
		}
	}
}

func (s statusSink) CSI(params, intermediates []byte, final byte) {
	s.o.liveModes.CSI(params, intermediates, final)
}

func (s statusSink) ESC(final byte) {
	s.o.liveModes.ESC(final)
	if final == 'c' {
		s.o.records.Reset()
		// A done already due is raised before the clear drops it, so the
		// outcome does not depend on how late the timer fired.
		s.o.proj.Tick(s.o.Now())
		s.o.proj.Clear()
		s.o.reporter, s.o.release = 0, false
	}
}
