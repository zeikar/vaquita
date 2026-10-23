package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

// A record whose PTY session still has a process lists it; kill and dismiss
// answer with it and keep the record, until the process is gone and a kill
// leaves the record restorable.
func TestRecordWithOrphansIsCleanedByKill(t *testing.T) {
	sleep := exec.Command("/bin/sleep", "60")
	sleep.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := sleep.Start(); err != nil {
		t.Fatal(err)
	}
	pid := sleep.Process.Pid
	t.Cleanup(func() {
		sleep.Process.Kill()
		sleep.Wait()
	})
	rec := state.SessionRecord{SID: 5, PID: pid, Started: time.Now(), Cwd: "/tmp", Cmd: "claude"}
	srv := startSessionServer(t, Options{State: state.State{Shell: "/bin/sh", Sessions: []state.SessionRecord{rec}}})
	a := dialClient(t, srv)

	// Options.State is taken as given, so the orphans are found by the first
	// rescan.
	if err := a.c.Kill(5); err != nil {
		t.Fatal(err)
	}
	a.waitFor("orphans error", func() bool { return len(a.errs) == 1 })
	if e := a.errs[0]; e.Code != protocol.CodeOrphans || e.SID != 5 || !slices.Equal(e.PIDs, []int{pid}) {
		t.Errorf("kill answered %+v, want %q with [%d]", e, protocol.CodeOrphans, pid)
	}
	if i := a.info(5); i == nil || i.Restorable || !slices.Equal(i.Orphans, []int{pid}) {
		t.Errorf("listed %+v, want orphans [%d] and not restorable", i, pid)
	}

	if err := a.c.Dismiss(5); err != nil {
		t.Fatal(err)
	}
	a.waitFor("second orphans error", func() bool { return len(a.errs) == 2 })
	if e := a.errs[1]; e.Code != protocol.CodeOrphans || e.SID != 5 || !slices.Equal(e.PIDs, []int{pid}) {
		t.Errorf("dismiss answered %+v, want %q with [%d]", e, protocol.CodeOrphans, pid)
	}
	if savedRecord(t, srv, 5) == nil {
		t.Fatal("dismiss removed a record that holds a process")
	}

	if err := sleep.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	sleep.Wait()
	deadline := time.Now().Add(sessTimeout)
	for {
		if _, err := unix.Getsid(pid); err != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("process %d still alive", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
	n := len(a.lists)
	if err := a.c.Kill(5); err != nil {
		t.Fatal(err)
	}
	a.waitFor("list after the kill", func() bool { return len(a.lists) > n })
	if i := a.info(5); i == nil || !i.Restorable || len(i.Orphans) != 0 {
		t.Errorf("listed %+v, want restorable without orphans", i)
	}
	if len(a.errs) != 2 {
		t.Errorf("errors %+v, want only the first two", a.errs)
	}

	if err := a.c.Dismiss(5); err != nil {
		t.Fatal(err)
	}
	a.waitFor("record dismissed", func() bool { return a.info(5) == nil })
	if r := savedRecord(t, srv, 5); r != nil {
		t.Errorf("state.json still holds %+v", r)
	}
}

// stubCodexOptions are the options AgentCommand gives codex, as the stub
// prints them.
const stubCodexOptions = `-c tui.notifications=["agent-turn-complete","approval-requested","plan-mode-prompt","async-question"] -c tui.notification_method="osc9" -c tui.notification_condition="always"`

// stubAgents defines shell functions for claude and codex in $HOME/.profile,
// which a login shell sources before the command, so that a reopen never
// launches the real agents found on PATH. Call it after startSessionServer,
// which points HOME at a temporary directory.
func stubAgents(t *testing.T) {
	t.Helper()
	stub := "claude() { printf 'stub:claude:%s\\n' \"$*\"; }\ncodex() { printf 'stub:codex:%s\\n' \"$*\"; }\n"
	if err := os.WriteFile(filepath.Join(os.Getenv("HOME"), ".profile"), []byte(stub), 0o644); err != nil {
		t.Fatal(err)
	}
}

// goneRecord is the record of a session from an earlier run whose shell has
// exited and left nothing behind, so it is restorable.
func goneRecord(t *testing.T, sid int, cwd, cmd string) state.SessionRecord {
	t.Helper()
	gone := exec.Command("/usr/bin/true")
	if err := gone.Run(); err != nil {
		t.Fatal(err)
	}
	return state.SessionRecord{SID: sid, PID: gone.ProcessState.Pid(), Started: time.Now(), Cwd: cwd, Cmd: cmd}
}

// startRecords starts a session server on recs, which its state.json already
// holds, as a daemon's home does at startup.
func startRecords(t *testing.T, recs ...state.SessionRecord) *Server {
	t.Helper()
	st := state.State{Shell: "/bin/sh", Sessions: recs}
	home := t.TempDir()
	if err := st.Save(home); err != nil {
		t.Fatal(err)
	}
	return startSessionServer(t, Options{Home: home, State: st})
}

// answer sends a request and returns the error it is answered with.
func answer(tc *tclient, send func() error) protocol.Error {
	tc.t.Helper()
	n := len(tc.errs)
	if err := send(); err != nil {
		tc.t.Fatal(err)
	}
	tc.waitFor("error", func() bool { return len(tc.errs) > n })
	return tc.errs[n]
}

func wantErr(t *testing.T, what string, e protocol.Error, code string, sid uint32) {
	t.Helper()
	if e.Code != code || e.SID != sid {
		t.Errorf("%s answered %+v, want %q for %d", what, e, code, sid)
	}
}

func entryCount(srv *Server) int {
	srv.table.mu.Lock()
	defer srv.table.mu.Unlock()
	return len(srv.table.entries)
}

// A reopen starts a session in the record's cwd with its name, answered like
// a create, and replaces the record in one list and one save.
func TestReopenRecord(t *testing.T) {
	cwd := t.TempDir()
	rec := goneRecord(t, 7, cwd, "old")
	rec.Name = "x"
	srv := startRecords(t, rec)
	stubAgents(t)
	a := dialClient(t, srv)

	sid := a.reopen(7, 100, 30)
	if sid != 8 {
		t.Fatalf("reopen started sid %d, want 8", sid)
	}
	a.waitFor("live", func() bool { return len(a.stream(8).lives) > 0 })
	st := a.stream(8)
	if r := st.replays[0]; r.Gen != 1 || r.From != 0 || r.Cols != 100 || r.Rows != 30 {
		t.Errorf("replay %+v, want generation 1 from 0 at 100x30", r)
	}
	if l := st.lives[0]; l.Off != 0 || l.RO {
		t.Errorf("live %+v, want one at offset 0, writable", l)
	}
	i := a.waitListed(8, running)
	if i.Cwd != cwd || i.Name != "x" || i.Cmd != "" || i.Cols != 100 || i.Rows != 30 {
		t.Errorf("listed %+v, want the record's cwd and name, no command, 100x30", i)
	}
	for _, list := range a.lists {
		if listed(list, 7) && listed(list, 8) {
			t.Errorf("a list holds both the record and its new session: %+v", list)
		}
	}
	if a.info(7) != nil {
		t.Errorf("the record is still listed beside its new session")
	}
	if r := savedRecord(t, srv, 8); r == nil || r.Cwd != cwd || r.Name != "x" || r.Cmd != "" {
		t.Errorf("state.json holds %+v for 8", r)
	}
	if r := savedRecord(t, srv, 7); r != nil {
		t.Errorf("state.json still holds %+v", r)
	}

	wantErr(t, "second reopen", answer(a, func() error { return a.c.Reopen(7, 80, 24) }), protocol.CodeNoSession, 7)
}

// The agent is resumed by the recorded conversation id, or by its continue
// without one, through AgentCommand; the new record keeps the restored
// command and the agent and id. An agent session with neither name nor title
// is titled after the agent, so that its row shows no id: claude's by its
// title, which its topic replaces later, codex's by its name.
func TestReopenMapsAgentCommands(t *testing.T) {
	cases := []struct {
		rec                   state.SessionRecord
		out, cmd, name, title string
	}{
		{goneRecord(t, 1, t.TempDir(), "claude --model x"), "stub:claude:--continue", "claude --continue", "x", ""},
		{goneRecord(t, 2, t.TempDir(), "codex"), "stub:codex:" + stubCodexOptions + " resume --last", "codex resume --last", "codex", ""},
		{goneRecord(t, 3, t.TempDir(), ""), "stub:claude:--resume " + convA, "claude --resume '" + convA + "'", "", "claude"},
		{goneRecord(t, 4, t.TempDir(), "codex"), "stub:codex:" + stubCodexOptions + " resume " + convB, "codex resume '" + convB + "'", "codex", ""},
		// A plain shell prints nothing to wait for.
		{goneRecord(t, 5, t.TempDir(), "old"), "", "", "", ""},
	}
	cases[0].rec.Name = "x"
	cases[2].rec.Agent, cases[2].rec.Conversation = "claude", convA
	cases[3].rec.Agent, cases[3].rec.Conversation = "codex", convB
	var recs []state.SessionRecord
	for _, c := range cases {
		recs = append(recs, c.rec)
	}
	srv := startRecords(t, recs...)
	stubAgents(t)
	a := dialClient(t, srv)

	for _, c := range cases {
		sid := a.reopen(uint32(c.rec.SID), 80, 24)
		a.waitLive(sid, c.out)
		if i := a.waitListed(sid, running); i.Cmd != c.cmd || i.Name != c.name || i.Title != c.title {
			t.Errorf("record %d reopened listed as cmd %q, name %q, title %q, want %q, %q, %q", c.rec.SID, i.Cmd, i.Name, i.Title, c.cmd, c.name, c.title)
		}
		r := savedRecord(t, srv, sid)
		if r == nil || r.Cmd != c.cmd || r.Name != c.name || r.Title != c.title || r.Agent != c.rec.Agent || r.Conversation != c.rec.Conversation {
			t.Errorf("state.json holds %+v for record %d's new session, want cmd %q, name %q, title %q, agent %q, conversation %q", r, c.rec.SID, c.cmd, c.name, c.title, c.rec.Agent, c.rec.Conversation)
		}
	}
}

// A record with orphans is refused as it stands, with no rescan.
func TestReopenRefusesARecordWithOrphans(t *testing.T) {
	rec := goneRecord(t, 7, t.TempDir(), "claude")
	rec.Orphans = []int{1}
	srv := startRecords(t, rec)
	stubAgents(t)
	a := dialClient(t, srv)

	e := answer(a, func() error { return a.c.Reopen(7, 80, 24) })
	if e.Code != protocol.CodeOrphans || e.SID != 7 || !slices.Equal(e.PIDs, []int{1}) {
		t.Errorf("reopen answered %+v, want %q with [1]", e, protocol.CodeOrphans)
	}
	if n := entryCount(srv); n != 1 || len(a.streams) != 0 {
		t.Errorf("table holds %d entries and the client %d streams, want the record alone", n, len(a.streams))
	}
	if i := a.info(7); i == nil || i.Restorable || !slices.Equal(i.Orphans, []int{1}) {
		t.Errorf("listed %+v, want the record with its orphans", i)
	}
}

// A start that fails leaves the record restorable, and it reopens once the
// start can succeed.
func TestReopenFailedStartKeepsTheRecord(t *testing.T) {
	cwd := filepath.Join(t.TempDir(), "gone")
	if err := os.Mkdir(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(cwd); err != nil {
		t.Fatal(err)
	}
	srv := startRecords(t, goneRecord(t, 7, cwd, "old"))
	stubAgents(t)
	a := dialClient(t, srv)

	for _, what := range []string{"reopen", "second reopen"} {
		wantErr(t, what, answer(a, func() error { return a.c.Reopen(7, 80, 24) }), protocol.CodeBadRequest, 7)
		if i := a.info(7); i == nil || !i.Restorable {
			t.Errorf("after the %s the record is %+v, want it restorable", what, i)
		}
		if n := entryCount(srv); n != 1 || len(a.streams) != 0 {
			t.Errorf("after the %s the table holds %d entries and the client %d streams, want the record alone", what, n, len(a.streams))
		}
	}
	if r := savedRecord(t, srv, 7); r == nil {
		t.Error("state.json lost the record")
	}

	// A flag left set would answer bad-request here too.
	if err := os.Mkdir(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	sid := a.reopen(7, 80, 24)
	a.waitListed(sid, running)
	if a.info(7) != nil {
		t.Error("the record is still listed beside its new session")
	}
	if r := savedRecord(t, srv, 7); r != nil {
		t.Errorf("state.json still holds %+v", r)
	}
}

// A session of this run, running or exited, is not a record to reopen.
func TestReopenRefusesASessionOfThisRun(t *testing.T) {
	srv := startSessionServer(t, Options{})
	stubAgents(t)
	a := dialClient(t, srv)
	run := a.create("sleep 60")
	wantErr(t, "reopen of a running session", answer(a, func() error { return a.c.Reopen(run, 80, 24) }), protocol.CodeBadRequest, run)
	done := a.create("exit 0")
	a.waitExit(done)
	wantErr(t, "reopen of an exited session", answer(a, func() error { return a.c.Reopen(done, 80, 24) }), protocol.CodeBadRequest, done)
	if n := entryCount(srv); n != 2 {
		t.Errorf("table holds %d entries, want the two sessions", n)
	}
}

// A conversation open in a running session is not reopened beside it; a
// record without an id is never refused on that ground.
func TestReopenRefusesALiveConversation(t *testing.T) {
	rec := goneRecord(t, 7, t.TempDir(), "claude")
	rec.Agent, rec.Conversation = "claude", convA
	srv := startRecords(t, rec, goneRecord(t, 8, t.TempDir(), "old"))
	stubAgents(t)
	a := dialClient(t, srv)
	run := a.create("sleep 60")
	srv.table.mu.Lock()
	srv.table.entries[run].rec.Conversation = convA
	srv.table.mu.Unlock()

	wantErr(t, "reopen", answer(a, func() error { return a.c.Reopen(7, 80, 24) }), protocol.CodeConversationLive, 7)
	if n := entryCount(srv); n != 3 || len(a.streams) != 1 {
		t.Errorf("table holds %d entries and the client %d streams, want the two records and the running session", n, len(a.streams))
	}

	if err := a.c.Kill(run); err != nil {
		t.Fatal(err)
	}
	a.waitExit(run)
	sid := a.reopen(7, 80, 24)
	a.waitLive(sid, "stub:claude:--resume "+convA)

	// A plain shell, so that a check matching one empty id to another would
	// refuse the reopen below.
	a.create("")
	plain := a.reopen(8, 80, 24)
	if i := a.waitListed(plain, running); i.Cmd != "" {
		t.Errorf("record 8 reopened as %+v, want a plain shell", i)
	}
}

// A conversation whose reopen is starting from one record is not reopened
// from another, and the record being reopened is not dismissed.
func TestReopenRefusesAConversationBeingReopened(t *testing.T) {
	var recs []state.SessionRecord
	for sid := range 2 {
		rec := goneRecord(t, 7+sid, t.TempDir(), "claude")
		rec.Agent, rec.Conversation = "claude", convA
		recs = append(recs, rec)
	}
	srv := startRecords(t, recs...)
	stubAgents(t)
	a := dialClient(t, srv)
	setReopening := func(on bool) {
		srv.table.mu.Lock()
		srv.table.entries[7].reopening = on
		srv.table.mu.Unlock()
	}

	setReopening(true)
	wantErr(t, "reopen of the other record", answer(a, func() error { return a.c.Reopen(8, 80, 24) }), protocol.CodeConversationLive, 8)
	wantErr(t, "dismiss", answer(a, func() error { return a.c.Dismiss(7) }), protocol.CodeBadRequest, 7)
	wantErr(t, "second reopen", answer(a, func() error { return a.c.Reopen(7, 80, 24) }), protocol.CodeBadRequest, 7)
	setReopening(false)

	sid := a.reopen(8, 80, 24)
	a.waitLive(sid, "stub:claude:--resume "+convA)
	wantErr(t, "reopen while the other runs", answer(a, func() error { return a.c.Reopen(7, 80, 24) }), protocol.CodeConversationLive, 7)
	if i := a.info(7); i == nil || !i.Restorable {
		t.Errorf("record 7 is %+v, want it still restorable", i)
	}
}

// A reopen that begins while a dismiss is scanning wins: the dismiss checks
// again before it deletes.
func TestDismissDuringReopen(t *testing.T) {
	srv := startRecords(t, goneRecord(t, 7, t.TempDir(), "old"))
	a := dialClient(t, srv)
	scans := 0
	// Swapped and restored under table.mu, which the dismiss takes before
	// and after its scan, so the race detector sees them ordered.
	srv.table.mu.Lock()
	orig := rescanPIDs
	rescanPIDs = func(int) ([]int, time.Time, error) {
		srv.table.mu.Lock()
		srv.table.entries[7].reopening = true
		scans++
		srv.table.mu.Unlock()
		return nil, time.Time{}, nil
	}
	srv.table.mu.Unlock()
	t.Cleanup(func() {
		srv.table.mu.Lock()
		rescanPIDs = orig
		srv.table.mu.Unlock()
	})

	wantErr(t, "dismiss", answer(a, func() error { return a.c.Dismiss(7) }), protocol.CodeBadRequest, 7)
	srv.table.mu.Lock()
	n := scans
	srv.table.mu.Unlock()
	if n != 1 {
		t.Errorf("dismiss scanned %d times, want once", n)
	}
	if a.info(7) == nil {
		t.Error("the record is no longer listed")
	}
	if r := savedRecord(t, srv, 7); r == nil {
		t.Error("state.json lost the record")
	}
}

// Loaded records are listed with the directory their shell started in: the
// user's home for an empty cwd, the real path for one with "..".
func TestLoadedRecordsListEffectiveCwd(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "a", "b"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "a", "b"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	srv := startRecords(t, goneRecord(t, 1, "", "claude"), goneRecord(t, 2, root+"/link/..", "claude"))
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	a := dialClient(t, srv)
	a.waitFor("both records", func() bool { return a.info(1) != nil && a.info(2) != nil })
	if i := a.info(1); i.Cwd != home {
		t.Errorf("empty cwd listed as %q, want %q", i.Cwd, home)
	}
	if i := a.info(2); i.Cwd != filepath.Join(root, "a") {
		t.Errorf("cwd listed as %q, want %q", i.Cwd, filepath.Join(root, "a"))
	}
}
