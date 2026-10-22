package server

import (
	"encoding/base64"
	"errors"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/session"
	"github.com/zeikar/vaquita/daemon/internal/status"
)

// report is a shell command that writes a root OSC 7501 report of state,
// with kind and a base64 msg when they are not empty.
func report(state, kind, msg string) string {
	p := "state=" + state
	if kind != "" {
		p += ":kind=" + kind
	}
	if msg != "" {
		p += ":msg=" + base64.StdEncoding.EncodeToString([]byte(msg))
	}
	return `printf '\033]7501;` + p + `\033\\'`
}

// burst is a shell loop that writes, for each i from from to to, a working
// report with msg i and then an idle report. Each printf is a write of its
// own, so the reports reach the daemon over many reads.
func burst(from, to int) string {
	var b strings.Builder
	b.WriteString("for m in")
	for i := from; i <= to; i++ {
		b.WriteString(" " + base64.StdEncoding.EncodeToString([]byte(strconv.Itoa(i))))
	}
	b.WriteString(`; do printf '\033]7501;state=working:msg=%s\033\\\033]7501;state=idle\033\\' "$m"; done`)
	return b.String()
}

// showing matches a status event whose row shows state.
func showing(state string) func(protocol.Status) bool {
	return func(s protocol.Status) bool { return s.Status != nil && s.Status.State == state }
}

// notifyOf matches a notify of kind about sid.
func notifyOf(sid uint32, kind string) func(protocol.Notify) bool {
	return func(n protocol.Notify) bool { return n.SID == sid && n.Kind == kind }
}

// The server hands the projector's view states and notification kinds on
// unchanged.
func TestStatusNamesMatchProtocol(t *testing.T) {
	for _, p := range [][2]string{
		{status.ViewWorking, protocol.ViewWorking},
		{status.ViewInput, protocol.ViewInput},
		{status.ViewAuth, protocol.ViewAuth},
		{status.ViewDone, protocol.ViewDone},
		{status.ViewError, protocol.ViewError},
		{status.NotifyDone, protocol.NotifyDone},
		{status.NotifyError, protocol.NotifyError},
		{status.NotifyInput, protocol.NotifyInput},
		{status.NotifyAuth, protocol.NotifyAuth},
	} {
		if p[0] != p[1] {
			t.Errorf("status package has %q where the protocol has %q", p[0], p[1])
		}
	}
}

// A report changes the row for every GUI at once, and a GUI that connects
// later finds it in its first list. A blocked report raises an input
// notification after the status that shows it.
func TestStatusAndNotify(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create(report("working", "", "") + "; read l; " + report("blocked", "permission", "Allow rm?") + "; read l")
	working := protocol.StatusInfo{State: protocol.ViewWorking}
	if s := a.waitStatus(sid, showing(protocol.ViewWorking)); *s.Status != working || s.Unread {
		t.Errorf("status %+v showing %+v, want working and read", s, *s.Status)
	}
	b := dialClient(t, srv)
	if i := b.info(sid); i == nil || i.Status == nil || *i.Status != working || i.Unread {
		t.Errorf("second GUI's first list has %+v, want the session working", i)
	}

	if err := a.c.Input(sid, a.stream(sid).gen, []byte("\n")); err != nil {
		t.Fatal(err)
	}
	want := protocol.StatusInfo{State: protocol.ViewInput, Kind: "permission", Msg: "Allow rm?"}
	for _, c := range []*tclient{a, b} {
		if n := c.waitNotify(notifyOf(sid, protocol.NotifyInput)); n.Msg != "Allow rm?" {
			t.Errorf("notify %+v, want msg %q", n, "Allow rm?")
		}
		// The notify has just arrived, so the latest status came before it.
		if s := c.lastStatus(sid); s == nil || s.Status == nil || *s.Status != want || s.Unread {
			t.Errorf("status before the input notify: %+v, want %+v", s, want)
		}
	}
}

// An error is notified at once and leaves the row unread until a GUI has
// seen it, which every GUI is told.
func TestSeen(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	b := dialClient(t, srv)
	sid := a.create(report("error", "", "boom") + "; read l")
	want := protocol.StatusInfo{State: protocol.ViewError, Msg: "boom"}
	for _, c := range []*tclient{a, b} {
		if n := c.waitNotify(notifyOf(sid, protocol.NotifyError)); n.Msg != "boom" {
			t.Errorf("notify %+v, want msg %q", n, "boom")
		}
		if s := c.lastStatus(sid); s == nil || s.Status == nil || *s.Status != want || !s.Unread {
			t.Errorf("status before the error notify: %+v, want %+v unread", s, want)
		}
	}

	if err := b.c.Seen(sid); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*tclient{a, b} {
		if s := c.waitStatus(sid, func(s protocol.Status) bool { return !s.Unread }); s.Status == nil || *s.Status != want {
			t.Errorf("status after seen %+v, want %+v read", s, want)
		}
	}

	if err := b.c.Seen(999); err != nil {
		t.Fatal(err)
	}
	b.waitFor("error", func() bool { return len(b.errs) > 0 })
	if e := b.errs[0]; e.Code != protocol.CodeNoSession || e.SID != 999 {
		t.Errorf("seen of an unknown session answered %+v, want %q", e, protocol.CodeNoSession)
	}
}

