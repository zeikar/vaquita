package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/server"
)

var endDetached = ending{msg: "[vaquita] detached"}

// The replay of a session holds the DA1 queries it sent at startup. The
// terminal answers them again on every attach, and the fence keeps those
// answers from the session, while the answers to live queries reach it.
func TestAttachFenceKeepsReplayRepliesFromSession(t *testing.T) {
	srv := startDaemon(t)
	tty := newFakeTTY()
	cmd := echoCmd + `printf '\033[c\033[c'; exec cat -v`
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: cmd, name: "fence"})

	// Live: the fence goes out at the live, before the session's queries,
	// and this attach is the session's writer, so the terminal is its
	// responder and both replies reach the session.
	tty.waitFor(t, "both live replies echoed by the session", func(out string) bool { return strings.Count(out, da1Text) >= 2 })
	tty.typeIn("one\r")
	tty.waitFor(t, "typed input echoed", contains("one"))
	tty.typeIn(string(rune(detachKey)))
	wantEnding(t, r.wait(), endDetached)
	out := tty.output()
	if n := strings.Count(out, da1Text); n != 2 {
		t.Errorf("session received %d DA1 replies, want 2; output %q", n, out)
	}
	// leave ends with a last fence, answered before the terminal mode is
	// restored.
	if !strings.HasSuffix(out, "one\r\n\x1b[c\r\n[vaquita] detached\r\n") {
		t.Errorf("output ends %q", out[max(0, len(out)-60):])
	}
	sid := r.a.sid

	// Replay: the terminal answers the two replayed queries and the fence.
	tty2 := newFakeTTY()
	r2 := startAttach(t, srv, tty2, attachConfig{sid: sid})
	tty2.waitQueries(t, 3)
	fenceEnd := tty2.queryEnd(2)
	tty2.typeIn("two\r")
	tty2.waitFor(t, "input typed after the fence echoed", func(out string) bool { return strings.Contains(out[fenceEnd:], "two") })
	// The session echoes its input in order, so a leaked reply would have
	// been echoed before "two".
	if after := tty2.output()[fenceEnd:]; strings.Contains(after, da1Text) {
		t.Errorf("replies to the replay reached the session: output after the fence %q", after)
	}
	if n := tty2.queries(); n != 3 {
		t.Errorf("terminal saw %d DA1 queries, want the 2 replayed and the fence", n)
	}
	tty2.typeIn(string(rune(detachKey)))
	wantEnding(t, r2.wait(), endDetached)
}

// While a GUI is subscribed it is the session's writer: the attach is told
// it is read-only and drops what is typed, until the GUI goes.
func TestAttachReadOnlyWhileGUISubscribed(t *testing.T) {
	srv := startDaemon(t)
	tty := newFakeTTY()
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: echoCmd + "exec cat -v"})
	tty.waitQueries(t, 1)
	tty.typeIn("a1\r")
	tty.waitFor(t, "a1 echoed", contains("a1"))

	gui, list := dialDaemonTest(t, srv, protocol.ClientGUI)
	defer gui.Close()
	go func() {
		for range gui.Events() {
		}
	}()
	if len(list) != 1 {
		t.Fatalf("sessions = %+v, want one", list)
	}
	sid := list[0].SID
	if err := gui.Subscribe(sid); err != nil {
		t.Fatal(err)
	}
	tty.waitFor(t, "the read-only notice", contains("\r\n[vaquita] read-only: "))
	tty.typeIn("b2\r")
	// Taken while read-only, before the attach can hear that the GUI has
	// gone.
	tty.waitIdle(t)
	if err := gui.Unsubscribe(sid); err != nil {
		t.Fatal(err)
	}
	tty.waitFor(t, "the writable notice", contains("\r\n[vaquita] writable again\r\n"))
	tty.typeIn("c3\r")
	tty.waitFor(t, "c3 echoed", contains("c3"))
	if out := tty.output(); strings.Contains(out, "b2") {
		t.Errorf("input typed while read-only reached the session; output %q", out)
	}
	tty.typeIn(string(rune(detachKey)))
	wantEnding(t, r.wait(), endDetached)
}

