package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/client"
	"github.com/zeikar/vaquita/daemon/internal/protocol"
)

const (
	defaultBoundaryTimeout = 2 * time.Second
	defaultFenceTimeout    = 5 * time.Second
	defaultNudgeDelay      = 400 * time.Millisecond
	// defaultDrainTimeout bounds the wait for the terminal's answers still
	// owed when attach leaves; a terminal answers within milliseconds.
	defaultDrainTimeout = 500 * time.Millisecond
)

// attachConfig is what to attach to. Zero durations take the defaults.
type attachConfig struct {
	// create starts a new session from cwd, cmd and name; otherwise attach
	// subscribes to sid.
	create         bool
	sid            uint32
	cwd, cmd, name string

	boundaryTimeout time.Duration
	fenceTimeout    time.Duration
	nudgeDelay      time.Duration
	drainTimeout    time.Duration
}

// ending is why an attachment ends.
type ending struct {
	msg    string // the notice leave writes
	failed bool   // the command exits with status 1
	// noDrain skips waiting for the terminal's answers still owed: the
	// terminal is gone, or has shown it does not answer.
	noDrain bool
}

var (
	endBoundary = ending{msg: "[vaquita] output never reached a safe boundary; detached", failed: true}
	endNoFence  = ending{msg: "[vaquita] terminal did not answer DA1; detached", failed: true, noDrain: true}
)

// input is one read from the terminal.
type input struct {
	p   []byte
	err error
}

// attacher connects a terminal to one session. Everything but the reads
// from the terminal happens on the goroutine running run, so its state
// needs no locks.
type attacher struct {
	cfg     attachConfig
	c       *client.Client
	in      io.Reader
	scr     *screen
	fence   *Fence
	size    func() (cols, rows int, err error)
	restore func() // puts the terminal back in the mode it was found in

	stdin chan input    // unbuffered, so a read is handled before the next
	done  chan struct{} // closed by leave; ends readInput
	keys  keyScanner

	sid       uint32 // 0 until a create's first replay names the session
	gen       uint32
	off       uint64 // ring offset after the output written so far
	replays   int
	prefixDue bool // the next replay frame is the mode prefix
	roKnown   bool // a live has said whether this attach may write
	writable  bool
	ended     bool // the exit has ended the subscription

	deadline    *time.Timer // the boundary or fence timeout, when one runs
	deadlineEnd ending
	nudge       *time.Timer // the second step of the resize nudge

	leaveOnce sync.Once
}

func newAttacher(cfg attachConfig, c *client.Client, in io.Reader, out io.Writer, size func() (int, int, error), restore func()) *attacher {
	for _, d := range []struct {
		v   *time.Duration
		def time.Duration
	}{
		{&cfg.boundaryTimeout, defaultBoundaryTimeout},
		{&cfg.fenceTimeout, defaultFenceTimeout},
		{&cfg.nudgeDelay, defaultNudgeDelay},
		{&cfg.drainTimeout, defaultDrainTimeout},
	} {
		if *d.v == 0 {
			*d.v = d.def
		}
	}
	f := NewFence()
	return &attacher{
		cfg:     cfg,
		c:       c,
		in:      in,
		scr:     newScreen(out, f),
		fence:   f,
		size:    size,
		restore: restore,
		stdin:   make(chan input),
		done:    make(chan struct{}),
	}
}

// run attaches until something ends the attachment, then leaves. stop
// delivers SIGINT and SIGTERM, winch SIGWINCH; either may be nil.
func (a *attacher) run(stop, winch <-chan os.Signal) ending {
	e := a.loop(stop, winch)
	a.leave(e)
	return e
}

func (a *attacher) loop(stop, winch <-chan os.Signal) ending {
	go a.readInput()
	if e := a.start(); e != nil {
		return *e
	}
	for {
		var e *ending
		select {
		case ev, ok := <-a.c.Events():
			e = a.event(ev, ok)
		case in := <-a.stdin:
			e = a.input(in)
		case <-winch:
			e = a.resize()
		case sig := <-stop:
			e = &ending{msg: fmt.Sprintf("[vaquita] %v; detached", sig), failed: true}
		case <-timerC(a.deadline):
			a.deadline = nil
			e = &a.deadlineEnd
		case <-timerC(a.nudge):
			a.nudge = nil
			e = a.resize()
		}
		if e != nil {
			return *e
		}
	}
}

func (a *attacher) start() *ending {
	if !a.cfg.create {
		a.sid = a.cfg.sid
		return sent(a.c.Subscribe(a.sid))
	}
	cols, rows, err := a.size()
	if err != nil {
		return sizeFailed(err)
	}
	return sent(a.c.Create(a.cfg.cwd, a.cfg.cmd, a.cfg.name, cols, rows))
}

// readInput hands the terminal's input to run, one read at a time.
func (a *attacher) readInput() {
	buf := make([]byte, 32<<10)
	for {
		n, err := a.in.Read(buf)
		if n == 0 && err == nil {
			continue
		}
		select {
		case a.stdin <- input{p: bytes.Clone(buf[:n]), err: err}:
		case <-a.done:
			return
		}
		if err != nil {
			return
		}
	}
}

