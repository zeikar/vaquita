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

// roSeq is the ro of each live tc has had for sid, one per generation.
func (tc *tclient) roSeq(sid uint32) []bool {
	var seq []bool
	for _, l := range tc.stream(sid).lives {
		seq = append(seq, l.RO)
	}
	return seq
}

// waitROs waits until tc has had n lives for sid, then checks that no more
// follow.
func (tc *tclient) waitROs(sid uint32, n int) []bool {
	tc.t.Helper()
	tc.waitFor("live", func() bool { return len(tc.stream(sid).lives) >= n })
	tc.settle()
	return tc.roSeq(sid)
}

// While a GUI is subscribed, an attach client is read-only: its input and
// resizes are dropped, so that only the GUI answers the terminal queries in
// the output. It gets the session back when the GUI goes. Each change starts
// the attach over in a new generation.
func TestAttachReadOnlyWhileGUISubscribed(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialKind(t, srv, protocol.ClientAttach)
	sid := a.create("read l; printf got:$l; read l; printf got:$l; read l; printf got:$l")
	sa := a.stream(sid)
	a.waitFor("live", func() bool { return len(sa.lives) > 0 })
	if sa.lives[0].RO {
		t.Errorf("attach client alone got %+v, want writable", sa.lives[0])
	}

	g := dialClient(t, srv)
	if l := g.subscribe(sid); l.RO {
		t.Errorf("GUI got %+v, want writable", l)
	}
	a.waitFor("replay of generation 2", func() bool { return len(sa.lives) == 2 })
	if sa.replays[1].Gen != 2 || !sa.lives[1].RO {
		t.Errorf("attach client got %+v then %+v, want generation 2 and read-only", sa.replays[1], sa.lives[1])
	}

	// The attach client's requests are handled before the GUI sends its
	// line, so had its line been taken, it would be echoed and read first.
	// The first is of the generation before the change, the second of the
	// current one.
	if err := a.c.Input(sid, 1, []byte("old\n")); err != nil {
		t.Fatal(err)
	}
	if err := a.c.Input(sid, 2, []byte("attach\n")); err != nil {
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
	if out := g.stream(sid).live; bytes.Contains(out, []byte("old")) || bytes.Contains(out, []byte("attach")) {
		t.Errorf("read-only or stale input reached the shell: %q", out)
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
	a.waitFor("replay of generation 3", func() bool { return len(sa.lives) == 3 })
	if sa.replays[2].Gen != 3 || sa.lives[2].RO {
		t.Errorf("attach client got %+v then %+v, want generation 3 and writable", sa.replays[2], sa.lives[2])
	}
	if err := a.c.Input(sid, 2, []byte("older\n")); err != nil {
		t.Fatal(err)
	}
	if err := a.c.Input(sid, 3, []byte("attach\n")); err != nil {
		t.Fatal(err)
	}
	a.waitLive(sid, "got:attach")
	if bytes.Contains(sa.live, []byte("older")) {
		t.Errorf("input of an earlier generation reached the shell: %q", sa.live)
	}
}

// The writer is the earliest GUI subscriber, else the earliest subscriber,
// and it passes on as subscribers disconnect or unsubscribe. Only the
// subscribers whose flag changes start over.
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
	check := func(step, name string, got, want []bool) {
		t.Helper()
		if !slices.Equal(got, want) {
			t.Errorf("%s: %s has had ro %v, want %v", step, name, got, want)
		}
	}

	check("first GUI subscribed", "first attach", a1.waitROs(sid, 2), []bool{false, true})
	check("first GUI subscribed", "second attach", a2.waitROs(sid, 1), []bool{true})

	g1.c.Close()
	check("first GUI gone", "second GUI", g2.waitROs(sid, 2), []bool{true, false})
	check("first GUI gone", "first attach", a1.waitROs(sid, 2), []bool{false, true})
	check("first GUI gone", "second attach", a2.waitROs(sid, 1), []bool{true})

	if err := g2.c.Unsubscribe(sid); err != nil {
		t.Fatal(err)
	}
	check("second GUI unsubscribed", "first attach", a1.waitROs(sid, 3), []bool{false, true, false})
	check("second GUI unsubscribed", "second attach", a2.waitROs(sid, 1), []bool{true})

	a1.c.Close()
	check("first attach gone", "second attach", a2.waitROs(sid, 2), []bool{true, false})
}
