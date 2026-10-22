package status

import (
	"slices"
	"strings"
	"time"
)

// View states. The empty state shows nothing.
const (
	ViewWorking = "working"
	ViewInput   = "input"
	ViewAuth    = "auth"
	ViewDone    = "done"
	ViewError   = "error"
)

// Notification kinds.
const (
	NotifyDone  = "done"
	NotifyError = "error"
	NotifyInput = "input"
	NotifyAuth  = "auth"
)

const (
	// DoneQuiet is how long a done must stand before it is notified: agents
	// flicker from done back to working.
	DoneQuiet = 1500 * time.Millisecond
	// DoneMsgWait is how long a done without a msg waits for a later done
	// that carries one. Claude Code sends its summary in a second done about
	// 2.5 s after the first.
	DoneMsgWait = 3 * time.Second
	// MaxPendingNotes bounds the notifications kept until Take; beyond it the
	// oldest is dropped, so a projector nobody drains stays small.
	MaxPendingNotes = 16
)

const (
	appCodex = "codex"
	// planPrompt starts the OSC 9 body of Codex's plan-mode popups. Its
	// "Implement this plan?" popup reports idle, not blocked, and the turn
	// sends no completion notification of its own.
	planPrompt = "Plan mode prompt:"
)

// View is what the sidebar shows for a session.
type View struct {
	State string
	Kind  string // permission or question, for an input view
	Msg   string
}

// Notification is a desktop notification the projection raises.
type Notification struct {
	Kind string
	Msg  string
}

// Projector turns a session's root reports and OSC 9 notifications into the
// View the sidebar shows and the Notifications to raise. It has no clock and
// no goroutines: calls that depend on time take now, and the caller calls
// Tick once Deadline has passed. The zero value shows nothing. It is not safe
// for concurrent use.
//
// Agents end a turn differently. Claude Code sends done, then a second done
// with a summary msg. Codex sends no done: a finished turn is an OSC 9 with
// the last reply followed by idle, while a cancel, a denial or its start-up
// is a bare idle. So an idle means done only for Codex right after an OSC 9,
// and a done is notified only after a working, once it has stood for
// DoneQuiet with a msg or DoneMsgWait without one.
type Projector struct {
	view   View
	unread bool // only while the view is done or error
	// soft marks an input view inferred from Codex's plan prompt idle, which
	// Seen releases.
	soft bool
	// turn is set by working and cleared when the turn ends; only a done that
	// ends a turn is notified.
	turn bool
	// osc9 is the body of the last OSC 9 that no root report has consumed
	// yet. OSC 9 notifications are never empty.
	osc9 string
	// doneAt is when the turn's done arrived; donePending says its
	// notification is still to be raised. It is only set while the view is
	// done.
	doneAt      time.Time
	donePending bool
	changed     bool
	notes       []Notification
}

// Report applies a root report. Callers keep reports with an ID to Records,
// so a child's done never completes its parent. The report consumes the
// pending OSC 9 whatever its state: Codex writes the two together.
func (p *Projector) Report(r Report, now time.Time) {
	// A notification that came due before this report is raised first, so
	// the outcome does not depend on how late the caller's timer fired.
	p.Tick(now)
	body := p.osc9
	p.osc9 = ""
	switch r.State {
	case StateWorking:
		p.show(View{State: ViewWorking, Msg: r.Msg}, false)
		p.turn = true
	case StateBlocked:
		// Codex writes an OSC 9 with the blocked that names the command or
		// question it waits on; for other agents it only fills in a missing
		// msg.
		msg := r.Msg
		if body != "" && (r.App == appCodex || msg == "") {
			msg = body
		}
		if r.Kind == "auth" {
			p.show(View{State: ViewAuth, Msg: msg}, false)
			p.notify(NotifyAuth, msg)
		} else {
			p.show(View{State: ViewInput, Kind: r.Kind, Msg: msg}, false)
			p.notify(NotifyInput, msg)
		}
	case StateError:
		p.show(View{State: ViewError, Msg: r.Msg}, true)
		p.turn = false
		p.notify(NotifyError, r.Msg)
	case StateDone:
		p.done(r.Msg, now)
	case StateIdle:
		switch {
		case r.App == appCodex && strings.HasPrefix(body, planPrompt):
			p.show(View{State: ViewInput, Msg: body}, false)
			p.soft = true
			p.notify(NotifyInput, body)
		case r.App == appCodex && body != "":
			p.done(body, now)
		case p.view.State == ViewDone || p.view.State == ViewError:
			// An outcome stays until it is seen or replaced.
		default:
			p.show(View{}, false)
		}
		p.turn = false
	case StateClear:
		p.Clear()
	}
	// A done whose msg arrived after the quiet period is due now.
	p.Tick(now)
}