// The terminal answers a query rendered before the attach became the writer
// after the reset that made it so: the reply must not reach the session,
// which has no use for it and would show it as typed garbage. The replay
// closes the gate and a new fence follows it.
func TestAttachLateReplyAfterBecomingWriterDiscarded(t *testing.T) {
	srv := startDaemon(t)
	tty := newFakeTTY()
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: echoCmd + `read -r x; printf '\033[c'; exec cat -v`})
	tty.waitQueries(t, 1)

	gui, list := dialDaemonTest(t, srv, protocol.ClientGUI)
	defer gui.Close()
	go func() {
		for range gui.Events() {
		}
	}()
	sid := list[0].SID
	if err := gui.Subscribe(sid); err != nil {
		t.Fatal(err)
	}
	tty.waitFor(t, "the read-only notice", contains("\r\n[vaquita] read-only: "))
	tty.waitQueries(t, 2) // the replay's fence
	// Slow enough for the reply to come after the writer has changed.
	tty.setSlow(300 * time.Millisecond)
	// The GUI's replay is generation 1.
	if err := gui.Input(sid, 1, []byte("\r")); err != nil {
		t.Fatal(err)
	}
	tty.waitQueries(t, 3)
	if err := gui.Unsubscribe(sid); err != nil {
		t.Fatal(err)
	}
	tty.waitFor(t, "the writable notice", contains("\r\n[vaquita] writable again\r\n"))
	// The new replay holds the query again, and the fence follows it.
	tty.waitQueries(t, 5)
	fenceEnd := tty.queryEnd(4)
	tty.typeIn("after\r")
	tty.waitFor(t, "input typed after the fence echoed", func(out string) bool { return strings.Contains(out[fenceEnd:], "after") })
	if out := tty.output(); strings.Contains(out, da1Text) {
		t.Errorf("a reply owed before the reset reached the session; output %q", out)
	}
	tty.typeIn(string(rune(detachKey)))
	wantEnding(t, r.wait(), endDetached)
}

// An Escape key press reaches the session once nothing follows it, and a
// detach key report split right after its ESC [ still detaches.
func TestAttachHoldsEscapePrefix(t *testing.T) {
	srv := startDaemon(t)
	tty := newFakeTTY()
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: echoCmd + "exec cat -v", escWait: time.Second})
	tty.waitQueries(t, 1)
	tty.typeIn("x")
	tty.waitFor(t, "x echoed", contains("x"))
	tty.typeIn("\x1b[")
	tty.typeIn("92;5u")
	wantEnding(t, r.wait(), endDetached)
	if out := tty.output(); strings.Contains(out, "^[") {
		t.Errorf("part of the detach key reached the session; output %q", out)
	}

	tty2 := newFakeTTY()
	r2 := startAttach(t, srv, tty2, attachConfig{sid: r.a.sid, escWait: 10 * time.Millisecond})
	tty2.waitQueries(t, 1)
	tty2.typeIn("y")
	tty2.waitFor(t, "y echoed", contains("y"))
	tty2.typeIn("\x1b")
	tty2.waitFor(t, "Escape echoed", contains("^["))
	tty2.typeIn(string(rune(detachKey)))
	wantEnding(t, r2.wait(), endDetached)
}

// The exit ends the attachment and leaves the terminal in its default
// modes, whatever the session had set. The answer to the session's last
// query, a cursor position request, is read before the terminal mode is
// restored, though no DA1 count covers it.
func TestAttachExitResetsTerminal(t *testing.T) {
	srv := startDaemon(t)
	tty := newFakeTTY()
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: `printf '\033[?2004h\033[6n'; exit 0`})
	wantEnding(t, r.wait(), ending{msg: "[vaquita] session exited (code 0)"})
	out := tty.output()
	if !strings.Contains(out, "\x1b[?2004h") {
		t.Fatalf("session output missing; output %q", out)
	}
	if want := "\x1b[?2004l\x1b[c\r\n[vaquita] session exited (code 0)\r\n"; !strings.HasSuffix(out, want) {
		t.Errorf("output ends %q, want %q", out[max(0, len(out)-60):], want)
	}
	if u := tty.unread(); u != "" {
		t.Errorf("left for the shell: %q", u)
	}
}