func (a *attacher) event(ev client.Event, ok bool) *ending {
	if !ok || ev.Err != nil {
		msg := "[vaquita] lost the connection to vaquitad"
		if ev.Err != nil {
			msg += ": " + ev.Err.Error()
		}
		return &ending{msg: msg, failed: true}
	}
	if ev.Frame != nil {
		return a.frame(*ev.Frame)
	}
	switch m := ev.Msg.(type) {
	case protocol.Replay:
		return a.replay(m)
	case protocol.Live:
		return a.live(m)
	case protocol.RO:
		return a.setRO(m.RO)
	case protocol.Exit:
		a.ended = true
		return &ending{msg: fmt.Sprintf("[vaquita] session exited (code %d)", m.Code)}
	case protocol.Error:
		return a.daemonError(m)
	}
	// Sessions lists are of no use to an attach.
	return nil
}

func (a *attacher) replay(m protocol.Replay) *ending {
	// This connection has no other subscription, so the first replay after
	// a create is of the session it started.
	a.sid = m.SID
	if err := a.scr.beginReplay(a.replays == 0); err != nil {
		return writeFailed(err)
	}
	a.replays++
	a.clearDeadline()
	a.gen, a.off, a.prefixDue = m.Gen, m.From, true
	return nil
}

func (a *attacher) live(m protocol.Live) *ending {
	a.off = m.Off
	if e := a.setRO(m.RO); e != nil {
		return e
	}
	fenced, err := a.scr.armFence()
	if err != nil {
		return writeFailed(err)
	}
	if fenced {
		a.setDeadline(a.cfg.fenceTimeout, endNoFence)
	} else {
		a.setDeadline(a.cfg.boundaryTimeout, endBoundary)
	}
	return nil
}

func (a *attacher) frame(f protocol.Frame) *ending {
	var fenced bool
	var err error
	switch {
	case f.Type == protocol.FrameReplay && a.prefixDue:
		// The prefix restores the modes in effect at the ring start. It is
		// not part of the ring, so it is not acked.
		a.prefixDue = false
		return writeFailed(a.scr.write(f.Payload))
	case f.Type == protocol.FrameReplay:
		err = a.scr.write(f.Payload)
	case f.Type == protocol.FrameLive:
		fenced, err = a.scr.live(f.Payload)
	default:
		return &ending{msg: fmt.Sprintf("[vaquita] vaquitad sent a frame of unknown type %#x", f.Type), failed: true}
	}
	if err != nil {
		return writeFailed(err)
	}
	if fenced {
		a.setDeadline(a.cfg.fenceTimeout, endNoFence)
	}
	a.off += uint64(len(f.Payload))
	// Acked once the terminal has taken the bytes: the daemon holds back
	// what is beyond its cap of unacknowledged output, so a slow terminal
	// slows the stream instead of making it pile up here.
	return sent(a.c.Ack(f.SID, f.Gen, a.off))
}

// setRO records whether this attach may write to the session and tells
// the user when that changes.
func (a *attacher) setRO(ro bool) *ending {
	changed := a.roKnown && ro == a.writable
	first := !a.roKnown
	a.roKnown, a.writable = true, !ro
	var msg string
	switch {
	case ro && (first || changed):
		// The writer is the earliest GUI subscriber or, without one, the
		// earliest attach.
		msg = "[vaquita] read-only: a GUI or an earlier attach is the session's writer"
	case !ro && changed:
		msg = "[vaquita] writable again"
	default:
		return nil
	}
	if err := a.scr.notice(msg); err != nil {
		return writeFailed(err)
	}
	// The session has the writer's size, which need not be this terminal's.
	if a.writable && a.fence.Open() {
		return a.startNudge()
	}
	return nil
}

func (a *attacher) daemonError(m protocol.Error) *ending {
	switch {
	case a.sid == 0:
		return &ending{msg: fmt.Sprintf("[vaquita] vaquitad could not create the session (%s); see vaquitad.log", m.Code), failed: true}
	case m.Code == protocol.CodeNoSession:
		return &ending{msg: fmt.Sprintf("[vaquita] %s: vaquitad has no session %d", m.Code, a.sid), failed: true}
	}
	// What remains concerns a single input frame (the program is not
	// reading its input) or resize, which a terminal could not take back
	// either; a notice would land in the middle of the session's screen.
	return nil
}

