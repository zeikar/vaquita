package server

import (
	"bytes"
	"slices"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/session"
)

// soleSub returns the one subscription to sid.
func soleSub(t *testing.T, srv *Server, sid uint32) *subscriber {
	t.Helper()
	e := srv.table.lookup(sid)
	e.sess.Lock()
	defer e.sess.Unlock()
	if len(e.subs) != 1 {
		t.Fatalf("session %d has %d subscriptions, want 1", sid, len(e.subs))
	}
	return e.subs[0]
}

// subState is the test hook into a subscription's bookkeeping, which the
// session lock guards.
func subState(sub *subscriber) (gen uint32, sentOff, ackedOff uint64) {
	s := sub.e.sess
	s.Lock()
	defer s.Unlock()
	return sub.gen, sub.sentOff, sub.ackedOff
}

// quietWindow is how long a test waits to see that nothing more is sent.
const quietWindow = 300 * time.Millisecond

// A client that stops acking is sent exactly maxUnacked bytes, and nothing
// more while anything it was sent is unacknowledged, but the PTY reader goes
// on: the session runs to its exit. Once it has acked everything, output it
// missed has left the ring, so it starts over with a replay in a new
// generation.
func TestBackpressureStall(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	a.noAck = true
	// 3MB, which the PTY turns into 4.5MB: more than maxUnacked plus the
	// ring, so the ring laps the stalled subscription. It does so only after
	// the cap has been reached unless the pump sends at less than half the
	// rate the program writes.
	sid := a.create("yes | head -c 3000000; exit 0")
	st := a.stream(sid)

	a.waitFor("the cap reached", func() bool { return st.received() >= maxUnacked })
	a.waitListed(sid, exited)
	a.handleFor(quietWindow)
	got, live, replayed := st.received(), len(st.live), len(st.replayed)
	if got != maxUnacked {
		t.Errorf("received %d bytes without acking, want %d", got, maxUnacked)
	}
	if want := []string{protocol.TReplay, protocol.TLive}; !slices.Equal(st.msgs, want) {
		t.Errorf("got %v, want only the creator's %v", st.msgs, want)
	}
	if r := st.replays[0]; r.From != 0 || r.To != 0 {
		t.Errorf("creator's replay = %+v, want an empty one", r)
	}

	if err := a.c.Ack(sid, 1, st.off/2); err != nil {
		t.Fatal(err)
	}
	a.handleFor(quietWindow)
	if st.received() != got || len(st.msgs) != 2 || len(a.errs) != 0 {
		t.Errorf("after a partial ack: %d bytes, messages %v, errors %+v; want nothing new", st.received(), st.msgs, a.errs)
	}

	if err := a.c.Ack(sid, 1, st.off); err != nil {
		t.Fatal(err)
	}
	if ex := a.waitExit(sid); ex.Code != 0 {
		t.Errorf("exit code %d, want 0", ex.Code)
	}
	if want := []string{protocol.TReplay, protocol.TLive, protocol.TReplay, protocol.TLive, protocol.TExit}; !slices.Equal(st.msgs, want) {
		t.Fatalf("after acking everything: %v, want %v", st.msgs, want)
	}
	r, l := st.replays[1], st.lives[1]
	n := len(st.replayed) - replayed
	if r.Gen != 2 || r.From == 0 || r.To-r.From > session.DefaultRingCap || uint64(n) != r.To-r.From {
		t.Errorf("replay = %+v with %d bytes, want generation 2 of at most the ring from past 0", r, n)
	}
	if l.Gen != 2 || l.RO {
		t.Errorf("live = %+v, want generation 2, writable", l)
	}
	if len(st.live) != live {
		t.Errorf("%d bytes live after the replay, want none", len(st.live)-live)
	}
	// The exit has ended the subscription, so an ack of generation 1 now
	// would be ignored whatever its generation; TestStaleGenerationAck
	// sends one to a subscription in generation 2.
}

// Acks of an earlier generation are ignored even when their offset lies in
// the current one, so the client cannot acknowledge output it was never
// sent in this generation.
func TestStaleGenerationAck(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	a.noAck = true
	// The shell stays, so the subscription lives on in generation 2. Z marks
	// the end of the output.
	sid := a.create("yes | head -c 3000000; printf Z; read l")
	sub := soleSub(t, srv, sid)
	st := a.stream(sid)

	// An observer that acks tells when the output is all in the ring: by
	// then the ring has lapped the stalled subscription, whose pump has
	// stopped.
	b := dialClient(t, srv)
	b.subscribe(sid)
	b.waitFor("the end of the output", func() bool {
		bs := b.stream(sid)
		return bytes.Contains(bs.replayed, []byte("Z")) || bytes.Contains(bs.live, []byte("Z"))
	})
	a.waitFor("everything sent", func() bool {
		_, sent, _ := subState(sub)
		return st.off == sent
	})
	if err := a.c.Ack(sid, 1, st.off); err != nil {
		t.Fatal(err)
	}
	a.waitFor("live of generation 2", func() bool { return len(st.lives) == 2 })
	r := st.replays[1]
	if r.Gen != 2 {
		t.Fatalf("replay = %+v, want generation 2", r)
	}

	if err := a.c.Ack(sid, 1, r.To); err != nil {
		t.Fatal(err)
	}
	a.sync()
	if gen, sent, acked := subState(sub); gen != 2 || sent != r.To || acked != r.From {
		t.Errorf("after an ack of generation 1: generation %d, sent %d, acked %d; want 2, %d, %d", gen, sent, acked, r.To, r.From)
	}
	if err := a.c.Ack(sid, 2, r.To); err != nil {
		t.Fatal(err)
	}
	a.sync()
	if _, _, acked := subState(sub); acked != r.To {
		t.Errorf("after an ack of generation 2: acked %d, want %d", acked, r.To)
	}
}