// done applies a done for the root. A done after a done only updates the msg:
// it belongs to the same turn.
func (p *Projector) done(msg string, now time.Time) {
	if p.view.State == ViewDone {
		if msg != "" {
			p.show(View{State: ViewDone, Msg: msg}, p.unread)
		}
		return
	}
	p.show(View{State: ViewDone, Msg: msg}, true)
	if p.turn {
		p.doneAt, p.donePending, p.turn = now, true, false
	}
}

// OSC9 holds an OSC 9 body for the next root report, which decides what it
// means. A newer one replaces it.
func (p *Projector) OSC9(body string) { p.osc9 = body }

// Interrupt ends whatever was working or waiting for input, as a new shell
// prompt or the reporter's death does. A done or error stays, and so does
// the done's pending notification.
func (p *Projector) Interrupt() {
	p.osc9, p.turn = "", false
	switch p.view.State {
	case ViewWorking, ViewInput, ViewAuth:
		p.show(View{}, false)
	}
}

// Clear empties the view and drops the OSC 9 and a done notification not yet
// raised, as a clear report or a terminal reset does. Notifications already
// raised stay for Take.
func (p *Projector) Clear() {
	p.show(View{}, false)
	p.osc9, p.turn = "", false
}

// Seen marks the session as looked at. It also releases the input inferred
// from Codex's plan prompt: no report ends it when the user dismisses the
// popup.
func (p *Projector) Seen() {
	if p.soft {
		p.show(View{}, false)
		return
	}
	p.show(p.view, false)
}

// Tick raises the done notification once Deadline has passed.
func (p *Projector) Tick(now time.Time) {
	if d, ok := p.Deadline(); ok && !now.Before(d) {
		p.notify(NotifyDone, p.view.Msg)
		p.donePending = false
	}
}

// Deadline reports when Tick has a notification to raise, if ever.
func (p *Projector) Deadline() (time.Time, bool) {
	if !p.donePending {
		return time.Time{}, false
	}
	if p.view.Msg != "" {
		return p.doneAt.Add(DoneQuiet), true
	}
	return p.doneAt.Add(DoneMsgWait), true
}

// View returns what the sidebar shows and whether it is unread.
func (p *Projector) View() (View, bool) { return p.view, p.unread }

// Take reports whether the view or the unread flag changed since the last
// Take, and hands over the notifications raised since then, oldest first.
func (p *Projector) Take() (changed bool, notes []Notification) {
	changed, notes = p.changed, p.notes
	p.changed, p.notes = false, nil
	return changed, notes
}

// Pending reports whether Take has a view change or a notification to hand over.
func (p *Projector) Pending() bool { return p.changed || len(p.notes) > 0 }

// show sets the view, noting whether anything visible changed. Only the plan
// prompt's input is soft, so any view set here is not. Leaving the done view
// cancels its pending notification: a working within DoneQuiet is the agent
// flickering, and a blocked or error raises its own notification.
func (p *Projector) show(v View, unread bool) {
	if v != p.view || unread != p.unread {
		p.changed = true
	}
	p.view, p.unread, p.soft = v, unread, false
	if v.State != ViewDone {
		p.donePending = false
	}
}

func (p *Projector) notify(kind, msg string) {
	if len(p.notes) == MaxPendingNotes {
		p.notes = slices.Delete(p.notes, 0, 1)
	}
	p.notes = append(p.notes, Notification{Kind: kind, Msg: msg})
}