// input forwards what the user types. The fence counts the replies in the
// whole read, past a detach key too. The detach key works whether the gate
// is open or not, so the keys are scanned in what the gate discards as well;
// the gate opens just after a DA1 reply, where the key scanner stands in
// ground state, so scanning the read in two parts is the same as in one.
func (a *attacher) input(in input) *ending {
	wasOpen := a.fence.Open()
	passed := a.fence.Filter(in.p)
	_, detach := a.keys.scan(in.p[:len(in.p)-len(passed)])
	var p []byte
	if !detach {
		p, detach = a.keys.scan(passed)
	}
	if !wasOpen && a.fence.Open() {
		a.clearDeadline()
		if a.writable {
			if e := a.startNudge(); e != nil {
				return e
			}
		}
	}
	// A read-only attach is not the session's responder: the writer
	// answers its queries, and keys typed here are dropped.
	if len(p) > 0 && a.writable {
		if e := sent(a.c.Input(a.sid, a.gen, p)); e != nil {
			return e
		}
	}
	switch {
	case detach:
		return &ending{msg: "[vaquita] detached"}
	case errors.Is(in.err, io.EOF):
		return &ending{msg: "[vaquita] terminal input closed; detached", failed: true, noDrain: true}
	case in.err != nil:
		return &ending{msg: "[vaquita] read the terminal: " + in.err.Error(), failed: true, noDrain: true}
	}
	return nil
}

// startNudge resizes the session one column narrower (one row shorter in a
// one-column terminal), and back after nudgeDelay: a program on the
// alternate screen redraws only on SIGWINCH, and resizing to the size the
// session already has sends none.
func (a *attacher) startNudge() *ending {
	cols, rows, err := a.size()
	if err != nil {
		return sizeFailed(err)
	}
	switch {
	case cols > 1:
		err = a.c.Resize(a.sid, cols-1, rows)
	case cols == 1 && rows > 1:
		err = a.c.Resize(a.sid, cols, rows-1)
	default:
		return nil
	}
	if e := sent(err); e != nil {
		return e
	}
	if a.nudge != nil {
		a.nudge.Stop()
	}
	a.nudge = time.NewTimer(a.cfg.nudgeDelay)
	return nil
}

// resize gives the session this terminal's size, while it may.
func (a *attacher) resize() *ending {
	if !a.writable {
		return nil
	}
	cols, rows, err := a.size()
	if err != nil {
		return sizeFailed(err)
	}
	return sent(a.c.Resize(a.sid, cols, rows))
}

func (a *attacher) setDeadline(d time.Duration, e ending) {
	a.clearDeadline()
	a.deadline, a.deadlineEnd = time.NewTimer(d), e
}

func (a *attacher) clearDeadline() {
	if a.deadline != nil {
		a.deadline.Stop()
		a.deadline = nil
	}
}

// timerC is t's channel, or nil, which blocks forever, when no timer runs.
func timerC(t *time.Timer) <-chan time.Time {
	if t == nil {
		return nil
	}
	return t.C
}

// leave ends the attachment, once, however it ended: it unsubscribes,
// returns the terminal to its default modes, waits briefly for the answers
// the terminal still owes, writes e's notice, restores the terminal mode and
// closes the connection. The restore is deferred first, so that it runs
// even if something before it panics: sync.Once counts a panicking call as
// done.
func (a *attacher) leave(e ending) {
	a.leaveOnce.Do(func() {
		defer close(a.done)
		// The connection is going away whatever Close reports.
		defer a.c.Close()
		defer a.restore()
		if a.sid != 0 && !a.ended {
			// Closing the connection ends the subscription too; this only
			// stops the output sooner. An error is the connection's, which
			// is being closed anyway.
			_ = a.c.Unsubscribe(a.sid)
		}
		// Write errors are not reported: the terminal is where they would
		// go. The reset ends at a boundary, so a fence can follow it.
		if err := a.scr.reset(); err == nil && !e.noDrain {
			a.drain()
		}
		_ = a.scr.out([]byte("\r\n" + e.msg + "\r\n"))
	})
}

// drain writes a last fence and discards input until the terminal has
// answered it, or drainTimeout has passed. With the terminal mode restored,
// the shell would read what the terminal still owes as typed input: the
// garbage the fence exists to keep out. That can be replies to a replay
// cut short by an exit, or to the session's live queries; terminals answer
// in order, so once the fence is answered, every reply to anything written
// before it, a cursor position report as much as a DA1, has been read.
func (a *attacher) drain() {
	if a.scr.writeFence() != nil {
		return
	}
	t := time.NewTimer(a.cfg.drainTimeout)
	defer t.Stop()
	for a.fence.Pending() {
		select {
		case in := <-a.stdin:
			a.fence.Filter(in.p)
			if in.err != nil {
				return
			}
		case <-t.C:
			return
		}
	}
}

// sent turns an error sending to the daemon into the ending it causes.
func sent(err error) *ending {
	if err == nil {
		return nil
	}
	return &ending{msg: "[vaquita] lost the connection to vaquitad: " + err.Error(), failed: true}
}

func writeFailed(err error) *ending {
	if err == nil {
		return nil
	}
	return &ending{msg: "[vaquita] write to the terminal: " + err.Error(), failed: true, noDrain: true}
}

func sizeFailed(err error) *ending {
	return &ending{msg: "[vaquita] read the terminal size: " + err.Error(), failed: true}
}