// Attaching to a session that has exited replays it and ends at once, with
// the replies to the replay and the fence still owed. They are read and
// dropped before the terminal mode is restored, or the user's shell would
// get them as typed input.
func TestAttachExitedSessionDrainsReplies(t *testing.T) {
	srv := startDaemon(t)
	gui, _ := dialDaemonTest(t, srv, protocol.ClientGUI)
	defer gui.Close()
	if err := gui.Create(t.TempDir(), `printf '\033[c'; exit 3`, "done", 80, 24); err != nil {
		t.Fatal(err)
	}
	var sid uint32
	for deadline := time.After(attachTimeout); sid == 0; {
		select {
		case ev := <-gui.Events():
			if ev.Err != nil {
				t.Fatal(ev.Err)
			}
			if m, ok := ev.Msg.(protocol.Exit); ok {
				sid = m.SID
			}
		case <-deadline:
			t.Fatal("session did not exit")
		}
	}

	tty := newFakeTTY()
	r := startAttach(t, srv, tty, attachConfig{sid: sid})
	wantEnding(t, r.wait(), ending{msg: "[vaquita] session exited (code 3)"})
	if n := tty.queries(); n != 3 {
		t.Errorf("terminal saw %d DA1 queries, want the replayed one and two fences", n)
	}
	if r.a.fence.Pending() || tty.unread() != "" {
		t.Errorf("replies left for the shell: queries %d, replies %d, unread %q", r.a.fence.queries, r.a.fence.replies, tty.unread())
	}
}

func TestAttachFenceTimeout(t *testing.T) {
	srv := startDaemon(t)
	tty := newFakeTTY()
	tty.mute = true
	start := time.Now()
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: "exec cat", fenceTimeout: 200 * time.Millisecond})
	wantEnding(t, r.wait(), endNoFence)
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("took %v to give up", d)
	}
	if out := tty.output(); !strings.HasSuffix(out, "\x1b[c\r\n"+endNoFence.msg+"\r\n") {
		t.Errorf("output %q", out)
	}
}

// The detach key works while the gate is closed too, and in the kitty
// keyboard protocol's encoding although the session never enabled it.
func TestAttachDetachWhileGateClosed(t *testing.T) {
	srv := startDaemon(t)
	tty := newFakeTTY()
	tty.mute = true
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: "exec cat", fenceTimeout: attachTimeout, drainTimeout: 50 * time.Millisecond})
	tty.waitQueries(t, 1)
	tty.typeIn("typed\x1b[92;5u")
	wantEnding(t, r.wait(), endDetached)
}

// A replay that ends inside an escape sequence holds the fence back; with no
// output to complete the sequence, attach gives up rather than write the
// fence where the terminal would not read it as a query.
func TestAttachBoundaryTimeout(t *testing.T) {
	srv := startDaemon(t)
	tty := newFakeTTY()
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: `printf 'x\033['; exec cat`})
	tty.waitFor(t, "the unfinished sequence", contains("x\x1b["))
	tty.typeIn(string(rune(detachKey)))
	wantEnding(t, r.wait(), endDetached)
	// The sequence is cancelled so that the notice and the shell's prompt
	// after it are not read as part of it.
	if out := tty.output(); !strings.HasSuffix(out, "x\x1b[\x18\x1b[c\r\n[vaquita] detached\r\n") {
		t.Errorf("output ends %q", out[max(0, len(out)-60):])
	}

	tty2 := newFakeTTY()
	r2 := startAttach(t, srv, tty2, attachConfig{sid: r.a.sid, boundaryTimeout: 200 * time.Millisecond})
	wantEnding(t, r2.wait(), endBoundary)
	// The only fence is leave's, after the sequence has been cancelled.
	if n := tty2.queries(); n != 1 {
		t.Errorf("terminal saw %d DA1 queries, want only leave's", n)
	}
	if out := tty2.output(); !strings.HasSuffix(out, "x\x1b[\x18\x1b[c\r\n"+endBoundary.msg+"\r\n") {
		t.Errorf("output ends %q", out[max(0, len(out)-60):])
	}
}

