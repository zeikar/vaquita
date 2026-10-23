package server

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/sys/unix"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/session"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

const sessTimeout = 10 * time.Second

// startSessionServer starts a server whose sessions run /bin/sh with a fresh
// HOME, so that none of the user's rc files affect them. endSessions cleans up
// after them before the server closes.
func startSessionServer(t *testing.T, opts Options) *Server {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	srv := listen(t, opts)
	t.Cleanup(func() { endSessions(t, srv) })
	return srv
}

// endSessions SIGKILLs whatever the test's sessions left alive, then waits
// until each has finished its exit, so that nothing writes state.json while
// the test's home is being removed.
func endSessions(t *testing.T, srv *Server) {
	srv.table.mu.Lock()
	var sessions []*session.Session
	for _, e := range srv.table.entries {
		if e.sess != nil {
			sessions = append(sessions, e.sess)
		}
	}
	srv.table.mu.Unlock()
	deadline := time.Now().Add(sessTimeout)
	for _, s := range sessions {
		// Members keep the session id after the shell has died, so a
		// child forked between a scan and the SIGKILL turns up in the next
		// scan; only an empty scan ends the loop.
		for {
			pids, _, err := session.SessionPIDs(s.PID())
			if err != nil {
				t.Errorf("scan session of pid %d: %v", s.PID(), err)
				break
			}
			if len(pids) == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Errorf("session of pid %d still has %v", s.PID(), pids)
				break
			}
			for _, pid := range pids {
				if err := unix.Kill(pid, unix.SIGKILL); err != nil && !errors.Is(err, unix.ESRCH) {
					t.Errorf("kill %d: %v", pid, err)
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	// Nothing reports the end of the exit handler, but a session closes its
	// master only after OnExit has returned, and Resize then fails with
	// ErrClosed.
	for _, s := range sessions {
		for !errors.Is(s.Resize(80, 24), session.ErrClosed) {
			if time.Now().After(deadline) {
				t.Errorf("session of pid %d never finished exiting", s.PID())
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

// savedRecord returns sid's record in state.json, or nil.
func savedRecord(t *testing.T, srv *Server, sid uint32) *state.SessionRecord {
	t.Helper()
	st, err := state.Load(srv.opts.Home)
	if err != nil {
		t.Fatal(err)
	}
	for i := range st.Sessions {
		if st.Sessions[i].SID == int(sid) {
			return &st.Sessions[i]
		}
	}
	return nil
}

// The creator is subscribed before the shell starts, so its first output
// goes out live, where the client may answer queries in it; a later
// subscriber gets the same bytes as a replay.
func TestCreateSendsStartupLive(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create("printf startup")
	a.waitLive(sid, "startup")
	sa := a.stream(sid)
	if r := sa.replays[0]; r.Gen != 1 || r.From != 0 || r.To != 0 || r.Cols != 80 || r.Rows != 24 {
		t.Errorf("creator's replay = %+v, want generation 1 of [0, 0) at 80x24", r)
	}
	if len(sa.lives) != 1 || sa.lives[0].Off != 0 || sa.lives[0].RO {
		t.Errorf("creator's live = %+v, want one at offset 0, writable", sa.lives)
	}
	if len(sa.replayed) != 0 || len(sa.prefixes) != 1 || len(sa.prefixes[0]) != 0 {
		t.Errorf("creator was replayed %q after prefixes %q, want one empty prefix", sa.replayed, sa.prefixes)
	}

	b := dialClient(t, srv)
	if err := b.c.Subscribe(sid); err != nil {
		t.Fatal(err)
	}
	b.waitFor("live", func() bool { return len(b.stream(sid).lives) > 0 })
	sb := b.stream(sid)
	r := sb.replays[0]
	if r.Gen != 1 || r.From != 0 || r.To < uint64(len("startup")) {
		t.Errorf("subscriber's replay = %+v, want generation 1 from 0", r)
	}
	// Nothing has left the ring, so the modes at its start are a fresh
	// terminal's.
	if len(sb.prefixes) != 1 || len(sb.prefixes[0]) != 0 {
		t.Errorf("subscriber's prefixes = %q, want one empty", sb.prefixes)
	}
	if !bytes.Contains(sb.replayed, []byte("startup")) {
		t.Errorf("subscriber's replay %q lacks the startup output", sb.replayed)
	}
	if l := sb.lives[0]; l.Off != r.To || l.Gen != r.Gen {
		t.Errorf("subscriber's live = %+v after replay %+v", l, r)
	}
}

// A stub function stands in for codex, so the test never launches the real
// agent: a login shell sources $HOME/.profile before running the command.
func TestCreateKeepsTheTypedCommandForCodex(t *testing.T) {
	srv := startSessionServer(t, Options{})
	stub := "codex() { printf 'stub:%s\\n' \"$*\"; }\n"
	if err := os.WriteFile(filepath.Join(os.Getenv("HOME"), ".profile"), []byte(stub), 0o644); err != nil {
		t.Fatal(err)
	}
	a := dialClient(t, srv)
	sid := a.create("codex resume --last")
	a.waitLive(sid, `stub:-c tui.notifications=["agent-turn-complete","approval-requested","plan-mode-prompt","async-question"] -c tui.notification_method="osc9" -c tui.notification_condition="always" resume --last`)
	i := a.waitListed(sid, running)
	if i.Cmd != "codex resume --last" {
		t.Errorf("listed cmd %q, want what the user typed", i.Cmd)
	}
	if r := savedRecord(t, srv, sid); r == nil || r.Cmd != "codex resume --last" {
		t.Errorf("state.json holds %+v", r)
	}
}

func TestCreateBroadcastsAndSaves(t *testing.T) {
	srv := startSessionServer(t, Options{})
	observer := dialClient(t, srv)
	a := dialClient(t, srv)
	sid := a.create("sleep 60")
	i := observer.waitListed(sid, running)
	if i.Cmd != "sleep 60" || i.Name != "test" || i.Cols != 80 || i.Rows != 24 || i.PID <= 1 || len(i.Inc) != 16 {
		t.Errorf("listed %+v", i)
	}
	if r := savedRecord(t, srv, sid); r == nil || r.PID != i.PID || r.Cmd != "sleep 60" {
		t.Errorf("state.json holds %+v for session %d, want pid %d", r, sid, i.PID)
	}
}

func TestInput(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create("read l; printf got:$l")
	if err := a.c.Input(sid, a.stream(sid).gen, []byte("abc\n")); err != nil {
		t.Fatal(err)
	}
	a.waitLive(sid, "got:abc")
}

func TestResize(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create("read l; stty size")
	a.waitListed(sid, running)
	n := len(a.lists)
	// The first resize keeps the size, so only the second is broadcast.
	for _, size := range [][2]int{{80, 24}, {100, 30}} {
		if err := a.c.Resize(sid, size[0], size[1]); err != nil {
			t.Fatal(err)
		}
	}
	a.waitFor("sessions list", func() bool { return len(a.lists) > n })
	if i := a.info(sid); i.Cols != 100 || i.Rows != 30 {
		t.Errorf("first list after the resizes has %dx%d, want 100x30", i.Cols, i.Rows)
	}
	if err := a.c.Input(sid, a.stream(sid).gen, []byte("\n")); err != nil {
		t.Fatal(err)
	}
	a.waitLive(sid, "30 100")
}

// All output must arrive before the exit, even when most of it is still in
// the ring when the shell exits. The creator is a bare connection that reads
// nothing until another client has seen the exit, so until then the daemon
// can send it only what the socket buffers take.
func TestExitAfterAllOutput(t *testing.T) {
	const n = 900000 // less than the ring holds
	srv := startSessionServer(t, Options{})
	observer := dialClient(t, srv)
	ws := mustDial(t, srv, "")
	handshake(t, ws)
	writeJSON(t, ws, protocol.Create{T: protocol.TCreate, Cmd: `head -c 900000 /dev/zero | tr '\0' x; exit 4`, Cols: 80, Rows: 24})
	var sid uint32
	observer.waitFor("the session listed as exited", func() bool {
		list := observer.lists[len(observer.lists)-1]
		if len(list) == 1 && exited(list[0]) {
			sid = list[0].SID
			return true
		}
		return false
	})
	e := srv.table.lookup(sid)
	e.sess.Lock()
	var unsent uint64
	if len(e.subs) == 1 {
		unsent = e.finalOff - e.subs[0].sentOff
	}
	e.sess.Unlock()
	if unsent == 0 {
		t.Fatal("all output had been sent by the exit, so the order was not tested")
	}
	t.Logf("%d bytes unsent at the exit", unsent)

	ctx := testCtx(t)
	var live []byte
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if typ == websocket.MessageBinary {
			f, err := protocol.Decode(data)
			if err != nil {
				t.Fatal(err)
			}
			// The only replay frame is the empty prefix, as nothing had
			// been written when the creator subscribed.
			if f.Type == protocol.FrameLive {
				live = append(live, f.Payload...)
				writeJSON(t, ws, protocol.Ack{T: protocol.TAck, SID: f.SID, Gen: f.Gen, Off: uint64(len(live))})
			}
			continue
		}
		m, err := protocol.ParseMessage(data)
		if err != nil {
			t.Fatal(err)
		}
		if ex, ok := m.(protocol.Exit); ok {
			if ex.Code != 4 {
				t.Errorf("exit code %d, want 4", ex.Code)
			}
			break
		}
	}
	if bytes.Count(live, []byte("x")) != n || !bytes.Contains(live, bytes.Repeat([]byte("x"), n)) {
		t.Errorf("before the exit, live output held %d x, want a run of %d", bytes.Count(live, []byte("x")), n)
	}
}

func TestSubscribeExitedSession(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create("printf done; exit 2")
	a.waitExit(sid)
	b := dialClient(t, srv)
	if err := b.c.Subscribe(sid); err != nil {
		t.Fatal(err)
	}
	if ex := b.waitExit(sid); ex.Code != 2 {
		t.Errorf("exit code %d, want 2", ex.Code)
	}
	sb := b.stream(sid)
	if want := []string{protocol.TReplay, protocol.TLive, protocol.TExit}; !slices.Equal(sb.msgs, want) {
		t.Errorf("subscriber got %v, want %v", sb.msgs, want)
	}
	if !bytes.Contains(sb.replayed, []byte("done")) || len(sb.live) != 0 {
		t.Errorf("subscriber was replayed %q and sent %q live, want the output replayed", sb.replayed, sb.live)
	}
}

func TestUnsubscribe(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create("read l; printf got:$l")
	if err := a.c.Unsubscribe(sid); err != nil {
		t.Fatal(err)
	}
	if err := a.c.Input(sid, 1, []byte("abc\n")); err != nil {
		t.Fatal(err)
	}
	a.waitFor("error", func() bool { return len(a.errs) > 0 })
	if e := a.errs[0]; e.Code != protocol.CodeNoSession || e.SID != sid {
		t.Errorf("input after unsubscribing: %+v, want %q", e, protocol.CodeNoSession)
	}
	if err := a.c.Subscribe(sid); err != nil {
		t.Fatal(err)
	}
	a.waitFor("second live", func() bool { return len(a.stream(sid).lives) == 2 })
	if r := a.stream(sid).replays; r[1].Gen != 1 {
		t.Errorf("replay after subscribing again = %+v, want generation 1", r[1])
	}
}

func TestKillRunningSession(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create("sleep 60")
	a.waitListed(sid, running)
	n := len(a.lists)
	if err := a.c.Kill(sid); err != nil {
		t.Fatal(err)
	}
	a.waitFor("exit and a sessions list", func() bool { return a.stream(sid).exit != nil && len(a.lists) > n })
	// The record goes before the exit is announced, so no list shows the
	// killed session as exited.
	if listed(a.lists[n], sid) {
		t.Errorf("first list after the kill still has session %d: %+v", sid, a.lists[n])
	}
	if r := savedRecord(t, srv, sid); r != nil {
		t.Errorf("state.json still holds %+v", r)
	}
}

func TestKillExitedSession(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create("exit 3")
	if ex := a.waitExit(sid); ex.Code != 3 {
		t.Errorf("exit code %d, want 3", ex.Code)
	}
	if i := a.waitListed(sid, exited); i.Code != 3 || len(i.Orphans) != 0 {
		t.Errorf("listed %+v, want exit code 3 and no orphans", i)
	}
	n := len(a.lists)
	if err := a.c.Kill(sid); err != nil {
		t.Fatal(err)
	}
	a.waitFor("sessions list", func() bool { return len(a.lists) > n })
	if listed(a.lists[n], sid) || len(a.errs) > 0 {
		t.Errorf("after the kill: list %+v, errors %+v", a.lists[n], a.errs)
	}
	if r := savedRecord(t, srv, sid); r != nil {
		t.Errorf("state.json still holds %+v", r)
	}
}

// A child that ignores HUP outlives the shell; the record stays, listing it,
// until a kill finds it gone.
func TestOrphanKeepsRecord(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create("trap '' HUP; sleep 60 & exit 0")
	if ex := a.waitExit(sid); ex.Code != 0 {
		t.Errorf("exit code %d, want 0", ex.Code)
	}
	i := a.waitListed(sid, func(i protocol.SessionInfo) bool { return exited(i) && len(i.Orphans) > 0 })
	if len(i.Orphans) != 1 {
		t.Fatalf("orphans %v, want just the sleep", i.Orphans)
	}
	orphan := i.Orphans[0]
	if r := savedRecord(t, srv, sid); r == nil || !slices.Equal(r.Orphans, i.Orphans) {
		t.Errorf("state.json holds %+v, want orphans %v", r, i.Orphans)
	}

	if err := a.c.Kill(sid); err != nil {
		t.Fatal(err)
	}
	a.waitFor("error", func() bool { return len(a.errs) > 0 })
	if e := a.errs[0]; e.Code != protocol.CodeOrphans || e.SID != sid || !slices.Equal(e.PIDs, []int{orphan}) {
		t.Errorf("kill answered %+v, want %q with [%d]", e, protocol.CodeOrphans, orphan)
	}
	if a.info(sid) == nil {
		t.Fatal("record removed although the orphan lives")
	}

	if sid, err := unix.Getsid(orphan); err != nil || sid != i.PID {
		t.Fatalf("getsid(%d) = %d, %v; want the orphan in session %d", orphan, sid, err, i.PID)
	}
	if err := unix.Kill(orphan, unix.SIGKILL); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(sessTimeout)
	for {
		if sid, err := unix.Getsid(orphan); err != nil || sid != i.PID {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("orphan %d still alive", orphan)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := a.c.Kill(sid); err != nil {
		t.Fatal(err)
	}
	a.waitFor("record removed", func() bool { return a.info(sid) == nil })
	if len(a.errs) != 1 {
		t.Errorf("errors %+v, want only the first kill's", a.errs)
	}
}

// A record from a previous daemon run has no PTY: it is listed as exited and
// restorable, cannot be subscribed to, keeps its sid out of use, stays after
// a kill and goes on a dismiss.
func TestPreviousRunRecord(t *testing.T) {
	gone := exec.Command("/usr/bin/true")
	if err := gone.Run(); err != nil {
		t.Fatal(err)
	}
	rec := state.SessionRecord{SID: 7, PID: gone.ProcessState.Pid(), Started: time.Now(), Cwd: "/tmp", Cmd: "old"}
	srv := startSessionServer(t, Options{State: state.State{Shell: "/bin/sh", Sessions: []state.SessionRecord{rec}}})
	a := dialClient(t, srv)
	if i := a.info(7); i == nil || i.State != protocol.StateExited || i.PID != rec.PID || i.Cmd != "old" || !i.Restorable {
		t.Errorf("hello list has %+v for the old record", i)
	}

	for _, sid := range []uint32{7, 99} {
		if err := a.c.Subscribe(sid); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.c.Kill(99); err != nil {
		t.Fatal(err)
	}
	a.waitFor("errors", func() bool { return len(a.errs) == 3 })
	for i, sid := range []uint32{7, 99, 99} {
		if e := a.errs[i]; e.Code != protocol.CodeNoSession || e.SID != sid {
			t.Errorf("error %d = %+v, want %q for %d", i, e, protocol.CodeNoSession, sid)
		}
	}

	if sid := a.create("exit 0"); sid != 8 {
		t.Errorf("new session got sid %d, want 8", sid)
	}
	n := len(a.lists)
	if err := a.c.Kill(7); err != nil {
		t.Fatal(err)
	}
	a.waitFor("list after the kill", func() bool { return len(a.lists) > n })
	if i := a.info(7); i == nil || !i.Restorable || len(i.Orphans) != 0 {
		t.Errorf("after the kill the record is %+v, want it restorable", i)
	}
	if r := savedRecord(t, srv, 7); r == nil {
		t.Error("kill removed the record from state.json")
	}
	if len(a.lists) != n+1 || len(a.errs) != 3 {
		t.Errorf("kill sent %d lists and %d errors in all, want 1 list and none", len(a.lists)-n, len(a.errs)-3)
	}

	if err := a.c.Dismiss(7); err != nil {
		t.Fatal(err)
	}
	a.waitFor("record dismissed", func() bool { return a.info(7) == nil })
	if r := savedRecord(t, srv, 7); r != nil {
		t.Errorf("state.json still holds %+v", r)
	}

	a.waitExit(8)
	for _, sid := range []uint32{99, 8} {
		if err := a.c.Dismiss(sid); err != nil {
			t.Fatal(err)
		}
	}
	a.waitFor("errors", func() bool { return len(a.errs) == 5 })
	if e := a.errs[3]; e.Code != protocol.CodeNoSession || e.SID != 99 {
		t.Errorf("dismiss of 99 answered %+v, want %q", e, protocol.CodeNoSession)
	}
	if e := a.errs[4]; e.Code != protocol.CodeBadRequest || e.SID != 8 {
		t.Errorf("dismiss of this run's session answered %+v, want %q for 8", e, protocol.CodeBadRequest)
	}
}

func TestBadSessionRequests(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	if err := a.c.Create("/nonexistent/vaquita-test", "", "", 80, 24); err != nil {
		t.Fatal(err)
	}
	a.waitFor("error", func() bool { return len(a.errs) == 1 })
	if e := a.errs[0]; e.Code != protocol.CodeBadRequest {
		t.Errorf("create with a missing cwd: %+v, want %q", e, protocol.CodeBadRequest)
	}
	srv.table.mu.Lock()
	n := len(srv.table.entries)
	srv.table.mu.Unlock()
	if n != 0 {
		t.Errorf("table holds %d entries after a failed create", n)
	}
	sid := a.create("sleep 60")
	if err := a.c.Subscribe(sid); err != nil {
		t.Fatal(err)
	}
	a.waitFor("error", func() bool { return len(a.errs) == 2 })
	if e := a.errs[1]; e.Code != protocol.CodeBadRequest || e.SID != sid {
		t.Errorf("second subscribe: %+v, want %q", e, protocol.CodeBadRequest)
	}
}
