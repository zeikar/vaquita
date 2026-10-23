package server

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

const (
	convA = "1e384cb4-cf8e-4a61-b8be-9bbd9f093a8c"
	convB = "01a166f1-5cfb-7552-a0bd-cd891592ca64"
	// Ascending, so that of two codex files dated in the same second the
	// later id is the later name, which wins the tie.
	codex1 = "11111111-1111-4111-8111-111111111111"
	codex2 = "22222222-2222-4222-8222-222222222222"
	codex3 = "33333333-3333-4333-8333-333333333333"
)

// agentReport is report from app.
func agentReport(state, msg, app string) string {
	return `printf '\033]7501;` + payload(state, "", msg) + `:app=` + app + `\033\\'`
}

// osc9 is a shell command that writes an OSC 9 notification with body.
func osc9(body string) string {
	return `printf '\033]9;` + body + `\033\\'`
}

// typeLine types line into sid's shell.
func (tc *tclient) typeLine(sid uint32, line string) {
	tc.t.Helper()
	if err := tc.c.Input(sid, tc.stream(sid).gen, []byte(line+"\n")); err != nil {
		tc.t.Fatal(err)
	}
}

// waitRecord waits until state.json holds a record of sid for which ok holds,
// and returns it.
func waitRecord(t *testing.T, srv *Server, sid uint32, what string, ok func(state.SessionRecord) bool) state.SessionRecord {
	t.Helper()
	deadline := time.Now().Add(sessTimeout)
	for {
		r := savedRecord(t, srv, sid)
		if r != nil && ok(*r) {
			return *r
		}
		if time.Now().After(deadline) {
			t.Fatalf("no record with %s within %v; state.json holds %+v", what, sessTimeout, r)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitConversationRead waits until no read of sid's conversation id is in
// flight. The drain asks for its read before it queues the status, so once a
// client has that status, the read it asked for has ended when this returns.
func waitConversationRead(t *testing.T, srv *Server, sid uint32) {
	t.Helper()
	e := srv.table.lookup(sid)
	if e == nil {
		t.Fatalf("session %d not listed", sid)
	}
	waitReadEnded(t, e)
}

// waitReadEnded waits until no read of e's conversation id is in flight.
func waitReadEnded(t *testing.T, e *entry) {
	t.Helper()
	deadline := time.Now().Add(sessTimeout)
	for {
		e.sess.Lock()
		busy := e.idBusy
		e.sess.Unlock()
		if !busy {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("read of session %d's conversation id still in flight after %v", e.sid, sessTimeout)
		}
		time.Sleep(time.Millisecond)
	}
}

// showingMsg matches a status event whose row shows state with msg.
func showingMsg(state, msg string) func(protocol.Status) bool {
	return func(s protocol.Status) bool { return s.Status != nil && s.Status.State == state && s.Status.Msg == msg }
}

// writeRollout writes the conversation file codex starts for id in cwd at
// when: named and filed by local time, with a session_meta first line.
func writeRollout(t *testing.T, when time.Time, id, cwd string) {
	t.Helper()
	l := when.Local()
	dir := filepath.Join(os.Getenv("HOME"), ".codex", "sessions", l.Format("2006"), l.Format("01"), l.Format("02"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	line := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"cwd":%q,"timestamp":%q}}`+"\n", id, cwd, when.UTC().Format(time.RFC3339))
	name := "rollout-" + l.Format("2006-01-02T15-04-05") + "-" + id + ".jsonl"
	if err := os.WriteFile(filepath.Join(dir, name), []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
}

// claudeSteps runs a session through what the reader sees of a claude: the
// pid file of a member of the session, rewritten by a /clear and deleted by a
// normal exit, each followed by a report. The record ends with convB, the id
// from before the exit.
func claudeSteps(t *testing.T) (*Server, *tclient, uint32) {
	t.Helper()
	srv := startSessionServer(t, Options{})
	dir := filepath.Join(os.Getenv("HOME"), ".claude", "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	a := dialClient(t, srv)
	// The sleep stands in for claude: the file is named by its pid.
	sid := a.create(`sleep 60 & printf '{"sessionId":"%s","cwd":"%s","startedAt":%d}' ` + convA +
		` "$PWD" $(( $(date +%s) * 1000 )) > "$HOME/.claude/sessions/$!.json"; ` + agentReport("working", "", "claude-code"))
	waitRecord(t, srv, sid, "claude's id", func(r state.SessionRecord) bool { return r.Agent == "claude" && r.Conversation == convA })

	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(files) != 1 {
		t.Fatalf("pid files %v, %v; want one", files, err)
	}
	data, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(files[0], bytes.Replace(data, []byte(convA), []byte(convB), 1), 0o644); err != nil {
		t.Fatal(err)
	}
	a.typeLine(sid, report("done", "", ""))
	waitRecord(t, srv, sid, "the id after a /clear", func(r state.SessionRecord) bool { return r.Conversation == convB })

	if err := os.Remove(files[0]); err != nil {
		t.Fatal(err)
	}
	a.typeLine(sid, report("working", "", "gone"))
	a.waitStatus(sid, showingMsg(protocol.ViewWorking, "gone"))
	waitConversationRead(t, srv, sid)
	if r := savedRecord(t, srv, sid); r == nil || r.Agent != "claude" || r.Conversation != convB {
		t.Errorf("after the pid file went, state.json holds %+v, want claude's last id kept", r)
	}
	return srv, a, sid
}

// claude's id is read from the pid file of a member of the session, follows a
// /clear, and stays once the file is gone.
func TestClaudeConversationRecorded(t *testing.T) {
	claudeSteps(t)
}

// codex's id is inferred from the newest conversation file started in the
// session's cwd since the session started, leaving out the id another running
// session holds.
func TestCodexConversationRecorded(t *testing.T) {
	srv := startSessionServer(t, Options{})
	cwd := t.TempDir()
	a := dialClient(t, srv)
	sid := a.createIn(cwd, ":")
	started := waitRecord(t, srv, sid, "a record", func(state.SessionRecord) bool { return true }).Started
	writeRollout(t, started.Add(-time.Second), codex1, cwd)
	a.typeLine(sid, osc9("pong")+"; "+agentReport("idle", "", "codex"))
	waitRecord(t, srv, sid, "codex's id", func(r state.SessionRecord) bool { return r.Agent == "codex" && r.Conversation == codex1 })

	// A second done only updates the msg of the first, so a working comes
	// between them.
	writeRollout(t, started, codex2, cwd)
	a.typeLine(sid, agentReport("working", "", "codex")+"; "+osc9("pong2")+"; "+agentReport("idle", "", "codex"))
	waitRecord(t, srv, sid, "codex's newer id", func(r state.SessionRecord) bool { return r.Conversation == codex2 })

	// Another session in the same cwd takes the newest file. Dated no
	// earlier than codex2's and named later, it would be the first
	// session's pick too.
	other := a.createIn(cwd, ":")
	otherStarted := waitRecord(t, srv, other, "a record", func(state.SessionRecord) bool { return true }).Started
	writeRollout(t, otherStarted, codex3, cwd)
	a.typeLine(other, osc9("pong")+"; "+agentReport("idle", "", "codex"))
	waitRecord(t, srv, other, "the other session's id", func(r state.SessionRecord) bool { return r.Conversation == codex3 })

	a.typeLine(sid, agentReport("working", "", "codex")+"; "+osc9("pong3")+"; "+agentReport("idle", "", "codex"))
	a.waitStatus(sid, showingMsg(protocol.ViewDone, "pong3"))
	waitConversationRead(t, srv, sid)
	if r := savedRecord(t, srv, sid); r == nil || r.Agent != "codex" || r.Conversation != codex2 {
		t.Errorf("state.json holds %+v, want codex2 kept: codex3 is the other session's", r)
	}
}

// A codex reporting where claude did replaces the agent and drops claude's
// id, although nothing has been found for codex. Its working leaves the view
// as it was, so only the change of app asks for the drain and the read.
func TestAgentChangeDropsTheOldConversation(t *testing.T) {
	srv, a, sid := claudeSteps(t)
	// A working the shell prints itself is cleared at the next poll, so a
	// job of its own holds the view; after a line it reports again, the same
	// view from codex.
	printfHeld := `printf "\033]7501;` + payload("working", "", "held")
	a.typeLine(sid, `set -m; sh -c '`+printfHeld+`\007"; read l; `+printfHeld+`:app=codex\007"; read l'`)
	a.waitStatus(sid, showingMsg(protocol.ViewWorking, "held"))
	waitConversationRead(t, srv, sid)

	a.typeLine(sid, "")
	r := waitRecord(t, srv, sid, "codex as the agent", func(r state.SessionRecord) bool { return r.Agent == "codex" })
	if r.Conversation != "" {
		t.Errorf("state.json holds %+v, want no id: claude's does not belong to codex", r)
	}
	// A status the drain sent would have been queued before the save.
	a.sync()
	if s := a.lastStatus(sid); s == nil || !showingMsg(protocol.ViewWorking, "held")(*s) {
		t.Errorf("last status %+v, want the held working: the view was not to change", s)
	}
}

// Reads run off the PTY reader, so a burst of reports, each asking for one,
// does not hold up the output.
func TestConversationReadDoesNotBlockOutput(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	pair := `printf '\033]7501;state=working:app=claude-code\033\\\033]7501;state=idle:app=claude-code\033\\'`
	sid := a.create(`i=0; while [ $i -lt 200 ]; do ` + pair + `; i=$((i+1)); done; echo end-of-reports`)
	a.waitLive(sid, "end-of-reports")
	waitRecord(t, srv, sid, "claude as the agent", func(r state.SessionRecord) bool { return r.Agent == "claude" })
	waitConversationRead(t, srv, sid)

	b := dialClient(t, srv)
	if i := b.info(sid); i == nil || i.State != protocol.StateRunning || i.Status != nil {
		t.Errorf("second client lists %+v, want the session running with no status after the last idle", i)
	}
	if r := savedRecord(t, srv, sid); r == nil || r.Agent != "claude" || r.Conversation != "" {
		t.Errorf("state.json holds %+v, want claude without an id: there is no pid file", r)
	}
}

// An app that is neither claude nor codex records no agent.
func TestUnknownAppRecordsNoConversation(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create(agentReport("working", "", "x"))
	a.waitStatus(sid, showing(protocol.ViewWorking))
	waitConversationRead(t, srv, sid)
	if r := savedRecord(t, srv, sid); r == nil || r.Agent != "" || r.Conversation != "" {
		t.Errorf("state.json holds %+v, want no agent", r)
	}
}

// A drain that asks while a read is in flight has it run once more when it
// ends, never a second one beside it, and neither the PTY reader nor the
// drains wait for it.
func TestConversationReadsOneAtATime(t *testing.T) {
	srv := startSessionServer(t, Options{})
	calls := make(chan convSnapshot)
	results := make(chan string)
	// Registered after startSessionServer's cleanup, so it runs first and
	// frees a read a failed test left held.
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	var inFlight atomic.Int32
	var overlap atomic.Bool
	srv.table.mu.Lock()
	srv.table.readID = func(snap convSnapshot) string {
		if inFlight.Add(1) > 1 {
			overlap.Store(true)
		}
		defer inFlight.Add(-1)
		select {
		case calls <- snap:
		case <-done:
			return ""
		}
		select {
		case id := <-results:
			return id
		case <-done:
			return ""
		}
	}
	srv.table.mu.Unlock()
	next := func(what string) convSnapshot {
		t.Helper()
		select {
		case snap := <-calls:
			return snap
		case <-time.After(sessTimeout):
			t.Fatalf("no %s within %v", what, sessTimeout)
			return convSnapshot{}
		}
	}
	give := func(id string) {
		t.Helper()
		select {
		case results <- id:
		case <-time.After(sessTimeout):
			t.Fatalf("no read took %s within %v", id, sessTimeout)
		}
	}

	a := dialClient(t, srv)
	// Dones without a working raise no notification, and the poll that
	// follows a report the shell prints leaves a done as it is, so only the
	// reports ask for reads.
	sid := a.create(agentReport("done", "one", "claude-code"))
	if snap := next("first read"); snap.sid != sid || snap.agent != "claude" {
		t.Errorf("first read of %+v, want claude in session %d", snap, sid)
	}
	a.typeLine(sid, agentReport("done", "two", "claude-code")+"; echo held-$((6*7))")
	a.waitLive(sid, "held-42")
	a.waitStatus(sid, showingMsg(protocol.ViewDone, "two"))
	e := srv.table.lookup(sid)
	e.sess.Lock()
	busy, due := e.idBusy, e.idDue
	e.sess.Unlock()
	if !busy || !due {
		t.Fatalf("read in flight %v, asked for again %v; want both", busy, due)
	}

	give(convA)
	next("read asked for meanwhile")
	give(convB)
	waitRecord(t, srv, sid, "the second read's id", func(r state.SessionRecord) bool { return r.Agent == "claude" && r.Conversation == convB })
	waitConversationRead(t, srv, sid)
	select {
	case snap := <-calls:
		t.Errorf("a third read of %+v", snap)
	default:
	}
	if overlap.Load() {
		t.Error("two reads were in flight at once")
	}
}

// Two codex sessions in one cwd can both find the same newest file before
// either records it; only the first keeps the id.
func TestCodexConversationRecordedOnce(t *testing.T) {
	srv := startSessionServer(t, Options{})
	srv.table.mu.Lock()
	srv.table.readID = func(convSnapshot) string { return codex1 }
	srv.table.mu.Unlock()
	a := dialClient(t, srv)
	first := a.create(osc9("one") + "; " + agentReport("idle", "", "codex"))
	waitRecord(t, srv, first, "the first session's id", func(r state.SessionRecord) bool { return r.Conversation == codex1 })

	second := a.create(osc9("two") + "; " + agentReport("idle", "", "codex"))
	a.waitStatus(second, showingMsg(protocol.ViewDone, "two"))
	waitConversationRead(t, srv, second)
	if r := savedRecord(t, srv, second); r == nil || r.Agent != "codex" || r.Conversation != "" {
		t.Errorf("state.json holds %+v for the second session, want codex without the first one's id", r)
	}
}