// sizeWatcher follows the size of a daemon's one session.
func sizeWatcher(t *testing.T, srv *server.Server) func(cols, rows int) {
	obs, _ := dialDaemonTest(t, srv, protocol.ClientAttach)
	t.Cleanup(func() { obs.Close() })
	return func(cols, rows int) {
		t.Helper()
		for deadline := time.After(attachTimeout); ; {
			select {
			case ev := <-obs.Events():
				if ev.Err != nil {
					t.Fatal(ev.Err)
				}
				if m, ok := ev.Msg.(protocol.Sessions); ok && len(m.List) == 1 && m.List[0].Cols == cols && m.List[0].Rows == rows {
					return
				}
			case <-deadline:
				t.Fatalf("session never %dx%d", cols, rows)
			}
		}
	}
}

// Once the gate opens the session gets this terminal's size, with a nudge
// that makes full-screen programs redraw, and every SIGWINCH after that.
func TestAttachResize(t *testing.T) {
	srv := startDaemon(t)
	waitSize := sizeWatcher(t, srv)
	tty := newFakeTTY()
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: "exec cat"})
	waitSize(79, 24)
	waitSize(80, 24)
	tty.setSize(100, 30)
	r.winch <- syscall.SIGWINCH
	waitSize(100, 30)
	r.stop <- syscall.SIGTERM
	wantEnding(t, r.wait(), ending{msg: "[vaquita] terminated; detached", failed: true})
}

// A one-column terminal cannot lose a column; the nudge takes a row.
func TestAttachNudgeOneColumn(t *testing.T) {
	srv := startDaemon(t)
	waitSize := sizeWatcher(t, srv)
	tty := newFakeTTY()
	tty.setSize(1, 24)
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: "exec cat"})
	waitSize(1, 23)
	waitSize(1, 24)
	tty.typeIn(string(rune(detachKey)))
	wantEnding(t, r.wait(), endDetached)
}

// The fence counts the replies in the whole read, past a detach key too:
// otherwise leave would wait out its timeout for a reply already read.
func TestAttachInputCountsRepliesAfterDetachKey(t *testing.T) {
	a := newAttacher(attachConfig{}, nil, nil, io.Discard, nil, func() {})
	a.fence.Query()
	if e := a.input(input{p: []byte("\x1b[92;5u" + da1Reply)}); e == nil || *e != endDetached {
		t.Fatalf("input ended with %+v, want a detach", e)
	}
	if a.fence.Pending() {
		t.Errorf("reply after the detach key not counted: queries %d, replies %d", a.fence.queries, a.fence.replies)
	}
}

// leave restores the terminal mode even when something before it panics:
// sync.Once would never run it again.
func TestAttachLeaveRestoresOnPanic(t *testing.T) {
	restored := 0
	// The nil client makes the unsubscribe panic.
	a := newAttacher(attachConfig{}, nil, nil, io.Discard, nil, func() { restored++ })
	a.sid = 1
	func() {
		defer func() {
			if recover() == nil {
				t.Error("leave did not panic")
			}
		}()
		a.leave(endDetached)
	}()
	if restored != 1 {
		t.Errorf("terminal mode restored %d times, want once", restored)
	}
}

// A terminal that falls further behind than the ring holds is sent a fresh
// replay in a new generation. attach returns the terminal to its defaults
// before it, so that the new prefix applies, closes the gate and fences
// again; the reply to the old fence, still on its way, is absorbed.
func TestAttachGenerationReset(t *testing.T) {
	srv := startDaemon(t)
	tty := newFakeTTY()
	tty.holdWrites()
	// 4MB is more than the 1MB sent unacknowledged plus the 1MB ring, so
	// the start, with its mode, is evicted and lives on in the prefix.
	cmd := echoCmd + `printf '\033[?2004h'; head -c 4000000 /dev/zero | tr '\0' y; printf END; exec cat -v`
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: cmd})
	waitOutput(t, srv, "END")
	tty.release()

	tty.waitQueries(t, 2)
	second := tty.queryEnd(1)
	out := tty.output()
	reset := strings.LastIndex(out[:second], "\x1b[?2004l")
	if reset < 0 || !strings.Contains(out[reset:second], "\x1b[?2004h") {
		t.Fatalf("no reset followed by the new prefix before the second fence; output before it ends %q", out[max(0, second-200):second])
	}
	tty.typeIn("z\r")
	tty.waitFor(t, "input echoed after the new fence", func(out string) bool { return strings.Contains(out[second:], "z") })
	tty.typeIn(string(rune(detachKey)))
	wantEnding(t, r.wait(), endDetached)
	if r.a.gen != 2 {
		t.Errorf("generation %d, want 2", r.a.gen)
	}
}