// A done after a working is notified only once it has stood for
// status.DoneQuiet, by the session's status timer.
func TestDoneNotifiedAfterQuiet(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create(report("working", "", "") + "; read l; " + report("done", "", "All set") + "; read l")
	a.waitStatus(sid, showing(protocol.ViewWorking))
	// The done is written only once the shell has read this input, so it is
	// stamped after start.
	start := time.Now()
	if err := a.c.Input(sid, a.stream(sid).gen, []byte("\n")); err != nil {
		t.Fatal(err)
	}
	n := a.waitNotify(notifyOf(sid, protocol.NotifyDone))
	// A done without a msg would wait for status.DoneMsgWait.
	if d := time.Since(start); d < status.DoneQuiet || d >= status.DoneMsgWait {
		t.Errorf("done notified %v after it was written, want %v", d, status.DoneQuiet)
	}
	if n.Msg != "All set" {
		t.Errorf("notify %+v, want msg %q", n, "All set")
	}
}

// Notifications that fall while no GUI is connected are summed up for the
// first GUI to join, right after its list. Attach clients get neither
// statuses nor notifications.
func TestMissedSummary(t *testing.T) {
	srv := startSessionServer(t, Options{})
	at := dialKind(t, srv, protocol.ClientAttach)
	sid := at.create(report("error", "", "one") + "; read l; " + report("error", "", "two") + "; read l")
	missed := func() int {
		srv.table.mu.Lock()
		defer srv.table.mu.Unlock()
		return srv.table.missed
	}
	deadline := time.Now().Add(sessTimeout)
	for missed() != 1 {
		if time.Now().After(deadline) {
			t.Fatalf("missed count %d, want 1", missed())
		}
		time.Sleep(5 * time.Millisecond)
	}

	g := dialClient(t, srv)
	if !g.handleNext("the missed summary", time.After(sessTimeout)) {
		t.Fatal("nothing after the first GUI's list")
	}
	if want := (protocol.Notify{T: protocol.TNotify, Kind: protocol.NotifyMissed, Count: 1}); len(g.notifies) != 1 || g.notifies[0] != want {
		t.Fatalf("first event after the first GUI's list left notifies %+v, want %+v", g.notifies, want)
	}

	// With a GUI connected, the next notification goes to it and is not
	// counted.
	if err := at.c.Input(sid, at.stream(sid).gen, []byte("\n")); err != nil {
		t.Fatal(err)
	}
	if n := g.waitNotify(notifyOf(sid, protocol.NotifyError)); n.Msg != "two" {
		t.Errorf("notify %+v, want msg %q", n, "two")
	}
	g2 := dialClient(t, srv)
	g2.sync()
	at.sync()
	if len(g2.notifies) != 0 {
		t.Errorf("second GUI got %+v, want no notifications", g2.notifies)
	}
	if len(at.statuses) != 0 || len(at.notifies) != 0 {
		t.Errorf("attach client got statuses %+v and notifications %+v", at.statuses, at.notifies)
	}
}

// A list taken after a status shows it, and no status event that follows
// the list contradicts it.
func TestListCarriesStatus(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create(report("error", "", "boom") + "; read l")
	a.waitStatus(sid, showing(protocol.ViewError))
	n, ns := len(a.lists), len(a.statuses)
	if err := a.c.Resize(sid, 100, 30); err != nil {
		t.Fatal(err)
	}
	a.waitFor("sessions list", func() bool { return len(a.lists) > n })
	want := protocol.StatusInfo{State: protocol.ViewError, Msg: "boom"}
	if i := a.info(sid); i.Status == nil || *i.Status != want || !i.Unread {
		t.Errorf("list after the resize has %+v, want %+v unread", i, want)
	}
	a.handleFor(quietWindow)
	for _, s := range a.statuses[ns:] {
		if s.Status == nil || *s.Status != want || !s.Unread {
			t.Errorf("status %+v after the list", s)
		}
	}
}

// A session that reports an error and exits at once: its notification comes
// before its exit, its exited row shows no status, and seeing it afterwards
// sends nothing.
func TestStatusBeforeExit(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create(report("error", "", "boom") + "; exit 1")
	a.waitExit(sid)
	if !slices.ContainsFunc(a.notifies, notifyOf(sid, protocol.NotifyError)) {
		t.Errorf("exit arrived before the error notification; notifications %+v", a.notifies)
	}
	if i := a.waitListed(sid, exited); i.Status != nil || i.Unread {
		t.Errorf("exited session listed with status %+v, unread %v", i.Status, i.Unread)
	}
	ns := len(a.statuses)
	if err := a.c.Seen(sid); err != nil {
		t.Fatal(err)
	}
	a.sync()
	if len(a.statuses) != ns || len(a.errs) != 0 {
		t.Errorf("seen after the exit: statuses %+v, errors %+v", a.statuses[ns:], a.errs)
	}
}

