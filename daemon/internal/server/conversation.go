package server

import (
	"log/slog"
	"strconv"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/convid"
	"github.com/zeikar/vaquita/daemon/internal/session"
)

// agentOf is the agent kind a record keeps for the app an agent names in its
// reports, "" for an app whose conversation id cannot be read.
func agentOf(app string) string {
	switch app {
	case "claude-code":
		return "claude"
	case "codex":
		return "codex"
	}
	return ""
}

// askConversationLocked asks for a read of e's conversation id: it starts
// one, or has the one in flight run once more. It requires the session lock.
func (t *table) askConversationLocked(e *entry) {
	if t.userHome == "" {
		return
	}
	if e.idBusy {
		e.idDue = true
		return
	}
	e.idBusy = true
	session.Go("sid "+strconv.Itoa(int(e.sid))+" conversation", func() { t.readConversation(e) })
}

// convSnapshot is what a read of a session's conversation id needs, taken
// under the locks so that the files are read without them.
type convSnapshot struct {
	sid   uint32
	agent string // claude or codex
	pid   int    // the shell's pid, which is its PTY session's id
	fg    int    // the PTY's foreground process group, 0 if unknown
	home  string // the user's home directory
	codex convid.CodexQuery
	// readID is the table's, taken under t.mu with the rest.
	readID func(convSnapshot) string
}

// readConversation reads the conversation id of the agent in e's session and
// records it, with the agent's kind, in e's record.
//
// A read is asked for by a status drain that took a view change, a
// notification or a change of the reporting app, in a session whose agent has
// named its app: a working from codex after one from claude leaves the view
// as it was, so a change of app alone is enough to ask for both. The
// read runs on a goroutine of its own and touches files with no lock held.
// At most one is in flight per entry: a drain that asks while one is in
// flight has it run once more when it ends. Nothing reads on exit, when
// claude's file is already gone and codex's last conversation was read at its
// last done, and no timer or watcher asks either: a /clear or /new shows up
// at the session's next report.
//
// The pair in the record changes by these rules: another agent kind replaces
// both, with the id found for it or none, as an id never outlives the agent
// it belongs to; the same kind replaces the id only with one that was found,
// as claude's file is gone after a normal exit and codex's may not exist yet.
func (t *table) readConversation(e *entry) {
	for {
		snap, ok := t.conversationSnapshot(e)
		if !ok {
			return
		}
		t.recordConversation(e, snap.agent, snap.readID(snap))
		s := e.sess
		s.Lock()
		again := e.idDue
		e.idBusy, e.idDue = again, false
		s.Unlock()
		if !again {
			return
		}
	}
}

// conversationSnapshot takes what a read of e's conversation id needs. It
// reports false, ending the reads, once e has exited or left the table, or
// when the app last reported is no agent whose id can be read.
func (t *table) conversationSnapshot(e *entry) (convSnapshot, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := e.sess
	s.Lock()
	snap := convSnapshot{sid: e.sid, pid: e.pid, home: t.userHome, readID: t.readID}
	if !e.exited && t.entries[e.sid] == e {
		snap.agent = agentOf(s.Output().App())
	}
	if snap.agent == "" {
		e.idBusy, e.idDue = false, false
		s.Unlock()
		return snap, false
	}
	// Only a preference among claude's files; without it the newest wins.
	if fg, err := s.Output().Foreground(); err == nil {
		snap.fg = fg
	}
	s.Unlock()

	if snap.agent != "codex" {
		return snap, true
	}
	cwd := e.rec.Cwd
	if cwd == "" {
		cwd = t.userHome
	}
	snap.codex = convid.CodexQuery{Cwd: cwd, Since: e.rec.Started, Claimed: t.claimedLocked(e)}
	return snap, true
}

// claimedLocked returns the conversation ids of the running sessions other
// than e: each is that session's conversation. It requires t.mu, and takes
// one session lock at a time, which keeps the lock order.
func (t *table) claimedLocked(e *entry) map[string]bool {
	claimed := make(map[string]bool)
	for _, o := range t.entries {
		if o == e || o.sess == nil || o.rec.Conversation == "" {
			continue
		}
		o.sess.Lock()
		running := !o.exited
		o.sess.Unlock()
		if running {
			claimed[o.rec.Conversation] = true
		}
	}
	return claimed
}

// readFiles finds the conversation id in the agent's files, so it runs with
// no lock held.
func (snap convSnapshot) readFiles() string {
	if snap.agent == "codex" {
		q := snap.codex
		q.Now = time.Now()
		return convid.ReadCodex(snap.home, q)
	}
	members, err := session.Members(snap.pid)
	if err != nil {
		slog.Debug("conversation: scan the session's members", "sid", snap.sid, "pid", snap.pid, "err", err)
		return ""
	}
	return convid.ReadClaude(snap.home, members, snap.fg)
}

// recordConversation applies what a read found for agent to e's record, by
// the rules on readConversation, and saves state.json when that changed it.
func (t *table) recordConversation(e *entry, agent, id string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.entries[e.sid] != e {
		return
	}
	// Two codex sessions in one cwd can both read before either records.
	if agent == "codex" && t.claimedLocked(e)[id] {
		id = ""
	}
	r := &e.rec
	switch {
	case r.Agent != agent:
		r.Agent, r.Conversation = agent, id
	case id != "" && id != r.Conversation:
		r.Conversation = id
	default:
		return
	}
	slog.Info("conversation recorded", "sid", e.sid, "agent", agent, "id", id)
	t.saveLocked()
}
