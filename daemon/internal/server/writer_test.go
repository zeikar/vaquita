package server

import (
	"bytes"
	"slices"
	"testing"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
)

// sessSize returns sid's terminal size as the session has it.
func sessSize(srv *Server, sid uint32) (cols, rows int) {
	s := srv.table.lookup(sid).sess
	s.Lock()
	defer s.Unlock()
	return s.Size()
}

// While a GUI is subscribed, an attach client is read-only: its input and
// resizes are dropped, so that only the GUI answers the terminal queries in
// the output. It gets the session back when the GUI goes.
func TestAttachReadOnlyWhileGUISubscribed(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialKind(t, srv, protocol.ClientAttach)
	sid := a.create("read l; printf got:$l; read l; printf got:$l")
	sa := a.stream(sid)
	a.waitFor("live", func() bool { return len(sa.lives) > 0 })
	if sa.lives[0].RO {
		t.Errorf("attach client alone got %+v, want writable", sa.lives[0])
	}

	g := dialClient(t, srv)
	if l := g.subscribe(sid); l.RO {
		t.Errorf("GUI got %+v, want writable", l)
	}
	a.waitFor("ro event", func() bool { return len(sa.ros) == 1 })
	if !sa.ros[0] {
		t.Errorf("attach client's ro events %v, want [true]", sa.ros)
	}

	// The attach client's requests are handled before the GUI sends its
	// line, so had its line been taken, it would be echoed and read first.
	if err := a.c.Input(sid, sa.gen, []byte("attach\n")); err != nil {
		t.Fatal(err)
	}
	if err := a.c.Resize(sid, 100, 30); err != nil {
		t.Fatal(err)
	}
	a.sync()
	if err := g.c.Input(sid, g.stream(sid).gen, []byte("gui\n")); err != nil {
		t.Fatal(err)
	}
	g.waitLive(sid, "got:gui")
	if out := g.stream(sid).live; bytes.Contains(out, []byte("attach")) {
		t.Errorf("read-only input reached the shell: %q", out)
	}
	if cols, rows := sessSize(srv, sid); cols != 80 || rows != 24 {
		t.Errorf("session is %dx%d after a read-only resize, want 80x24", cols, rows)
	}
	if len(a.errs) != 0 {
		t.Errorf("read-only requests answered with %+v, want them dropped silently", a.errs)
	}

	if err := g.c.Unsubscribe(sid); err != nil {
		t.Fatal(err)
	}
	a.waitFor("second ro event", func() bool { return len(sa.ros) == 2 })
	if !slices.Equal(sa.ros, []bool{true, false}) {
		t.Errorf("attach client's ro events %v, want [true false]", sa.ros)
	}
	if err := a.c.Input(sid, sa.gen, []byte("attach\n")); err != nil {
		t.Fatal(err)
	}
	a.waitLive(sid, "got:attach")
}

// The writer is the earliest GUI subscriber, else the earliest subscriber,
// and it passes on as subscribers disconnect or unsubscribe. Only the
// subscribers whose flag changes are told.
func TestWriterIsEarliestSubscriber(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a1 := dialKind(t, srv, protocol.ClientAttach)
	sid := a1.create("sleep 60")
	a1.waitFor("live", func() bool { return len(a1.stream(sid).lives) > 0 })
	a2 := dialKind(t, srv, protocol.ClientAttach)
	g1 := dialClient(t, srv)
	g2 := dialClient(t, srv)
	for _, c := range []struct {
		name string
		tc   *tclient
		ro   bool
	}{{"second attach", a2, true}, {"first GUI", g1, false}, {"second GUI", g2, true}} {
		if l := c.tc.subscribe(sid); l.RO != c.ro {
			t.Errorf("%s got %+v, want ro %v", c.name, l, c.ro)
		}
	}
	// ros returns the ro events tc has had, including any sent in error by
	// a change already made.
	ros := func(tc *tclient) []bool {
		tc.settle()
		return tc.stream(sid).ros
	}
	waitRO := func(tc *tclient, n int) []bool {
		tc.waitFor("ro event", func() bool { return len(tc.stream(sid).ros) >= n })
		return ros(tc)
	}
	check := func(step, name string, got, want []bool) {
		t.Helper()
		if !slices.Equal(got, want) {
			t.Errorf("%s: %s has had ro events %v, want %v", step, name, got, want)
		}
	}

	check("first GUI subscribed", "first attach", waitRO(a1, 1), []bool{true})
	check("first GUI subscribed", "second attach", ros(a2), nil)

	g1.c.Close()
	check("first GUI gone", "second GUI", waitRO(g2, 1), []bool{false})
	check("first GUI gone", "first attach", ros(a1), []bool{true})
	check("first GUI gone", "second attach", ros(a2), nil)

	if err := g2.c.Unsubscribe(sid); err != nil {
		t.Fatal(err)
	}
	check("second GUI unsubscribed", "first attach", waitRO(a1, 2), []bool{true, false})
	check("second GUI unsubscribed", "second attach", ros(a2), nil)
	check("second GUI unsubscribed", "second GUI", ros(g2), []bool{false})

	a1.c.Close()
	check("first attach gone", "second attach", waitRO(a2, 1), []bool{false})
}

// At the exit each subscription ends as its own exit goes out. When the
// GUI's goes first, the attach client becomes the writer just as its own
// exit is due; it may be told so before its exit, but never after it, where
// the ro would read as news about its next subscription to the session.
//
// The pump makes this hold by construction; the test is a regression guard
// for it, and a probabilistic one: which exit goes first varies from run to
// run, and an ro sent out of turn shows only in some of them.
func TestNoROAfterExit(t *testing.T) {
	srv := startSessionServer(t, Options{})
	g := dialClient(t, srv)
	sid := g.create("read l; exit 0")
	a := dialKind(t, srv, protocol.ClientAttach)
	if l := a.subscribe(sid); !l.RO {
		t.Errorf("attach client got %+v beside the GUI, want read-only", l)
	}
	if err := g.c.Input(sid, g.stream(sid).gen, []byte("\n")); err != nil {
		t.Fatal(err)
	}
	a.waitExit(sid)
	// apply reports an ro after the exit.
	a.settle()
}