// Reports read in a burst are drained by one timer callback at a time, never
// one per read, and their statuses arrive in order.
func TestStatusBurst(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	before := runtime.NumGoroutine()
	sid := a.create(burst(1, 200) + "; printf A-END; read l; " + burst(201, 400) + "; printf B-END; read l; exit 0")
	a.waitLive(sid, "A-END")
	e := srv.table.lookup(sid)

	// While the test holds the table lock no drain can run: the first read
	// with a report asks for one, whose callback waits for the lock, and
	// every later read is coalesced into it. Deferred, so a failure releases
	// the lock before the cleanup takes it.
	func() {
		base := runtime.NumGoroutine()
		srv.table.mu.Lock()
		defer srv.table.mu.Unlock()
		if err := a.c.Input(sid, a.stream(sid).gen, []byte("\n")); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(sessTimeout)
		for !ringHas(e, "B-END") {
			if time.Now().After(deadline) {
				t.Fatal("second burst not read")
			}
			time.Sleep(time.Millisecond)
		}
		// One drain may wait for the lock; one more goroutine is slack for
		// anything the runtime starts meanwhile.
		if n := runtime.NumGoroutine(); n > base+2 {
			t.Errorf("%d goroutines while drains were held up, %d before the burst", n, base)
		}
	}()

	a.waitLive(sid, "B-END")
	if err := a.c.Input(sid, a.stream(sid).gen, []byte("\n")); err != nil {
		t.Fatal(err)
	}
	a.waitExit(sid)
	last := 0
	for _, s := range a.statuses {
		if s.SID != sid || s.Status == nil {
			continue
		}
		i, err := strconv.Atoi(s.Status.Msg)
		if s.Status.State != protocol.ViewWorking || err != nil || i <= last {
			t.Errorf("status %+v after working %d", *s.Status, last)
			continue
		}
		last = i
	}
	if s := a.lastStatus(sid); s == nil || s.Status != nil {
		t.Errorf("last status %+v, want the final idle's empty row", s)
	}

	// The session's goroutines and every drain have ended with it. The
	// master is closed only after OnExit has returned.
	deadline := time.Now().Add(sessTimeout)
	for !errors.Is(e.sess.Resize(80, 24), session.ErrClosed) {
		if time.Now().After(deadline) {
			t.Fatal("session never finished exiting")
		}
		time.Sleep(5 * time.Millisecond)
	}
	for runtime.NumGoroutine() > before {
		if time.Now().After(deadline) {
			t.Errorf("%d goroutines after the session ended, %d before it started", runtime.NumGoroutine(), before)
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Reports read before the session is listed, which OnOutput skips, go out
// once it is listed, after the list that shows it.
func TestStatusReadBeforeListed(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	tb := srv.table
	tb.mu.Lock()
	last := tb.lastSID
	tb.mu.Unlock()
	if err := a.c.Create("", report("working", "", "")+"; "+report("blocked", "question", "Which one?")+"; read l", "test", 80, 24); err != nil {
		t.Fatal(err)
	}

	// Holding the table lock from the moment the create has its sid stops
	// the create before it lists the session; the lock is held until the
	// shell's reports have been read.
	var sid uint32
	func() {
		deadline := time.Now().Add(sessTimeout)
		for {
			tb.mu.Lock()
			if tb.lastSID > last {
				break
			}
			tb.mu.Unlock()
			if time.Now().After(deadline) {
				t.Fatal("create took no sid")
			}
			time.Sleep(time.Millisecond)
		}
		defer tb.mu.Unlock()
		sid = tb.lastSID
		// The create may have listed the session before the lock was
		// caught; then this test would pass without testing anything.
		if tb.entries[sid] != nil {
			t.Skip("the create listed the session before the table lock was caught")
		}
		// The create subscribes its connection once the session has
		// started.
		var e *entry
		for e == nil {
			srv.mu.Lock()
			for c := range srv.conns {
				if sub := c.subscription(sid); sub != nil {
					e = sub.e
				}
			}
			srv.mu.Unlock()
			if time.Now().After(deadline) {
				t.Fatal("session never started")
			}
			time.Sleep(time.Millisecond)
		}
		for {
			e.sess.Lock()
			v, _ := e.sess.Output().View()
			e.sess.Unlock()
			if v.State == status.ViewInput {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("reports never read")
			}
			time.Sleep(time.Millisecond)
		}
	}()

	a.waitFor("status", func() bool { return a.lastStatus(sid) != nil })
	if !slices.ContainsFunc(a.lists, func(l []protocol.SessionInfo) bool { return listed(l, sid) }) {
		t.Error("status arrived before any list showed the session")
	}
	want := protocol.StatusInfo{State: protocol.ViewInput, Kind: "question", Msg: "Which one?"}
	if s := a.lastStatus(sid); s.Status == nil || *s.Status != want {
		t.Errorf("first status %+v, want %+v", s, want)
	}
	if n := a.waitNotify(notifyOf(sid, protocol.NotifyInput)); n.Msg != "Which one?" {
		t.Errorf("notify %+v, want msg %q", n, "Which one?")
	}
}
