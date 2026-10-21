package server

import (
	"bytes"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
)

// ringHas reports whether sid's ring holds s.
func ringHas(srv *Server, sid uint32, s string) bool {
	sess := srv.table.lookup(sid).sess
	sess.Lock()
	defer sess.Unlock()
	r := sess.Output().Ring()
	return bytes.Contains(r.CopyRange(r.Start(), r.End(), nil), []byte(s))
}

func (tc *tclient) waitSeen(sid uint32, want string) {
	tc.t.Helper()
	tc.waitFor("output "+want, func() bool {
		st := tc.stream(sid)
		return bytes.Contains(st.replayed, []byte(want)) || bytes.Contains(st.live, []byte(want))
	})
}

// stalledAttach starts a session whose output outruns an attach client that
// does not ack, and returns once the attach has stopped at the cap and the
// program has written everything.
func stalledAttach(t *testing.T, srv *Server, tail string) (*tclient, uint32) {
	t.Helper()
	a := dialKind(t, srv, protocol.ClientAttach)
	a.noAck = true
	// More than maxUnacked, so the attach stalls part-way through it.
	sid := a.create("yes | head -c 800000; printf Z; " + tail)
	a.waitFor("the cap reached", func() bool { return a.stream(sid).received() >= maxUnacked })
	// The ring no longer moves.
	for !ringHas(srv, sid, "Z") {
		a.handleFor(10 * time.Millisecond)
	}
	return a, sid
}

// subCount is the number of subscriptions to sid.
func subCount(srv *Server, sid uint32) int {
	e := srv.table.lookup(sid)
	e.sess.Lock()
	defer e.sess.Unlock()
	return len(e.subs)
}

// A writer that does not ack is paused when the GUI comes and goes, and
// restarted once, in one new generation, when it has acked: the output it
// had not been sent becomes replay, which nobody answers, so no frame of the
// interval the GUI owned reaches it as live, and its input of the earlier
// generation is dropped.
func TestHandoffWhileAttachStalled(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a, sid := stalledAttach(t, srv, "read l; printf got:$l")
	sa := a.stream(sid)
	liveBefore := len(sa.live)

	g := dialClient(t, srv)
	g.subscribe(sid)
	g.waitSeen(sid, "Z")
	guiFrom := g.stream(sid).replays[0].To
	g.c.Close()
	for subCount(srv, sid) != 1 {
		a.handleFor(10 * time.Millisecond)
	}

	a.handleFor(quietWindow)
	if len(sa.replays) != 1 || len(sa.live) != liveBefore {
		t.Fatalf("%d replays and %d new live bytes while paused, want none", len(sa.replays)-1, len(sa.live)-liveBefore)
	}
	if err := a.c.Input(sid, 1, []byte("stale\n")); err != nil {
		t.Fatal(err)
	}
	if err := a.c.Ack(sid, 1, sa.off); err != nil {
		t.Fatal(err)
	}
	a.waitFor("generation 2", func() bool { return len(sa.lives) == 2 })
	if r, l := sa.replays[1], sa.lives[1]; r.Gen != 2 || r.To < guiFrom || l.RO {
		t.Errorf("got %+v then %+v, want generation 2 covering the GUI's interval from %d, writable", r, l, guiFrom)
	}
	a.handleFor(quietWindow)
	if len(sa.replays) != 2 {
		t.Errorf("%d replays, want exactly one more", len(sa.replays)-1)
	}
	if err := a.c.Ack(sid, 2, sa.off); err != nil {
		t.Fatal(err)
	}
	if err := a.c.Input(sid, 2, []byte("ok\n")); err != nil {
		t.Fatal(err)
	}
	a.waitLive(sid, "got:ok")
	if ringHas(srv, sid, "stale") {
		t.Error("input of the earlier generation reached the shell")
	}
}

// Writer changes cannot get a subscriber that does not ack more than the cap:
// it is not restarted until it has acked what it was sent.
func TestHandoffCyclesRespectTheCap(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a, sid := stalledAttach(t, srv, "sleep 60")
	sa := a.stream(sid)
	before := sa.received()
	if before > maxUnacked {
		t.Fatalf("received %d bytes, over the cap", before)
	}

	g := dialClient(t, srv)
	for range 5 {
		g.subscribe(sid)
		if err := g.c.Unsubscribe(sid); err != nil {
			t.Fatal(err)
		}
		g.sync()
	}
	a.handleFor(quietWindow)
	if got := sa.received(); got != before || len(sa.replays) != 1 {
		t.Errorf("received %d bytes in %d replays after the cycles, want %d in 1", got, len(sa.replays), before)
	}
}

// Input of another generation than the subscription's is dropped, so that
// replies to output since replayed cannot reach the session.
func TestStaleGenerationInputDropped(t *testing.T) {
	srv := startSessionServer(t, Options{})
	g := dialClient(t, srv)
	sid := g.create("read l; printf got:$l; read l; printf got:$l")
	st := g.stream(sid)
	g.waitFor("live", func() bool { return len(st.lives) > 0 })
	for _, gen := range []uint32{st.gen + 1, st.gen - 1} {
		if err := g.c.Input(sid, gen, []byte("stale\n")); err != nil {
			t.Fatal(err)
		}
	}
	if err := g.c.Input(sid, st.gen, []byte("ok\n")); err != nil {
		t.Fatal(err)
	}
	g.waitLive(sid, "got:ok")
	if bytes.Contains(st.live, []byte("stale")) {
		t.Errorf("stale input reached the shell: %q", st.live)
	}
}
