package server

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

// agentJob is a job of its own, so that it holds the terminal as an agent
// does, that runs each step in turn: it prints the step, then mark-<n> for the
// nth, then reads a line from the terminal before it goes on. A step is shell
// code for inside single quotes. The marks are computed, so that the command
// itself never matches one.
func agentJob(steps ...string) string { return agentJobFrom(1, steps...) }

// agentJobFrom is agentJob with marks numbered from first, for a job that
// follows another in the same session.
func agentJobFrom(first int, steps ...string) string {
	var b strings.Builder
	b.WriteString(`set -m; sh -c '`)
	for i, s := range steps {
		b.WriteString(s + `; echo mark-$((` + strconv.Itoa(first+i-1) + `+1)); read l; `)
	}
	b.WriteString(`'`)
	return b.String()
}

// jobReport and jobTitle are steps of an agentJob that print a root report of
// state, from app if it is not empty, and a window title by OSC n.
func jobReport(state, app string) string {
	if app != "" {
		state += ":app=" + app
	}
	return `printf "\033]7501;state=` + state + `\007"`
}

func jobTitle(n, title string) string {
	return `printf "\033]` + n + `;` + title + `\007"`
}

// step waits for the nth step of sid's agentJob to finish, typing the line
// that lets it start first when n is past the first, and then drains sid's
// status, as the seen request does, so that whatever the step changed is
// listed and saved when it returns.
func (tc *tclient) step(sid uint32, n int) {
	tc.t.Helper()
	if n > 1 {
		tc.typeLine(sid, "")
	}
	tc.stepDone(sid, n)
}

// stepDone is step without the typing.
func (tc *tclient) stepDone(sid uint32, n int) {
	tc.t.Helper()
	tc.waitLive(sid, "mark-"+strconv.Itoa(n))
	if err := tc.c.Seen(sid); err != nil {
		tc.t.Fatal(err)
	}
	tc.sync()
}

// checkTitle fails unless sid is listed, and saved, with title.
func checkTitle(t *testing.T, srv *Server, tc *tclient, sid uint32, title string) {
	t.Helper()
	if i := tc.info(sid); i == nil || i.Title != title {
		t.Errorf("listed %+v, want title %q", i, title)
	}
	if r := savedRecord(t, srv, sid); r == nil || r.Title != title {
		t.Errorf("state.json holds %+v, want title %q", r, title)
	}
}

// The topic Claude Code sets as its window title titles the session, glyphs
// dropped; its generic title before it has a topic does not. A topic stays
// after Claude Code has exited, when the shell sets titles of its own.
func TestClaudeTopicTitlesTheSession(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create(agentJob(
		jobReport("idle", "claude-code")+"; "+jobTitle("0", "Claude Code"),
		jobTitle("0", "✳ Pong reply"),
		jobTitle("2", "Next topic"),
		jobReport("clear", "")+"; "+jobTitle("0", "user@host: ~/src/example"),
	))
	a.step(sid, 1)
	checkTitle(t, srv, a, sid, "")
	a.step(sid, 2)
	checkTitle(t, srv, a, sid, "Pong reply")
	a.step(sid, 3)
	checkTitle(t, srv, a, sid, "Next topic")
	a.step(sid, 4)
	checkTitle(t, srv, a, sid, "Next topic")
	for _, list := range a.lists {
		for _, i := range list {
			if i.SID == sid && i.Title == "Claude Code" {
				t.Errorf("listed %+v: the generic title is no topic", i)
			}
		}
	}
}

