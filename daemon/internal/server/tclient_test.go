package server

import (
	"bytes"
	"maps"
	"math"
	"slices"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/client"
	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

// tclient is a test client that follows each session's stream the way a
// terminal client does: it checks generations and offsets and acks every
// output frame as if it had just written it.
type tclient struct {
	t        *testing.T
	c        *client.Client
	lists    [][]protocol.SessionInfo // every sessions message, the hello's first
	errs     []protocol.Error
	statuses []protocol.Status
	notifies []protocol.Notify
	repos    [][]string // every repos message
	streams  map[uint32]*stream
	// noAck makes it a terminal that has stopped consuming output: it acks
	// only when the test does.
	noAck bool
}

// stream is what a tclient has received of one session.
type stream struct {
	gen       uint32
	off       uint64 // ring offset of the next output byte
	replaying bool   // between a replay and its live
	prefixDue bool   // the next replay frame is the mode prefix
	msgs      []string
	replays   []protocol.Replay
	prefixes  [][]byte
	replayed  []byte // ring bytes from replay frames
	lives     []protocol.Live
	live      []byte // bytes from live frames
	exit      *protocol.Exit
	ended     bool // the exit has ended the subscription
}

// received counts the payload bytes of every output frame, mode prefixes
// included.
func (st *stream) received() int {
	n := len(st.replayed) + len(st.live)
	for _, p := range st.prefixes {
		n += len(p)
	}
	return n
}

func dialClient(t *testing.T, srv *Server) *tclient {
	t.Helper()
	return dialKind(t, srv, protocol.ClientGUI)
}

// dialKind connects a tclient that says in its hello it is a client of kind.
func dialKind(t *testing.T, srv *Server, kind string) *tclient {
	t.Helper()
	c, list, err := client.Dial(testCtx(t), state.Endpoint{URL: srv.URL(), Token: testToken}, kind)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return &tclient{t: t, c: c, lists: [][]protocol.SessionInfo{list}, streams: make(map[uint32]*stream)}
}

func (tc *tclient) stream(sid uint32) *stream {
	st := tc.streams[sid]
	if st == nil {
		st = new(stream)
		tc.streams[sid] = st
	}
	return st
}

// info returns sid's entry in the latest sessions list, or nil.
func (tc *tclient) info(sid uint32) *protocol.SessionInfo {
	list := tc.lists[len(tc.lists)-1]
	for i := range list {
		if list[i].SID == sid {
			return &list[i]
		}
	}
	return nil
}

// waitFor handles events until cond holds.
func (tc *tclient) waitFor(what string, cond func() bool) {
	tc.t.Helper()
	deadline := time.After(sessTimeout)
	for !cond() {
		if !tc.handleNext(what, deadline) {
			tc.t.Fatalf("no %s within %v", what, sessTimeout)
		}
	}
}

// handleFor handles whatever arrives within d, for tests that show nothing
// more is sent.
func (tc *tclient) handleFor(d time.Duration) {
	tc.t.Helper()
	deadline := time.After(d)
	for tc.handleNext("the end of the wait", deadline) {
	}
}

// handleNext handles one event, or reports false once deadline has passed.
func (tc *tclient) handleNext(what string, deadline <-chan time.Time) bool {
	tc.t.Helper()
	select {
	case ev, ok := <-tc.c.Events():
		if !ok {
			tc.t.Fatalf("connection closed while waiting for %s", what)
		}
		if ev.Err != nil {
			tc.t.Fatalf("connection failed while waiting for %s: %v", what, ev.Err)
		}
		tc.apply(ev)
		return true
	case <-deadline:
		return false
	}
}

// sync returns once the daemon has handled everything tc sent before it:
// a connection's requests are handled in order, and an unsubscribe from a
// session that does not exist is answered. Only that answer is taken out of
// errs.
func (tc *tclient) sync() {
	tc.t.Helper()
	isSync := func(e protocol.Error) bool { return e.Code == protocol.CodeNoSession && e.SID == math.MaxUint32 }
	if err := tc.c.Unsubscribe(math.MaxUint32); err != nil {
		tc.t.Fatal(err)
	}
	tc.waitFor("answer to the sync", func() bool { return slices.ContainsFunc(tc.errs, isSync) })
	tc.errs = slices.DeleteFunc(tc.errs, isSync)
}

// settle returns once tc, subscribed to one session, has every ro the
// daemon decided on before the call. The ro goes out at the subscription's
// next pump step, and before that step the writer can send control
// messages twice: after the step under way, and at the start of its next
// pass. Each sync is answered in a later batch than the one before, so the
// third answer comes after the ro.
func (tc *tclient) settle() {
	tc.t.Helper()
	for range 3 {
		tc.sync()
	}
}

func (tc *tclient) apply(ev client.Event) {
	t := tc.t
	t.Helper()
	if f := ev.Frame; f != nil {
		st := tc.stream(f.SID)
		if f.Gen != st.gen {
			t.Errorf("sid %d: frame of generation %d in generation %d", f.SID, f.Gen, st.gen)
		}
		switch {
		case f.Type == protocol.FrameReplay && st.replaying && st.prefixDue:
			// The prefix is not part of the ring, so it is not acked.
			st.prefixes = append(st.prefixes, bytes.Clone(f.Payload))
			st.prefixDue = false
			return
		case f.Type == protocol.FrameReplay && st.replaying:
			st.replayed = append(st.replayed, f.Payload...)
		case f.Type == protocol.FrameLive && !st.replaying:
			st.live = append(st.live, f.Payload...)
		default:
			t.Errorf("sid %d: frame type %#x with replaying %v", f.SID, f.Type, st.replaying)
		}
		st.off += uint64(len(f.Payload))
		if tc.noAck {
			return
		}
		if err := tc.c.Ack(f.SID, f.Gen, st.off); err != nil {
			t.Errorf("ack: %v", err)
		}
		return
	}
	switch m := ev.Msg.(type) {
	case protocol.Sessions:
		tc.lists = append(tc.lists, m.List)
	case protocol.Error:
		tc.errs = append(tc.errs, m)
	case protocol.Status:
		tc.statuses = append(tc.statuses, m)
	case protocol.Notify:
		tc.notifies = append(tc.notifies, m)
	case protocol.Repos:
		tc.repos = append(tc.repos, m.List)
	case protocol.Replay:
		st := tc.stream(m.SID)
		if st.replaying {
			t.Errorf("sid %d: %+v inside a replay", m.SID, m)
		}
		st.gen, st.off, st.replaying, st.prefixDue, st.ended = m.Gen, m.From, true, true, false
		st.msgs = append(st.msgs, m.T)
		st.replays = append(st.replays, m)
	case protocol.Live:
		st := tc.stream(m.SID)
		if !st.replaying || st.prefixDue || m.Gen != st.gen || m.Off != st.off {
			t.Errorf("sid %d: %+v with replaying %v, prefix due %v, generation %d, offset %d", m.SID, m, st.replaying, st.prefixDue, st.gen, st.off)
		}
		st.replaying = false
		st.msgs = append(st.msgs, m.T)
		st.lives = append(st.lives, m)
	case protocol.Exit:
		st := tc.stream(m.SID)
		st.msgs = append(st.msgs, m.T)
		st.exit, st.ended = &m, true
	default:
		t.Errorf("unexpected message %+v", m)
	}
}

// create starts a session running cmd at 80x24 and returns its sid, which the
// creator learns from its first replay.
func (tc *tclient) create(cmd string) uint32 {
	tc.t.Helper()
	return tc.createIn("", cmd)
}

// createIn is create with the session's cwd.
func (tc *tclient) createIn(cwd, cmd string) uint32 {
	tc.t.Helper()
	before := maps.Clone(tc.streams)
	if err := tc.c.Create(cwd, cmd, "test", 80, 24); err != nil {
		tc.t.Fatal(err)
	}
	var sid uint32
	tc.waitFor("replay of the new session", func() bool {
		for id, st := range tc.streams {
			if before[id] == nil && len(st.replays) > 0 {
				sid = id
				return true
			}
		}
		return false
	})
	return sid
}

// subscribe subscribes to sid and waits for the live that ends the replay.
func (tc *tclient) subscribe(sid uint32) protocol.Live {
	tc.t.Helper()
	n := len(tc.stream(sid).lives)
	if err := tc.c.Subscribe(sid); err != nil {
		tc.t.Fatal(err)
	}
	tc.waitFor("live", func() bool { return len(tc.stream(sid).lives) > n })
	return tc.stream(sid).lives[n]
}

func (tc *tclient) waitLive(sid uint32, want string) {
	tc.t.Helper()
	tc.waitFor("live output "+want, func() bool { return bytes.Contains(tc.stream(sid).live, []byte(want)) })
}

func (tc *tclient) waitExit(sid uint32) protocol.Exit {
	tc.t.Helper()
	tc.waitFor("exit", func() bool { return tc.stream(sid).exit != nil })
	return *tc.stream(sid).exit
}

// waitListed waits for a sessions list in which sid is listed and ok holds
// for it.
func (tc *tclient) waitListed(sid uint32, ok func(protocol.SessionInfo) bool) protocol.SessionInfo {
	tc.t.Helper()
	tc.waitFor("listing", func() bool { i := tc.info(sid); return i != nil && ok(*i) })
	return *tc.info(sid)
}

// lastStatus returns the latest status event for sid, or nil.
func (tc *tclient) lastStatus(sid uint32) *protocol.Status {
	for i := len(tc.statuses) - 1; i >= 0; i-- {
		if tc.statuses[i].SID == sid {
			return &tc.statuses[i]
		}
	}
	return nil
}

// waitStatus waits until the latest status event for sid satisfies ok and
// returns it. Like every wait, it returns right after the event that
// satisfied it, so tc holds only what arrived before.
func (tc *tclient) waitStatus(sid uint32, ok func(protocol.Status) bool) protocol.Status {
	tc.t.Helper()
	tc.waitFor("status", func() bool { s := tc.lastStatus(sid); return s != nil && ok(*s) })
	return *tc.lastStatus(sid)
}

// waitNotify waits for a notify event for which ok holds and returns the
// first such.
func (tc *tclient) waitNotify(ok func(protocol.Notify) bool) protocol.Notify {
	tc.t.Helper()
	tc.waitFor("notify", func() bool { return slices.ContainsFunc(tc.notifies, ok) })
	return tc.notifies[slices.IndexFunc(tc.notifies, ok)]
}

// waitRepos waits until the latest repos message satisfies cond and returns it.
func (tc *tclient) waitRepos(cond func([]string) bool) []string {
	tc.t.Helper()
	tc.waitFor("repos", func() bool { return len(tc.repos) > 0 && cond(tc.repos[len(tc.repos)-1]) })
	return tc.repos[len(tc.repos)-1]
}

func running(i protocol.SessionInfo) bool { return i.State == protocol.StateRunning }
func exited(i protocol.SessionInfo) bool  { return i.State == protocol.StateExited }

func listed(list []protocol.SessionInfo, sid uint32) bool {
	return slices.ContainsFunc(list, func(i protocol.SessionInfo) bool { return i.SID == sid })
}
