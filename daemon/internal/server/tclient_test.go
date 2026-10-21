package server

import (
	"bytes"
	"maps"
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
	t       *testing.T
	c       *client.Client
	lists   [][]protocol.SessionInfo // every sessions message, the hello's first
	errs    []protocol.Error
	streams map[uint32]*stream
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
}

func dialClient(t *testing.T, srv *Server) *tclient {
	t.Helper()
	c, list, err := client.Dial(testCtx(t), state.Endpoint{URL: srv.URL(), Token: testToken}, protocol.ClientGUI)
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
		select {
		case ev, ok := <-tc.c.Events():
			if !ok {
				tc.t.Fatalf("connection closed while waiting for %s", what)
			}
			if ev.Err != nil {
				tc.t.Fatalf("connection failed while waiting for %s: %v", what, ev.Err)
			}
			tc.apply(ev)
		case <-deadline:
			tc.t.Fatalf("no %s within %v", what, sessTimeout)
		}
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
	case protocol.Replay:
		st := tc.stream(m.SID)
		if st.replaying {
			t.Errorf("sid %d: %+v inside a replay", m.SID, m)
		}
		st.gen, st.off, st.replaying, st.prefixDue = m.Gen, m.From, true, true
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
		st.exit = &m
	default:
		t.Errorf("unexpected message %+v", m)
	}
}

// create starts a session running cmd at 80x24 and returns its sid, which the
// creator learns from its first replay.
func (tc *tclient) create(cmd string) uint32 {
	tc.t.Helper()
	before := maps.Clone(tc.streams)
	if err := tc.c.Create("", cmd, "test", 80, 24); err != nil {
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

func running(i protocol.SessionInfo) bool { return i.State == protocol.StateRunning }
func exited(i protocol.SessionInfo) bool  { return i.State == protocol.StateExited }

func listed(list []protocol.SessionInfo, sid uint32) bool {
	return slices.ContainsFunc(list, func(i protocol.SessionInfo) bool { return i.SID == sid })
}