// A Claude Code topic that happens to be the name of the session's folder is
// a topic all the same.
func TestClaudeTopicNamedLikeTheFolder(t *testing.T) {
	srv := startSessionServer(t, Options{})
	cwd := filepath.Join(t.TempDir(), "my-folder")
	if err := os.Mkdir(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	a := dialClient(t, srv)
	sid := a.createIn(cwd, agentJob(jobReport("idle", "claude-code")+"; "+jobTitle("0", "my-folder")))
	a.step(sid, 1)
	checkTitle(t, srv, a, sid, "my-folder")
}

// stubCodexJob defines codex in $HOME/.profile as an agentJob of steps, so
// that a session created with the command codex runs it with the options
// AgentCommand adds. Call it after startSessionServer, which points HOME at a
// temporary directory.
func stubCodexJob(t *testing.T, steps ...string) {
	t.Helper()
	stub := "codex() { " + agentJob(steps...) + "; }\n"
	if err := os.WriteFile(filepath.Join(os.Getenv("HOME"), ".profile"), []byte(stub), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Codex's thread name, which the session's options make its title, titles
// the session. Once that codex has exited, a codex typed into the shell after
// it runs without them and shows its folder, here one it was started in after
// a cd, behind spinner frames: that changes no title and saves nothing.
func TestCodexThreadNameTitlesTheSession(t *testing.T) {
	srv := startSessionServer(t, Options{})
	stubCodexJob(t, jobReport("working", "codex"), jobTitle("0", "Reply pong"), jobReport("clear", ""))
	other := filepath.Join(t.TempDir(), "other")
	if err := os.Mkdir(other, 0o755); err != nil {
		t.Fatal(err)
	}
	a := dialClient(t, srv)
	sid := a.create("codex")
	a.step(sid, 1)
	checkTitle(t, srv, a, sid, "")
	a.step(sid, 2)
	checkTitle(t, srv, a, sid, "Reply pong")
	a.step(sid, 3)
	checkTitle(t, srv, a, sid, "Reply pong")

	// The line ends the stub, and the shell that replaces it reads the next.
	a.typeLine(sid, "")
	frames := `for f in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do ` + jobTitle("0", "$f other") + `; done; ` + jobTitle("0", "other")
	a.typeLine(sid, "cd '"+other+"' && "+agentJobFrom(4, jobReport("working", "codex"), frames))
	a.stepDone(sid, 4)
	waitConversationRead(t, srv, sid)
	path := state.StatePath(srv.opts.Home)
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	a.step(sid, 5)
	checkTitle(t, srv, a, sid, "Reply pong")
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	now, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) || !bytes.Equal(now, saved) {
		t.Errorf("state.json was saved again after the second codex's folder titles: %s", now)
	}
}

// A codex typed into a plain shell session runs without the session's
// options, so its title is the name of its folder, here one it was started
// in after a cd, behind spinner frames: it titles nothing and saves nothing.
func TestCodexInPlainShellGetsNoTitle(t *testing.T) {
	srv := startSessionServer(t, Options{})
	other := filepath.Join(t.TempDir(), "other")
	if err := os.Mkdir(other, 0o755); err != nil {
		t.Fatal(err)
	}
	a := dialClient(t, srv)
	sid := a.create("")
	frames := `for f in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do ` + jobTitle("0", "$f other") + `; done; ` + jobTitle("0", "other")
	a.typeLine(sid, "cd '"+other+"' && "+agentJob(jobReport("working", "codex"), frames))
	a.step(sid, 1)
	waitRecord(t, srv, sid, "codex as the agent", func(r state.SessionRecord) bool { return r.Agent == "codex" })
	waitConversationRead(t, srv, sid)
	path := state.StatePath(srv.opts.Home)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	a.step(sid, 2)
	checkTitle(t, srv, a, sid, "")
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	now, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) || !bytes.Equal(now, saved) {
		t.Errorf("state.json was saved again after codex's folder titles: %s", now)
	}
}

// A title belongs to the agent that set it: another agent reporting in its
// place clears it, and claude's generic title, which keeps a title of its own,
// does not keep codex's.
func TestAgentChangeClearsTitle(t *testing.T) {
	srv := startSessionServer(t, Options{})
	// Run as codex, whose titles count only with the session's options.
	stubCodexJob(t,
		jobReport("working", "codex")+"; "+jobTitle("0", "Reply pong"),
		// One printf, so that both reach one drain.
		`printf "\033]7501;state=idle:app=claude-code\007\033]0;Claude Code\007"`,
		jobTitle("0", "Pong reply"),
		jobReport("working", "codex"),
	)
	a := dialClient(t, srv)
	sid := a.create("codex")
	a.step(sid, 1)
	checkTitle(t, srv, a, sid, "Reply pong")
	a.step(sid, 2)
	checkTitle(t, srv, a, sid, "")
	a.step(sid, 3)
	checkTitle(t, srv, a, sid, "Pong reply")
	a.step(sid, 4)
	checkTitle(t, srv, a, sid, "")
}

// The title a shell sets once it has the terminal back from a claude killed
// by SIGKILL, which sends no clear, is not taken for a topic, although no poll
// has found claude gone yet.
func TestShellTitleAfterClaudeKilled(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create(`set -m; sh -c '` + jobReport("idle", "claude-code") + "; " + jobTitle("0", "Pong reply") +
		`; echo mark-$((0+1)); read l; kill -9 $$'; printf '\033]0;user@host: ~/src/example\007'; echo mark-$((1+1))`)
	a.step(sid, 1)
	checkTitle(t, srv, a, sid, "Pong reply")
	a.step(sid, 2)
	checkTitle(t, srv, a, sid, "Pong reply")
}

// A notification raised in the drain that changed the title goes out after
// the list that shows the new title, which the app names the session by.
func TestNotificationAfterNewTitle(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	// One printf, so that the title and the report reach one drain.
	sid := a.create(agentJob(
		jobReport("idle", "claude-code"),
		`printf "\033]0;Pong reply\007\033]7501;`+payload("blocked", "permission", "Run make?")+`:app=claude-code\007"`,
	))
	a.step(sid, 1)
	a.typeLine(sid, "")
	a.waitNotify(func(n protocol.Notify) bool { return n.SID == sid && n.Kind == protocol.NotifyInput })
	if i := a.info(sid); i == nil || i.Title != "Pong reply" {
		t.Errorf("listed %+v when the notification came, want the new title", i)
	}
}

// A record from an earlier run lists its title, and its reopened session
// keeps it.
func TestReopenKeepsTitle(t *testing.T) {
	rec := goneRecord(t, 7, t.TempDir(), "claude")
	rec.Agent, rec.Conversation, rec.Title = "claude", convA, "Pong reply"
	srv := startRecords(t, rec)
	stubAgents(t)
	a := dialClient(t, srv)
	if i := a.info(7); i == nil || !i.Restorable || i.Title != "Pong reply" {
		t.Errorf("listed %+v, want the record restorable with its title", i)
	}

	sid := a.reopen(7, 80, 24)
	a.waitLive(sid, "stub:claude:--resume "+convA)
	if i := a.waitListed(sid, running); i.Title != "Pong reply" || i.Name != "" {
		t.Errorf("reopened session listed as %+v, want the record's title and no name", i)
	}
	if r := savedRecord(t, srv, sid); r == nil || r.Title != "Pong reply" {
		t.Errorf("state.json holds %+v, want the record's title", r)
	}
}

// A title and a notification that only the exit's drain takes, when the exit
// wins the race against the timer, go out in the same order: the list that
// shows the new title, the session still running, comes first.
func TestNotificationAtExitAfterNewTitle(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.create(`set -m; sh -c '` + jobReport("idle", "claude-code") + `; echo mark-$((0+1)); read l; ` +
		`printf "\\033]0;Pong reply\\007\\033]7501;` + payload("blocked", "permission", "Run make?") + `:app=claude-code\\007"; ` +
		`echo mark-$((1+1)); read l'; exit`)
	a.step(sid, 1)
	// As if a drain were due but its timer had lost the race: output() asks
	// for no other, and no timer fires before the exit.
	e := srv.table.lookup(sid)
	e.sess.Lock()
	e.drainDue = true
	e.statusTimer.Stop()
	e.sess.Unlock()

	a.typeLine(sid, "")
	a.waitLive(sid, "mark-2")
	if i := a.info(sid); i == nil || i.Title != "" {
		t.Fatalf("listed %+v before the exit, want no title yet", i)
	}
	a.typeLine(sid, "")
	a.waitNotify(func(n protocol.Notify) bool { return n.SID == sid && n.Kind == protocol.NotifyInput })
	if i := a.info(sid); i == nil || i.Title != "Pong reply" || i.State != protocol.StateRunning {
		t.Errorf("listed %+v when the notification came, want the new title on the running session", i)
	}
	a.waitExit(sid)
	if i := a.waitListed(sid, exited); i.Title != "Pong reply" {
		t.Errorf("listed %+v after the exit, want the new title", i)
	}
}