// waitOutput follows the daemon's one session as a read-only attach,
// acking everything, until s has been written to it.
func waitOutput(t *testing.T, srv *server.Server, s string) {
	t.Helper()
	c, list := dialDaemonTest(t, srv, protocol.ClientAttach)
	defer c.Close()
	subscribed := false
	var off uint64
	var tail []byte
	prefixDue := false
	for deadline := time.After(attachTimeout); !strings.Contains(string(tail), s); {
		// The session is listed once its create has been handled.
		if !subscribed && len(list) == 1 {
			if err := c.Subscribe(list[0].SID); err != nil {
				t.Fatal(err)
			}
			subscribed = true
		}
		select {
		case ev := <-c.Events():
			if ev.Err != nil {
				t.Fatal(ev.Err)
			}
			switch m := ev.Msg.(type) {
			case protocol.Sessions:
				list = m.List
			case protocol.Replay:
				off, prefixDue = m.From, true
			}
			f := ev.Frame
			if f == nil {
				continue
			}
			if f.Type == protocol.FrameReplay && prefixDue {
				prefixDue = false
				continue
			}
			off += uint64(len(f.Payload))
			tail = append(tail[len(tail)-min(len(tail), len(s)):], f.Payload...)
			if err := c.Ack(f.SID, f.Gen, off); err != nil {
				t.Fatal(err)
			}
		case <-deadline:
			t.Fatalf("session never wrote %q", s)
		}
	}
}

func TestAttachUnknownSession(t *testing.T) {
	srv := startDaemon(t)
	tty := newFakeTTY()
	r := startAttach(t, srv, tty, attachConfig{sid: 99})
	wantEnding(t, r.wait(), ending{msg: "[vaquita] no-session: vaquitad has no session 99", failed: true})
}

func TestAttachLostConnection(t *testing.T) {
	srv := startDaemon(t)
	tty := newFakeTTY()
	r := startAttach(t, srv, tty, attachConfig{create: true, cwd: t.TempDir(), cmd: "exec cat"})
	tty.waitQueries(t, 1)
	r.a.c.Close()
	e := r.wait()
	if !e.failed || !strings.HasPrefix(e.msg, "[vaquita] lost the connection to vaquitad") {
		t.Errorf("ended with %+v", e)
	}
}

func TestParseAttach(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		args []string
		want attachConfig
	}{
		{[]string{"7"}, attachConfig{sid: 7}},
		{[]string{"--new"}, attachConfig{create: true, cwd: wd}},
		{[]string{"--new", "--cwd", "sub", "--name", "agent"}, attachConfig{create: true, cwd: filepath.Join(wd, "sub"), name: "agent"}},
		{
			[]string{"--new", "--cwd", "/tmp", "--", "printf", `%s\n`, "a b", "c;d"},
			attachConfig{create: true, cwd: "/tmp", cmd: `'printf' '%s\n' 'a b' 'c;d'`},
		},
	} {
		got, err := parseAttach(tc.args)
		if err != nil || got != tc.want {
			t.Errorf("parseAttach(%q) = %+v, %v; want %+v", tc.args, got, err, tc.want)
		}
	}
	for _, args := range [][]string{{}, {"0"}, {"x"}, {"1", "2"}, {"--cwd", "/tmp", "1"}, {"--name", "n", "1"}} {
		if got, err := parseAttach(args); err == nil {
			t.Errorf("parseAttach(%q) = %+v, want an error", args, got)
		}
	}
}
