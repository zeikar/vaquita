//go:build stress

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/client"
	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

const (
	stressDuration = 10 * time.Second
	// The design budget: the daemon itself plus one ring per session.
	rssBudgetKB = (30 + 3*1) * 1024
	minBytes    = 10 << 20
)

type stressSession struct {
	sid       uint32
	pid       int
	off       uint64 // ring offset after everything counted so far
	replayEnd uint64 // ring offset after the replay's non-prefix bytes
	prefix    bool   // the next 0x02 frame is the mode prefix
	bytes     uint64
	exited    bool
}

// pgidGone reports whether no process group pid remains.
func pgidGone(pid int) bool { return syscall.Kill(-pid, 0) == syscall.ESRCH }

// signalable guards the fallback kills: -1 would hit every process of the
// user, and the test's own group must never be signalled.
func signalable(pid int) bool {
	return pid > 1 && pid != os.Getpid() && pid != syscall.Getpgrp()
}

func rssKB(t *testing.T, pid int) int {
	t.Helper()
	out, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		t.Fatalf("ps: %v", err)
	}
	kb, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		t.Fatalf("parse rss %q: %v", out, err)
	}
	return kb
}

// TestRSSBounded runs three producers that never stop against the real
// binary, with a client that acks everything, and checks the daemon's RSS.
func TestRSSBounded(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "vaquitad")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	home := t.TempDir()
	// A plain /bin/sh keeps the sessions independent of the user's rc files.
	cfg, _ := json.Marshal(state.State{Shell: "/bin/sh"})
	if err := os.WriteFile(state.StatePath(home), cfg, 0o600); err != nil {
		t.Fatal(err)
	}

	var stderr bytes.Buffer
	daemon := exec.Command(bin, "serve")
	daemon.Env = []string{"VAQUITA_HOME=" + home, "HOME=" + t.TempDir(), "PATH=/usr/bin:/bin"}
	daemon.Stderr = &stderr
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	dpid := daemon.Process.Pid
	waited := make(chan struct{})
	go func() { daemon.Wait(); close(waited) }()

	var mu sync.Mutex
	bySID := map[uint32]*stressSession{}
	pids := map[uint32]int{} // the sessions broadcast may precede the replay
	var sessions [3]*stressSession

	stopDaemon := func() {
		select {
		case <-waited:
			return
		default:
		}
		syscall.Kill(dpid, syscall.SIGTERM)
		select {
		case <-waited:
		case <-time.After(10 * time.Second):
			t.Error("daemon ignored SIGTERM")
			syscall.Kill(dpid, syscall.SIGKILL)
			<-waited
		}
	}
	groupsVerified := false
	t.Cleanup(func() {
		stopDaemon()
		if t.Failed() {
			t.Logf("daemon stderr:\n%s", stderr.String())
		}
		if groupsVerified {
			return
		}
		// Whatever outlived the daemon on a failure path.
		mu.Lock()
		defer mu.Unlock()
		for _, s := range sessions {
			if s != nil && signalable(s.pid) && !pgidGone(s.pid) {
				syscall.Kill(-s.pid, syscall.SIGKILL)
			}
		}
	})

	var ep state.Endpoint
	deadline := time.Now().Add(10 * time.Second)
	for {
		var err error
		ep, err = state.ReadEndpoint(home)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("daemon never published its endpoint: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := client.Dial(ctx, ep, protocol.ClientGUI)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	cmds := []string{
		"yes",
		"yes | tr -d '\\n'",
		"(printf '\\033]'; yes)",
	}
	created := make(chan *stressSession, 3)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ev := range c.Events() {
			if ev.Err != nil {
				t.Errorf("connection: %v", ev.Err)
				return
			}
			if ev.Msg != nil {
				var announce *stressSession
				mu.Lock()
				switch m := ev.Msg.(type) {
				case protocol.Replay:
					s := bySID[m.SID]
					if s == nil {
						s = &stressSession{sid: m.SID, pid: pids[m.SID]}
						bySID[m.SID] = s
						announce = s
					}
					s.off, s.replayEnd, s.prefix = m.From, m.From, true
				case protocol.Live:
					if s := bySID[m.SID]; s != nil && m.Off != s.replayEnd {
						t.Errorf("session %d: live.off %d, replay counted up to %d", m.SID, m.Off, s.replayEnd)
					}
				case protocol.Sessions:
					for _, in := range m.List {
						pids[in.SID] = in.PID
						if s := bySID[in.SID]; s != nil {
							s.pid = in.PID
						}
					}
				case protocol.Exit:
					if s := bySID[m.SID]; s != nil {
						s.exited = true
					}
				case protocol.Error:
					t.Errorf("daemon error: %+v", m)
				}
				mu.Unlock()
				if announce != nil {
					created <- announce
				}
				continue
			}
			f := ev.Frame
			mu.Lock()
			s := bySID[f.SID]
			if s == nil {
				mu.Unlock()
				continue
			}
			if f.Type == protocol.FrameReplay && s.prefix {
				s.prefix = false
			} else {
				n := uint64(len(f.Payload))
				s.off += n
				s.bytes += n
				if f.Type == protocol.FrameReplay {
					s.replayEnd += n
				}
			}
			sid, off := s.sid, s.off
			mu.Unlock()
			if err := c.Ack(sid, f.Gen, off); err != nil {
				return
			}
		}
	}()

	for i, cmd := range cmds {
		if err := c.Create(t.TempDir(), cmd, "stress", 80, 24); err != nil {
			t.Fatal(err)
		}
		select {
		case s := <-created:
			mu.Lock()
			sessions[i] = s
			mu.Unlock()
		case <-time.After(10 * time.Second):
			t.Fatalf("no replay for session %d", i)
		}
	}
	// The pids arrive with the sessions broadcast. Fail before measuring
	// rather than learn on cleanup that they are unknown.
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		mu.Lock()
		known := true
		for _, s := range sessions {
			known = known && signalable(s.pid)
		}
		mu.Unlock()
		if known {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("session pids not reported")
		}
	}

	maxKB := 0
	for i := 0; i < int(stressDuration/time.Second); i++ {
		time.Sleep(time.Second)
		kb := rssKB(t, dpid)
		maxKB = max(maxKB, kb)
		t.Logf("t=%2ds rss=%d KB", i+1, kb)
	}

	mu.Lock()
	for i, s := range sessions {
		t.Logf("session %d (%q): %d bytes received", i, cmds[i], s.bytes)
		if s.bytes < minBytes {
			t.Errorf("session %d received %d bytes, want at least %d; the producer did not run at speed", i, s.bytes, minBytes)
		}
	}
	mu.Unlock()

	for _, s := range sessions {
		if err := c.Kill(s.sid); err != nil {
			t.Errorf("kill session %d: %v", s.sid, err)
		}
	}
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		mu.Lock()
		all := true
		for _, s := range sessions {
			all = all && s.exited
		}
		mu.Unlock()
		if all {
			break
		}
	}
	c.Close()
	<-done
	stopDaemon()

	for _, s := range sessions {
		gone := false
		for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
			if gone = pgidGone(s.pid); gone {
				break
			}
		}
		if !gone {
			t.Errorf("session %d: process group %d still alive", s.sid, s.pid)
		}
	}
	groupsVerified = !t.Failed()

	t.Logf("max rss %d KB, budget %d KB", maxKB, rssBudgetKB)
	if maxKB > rssBudgetKB {
		t.Errorf("max RSS %d KB exceeds the budget of %d KB", maxKB, rssBudgetKB)
	}
}
