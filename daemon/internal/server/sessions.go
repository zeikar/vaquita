package server

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"maps"
	"math"
	"slices"
	"sync"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/session"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

// Lock order: table.mu, then a session's lock, then conn.mu.
//
// Building a sessions list reads each session's state under the table lock,
// and so does draining a session's status, so nothing that holds a session
// lock may take table.mu: anything that needs both takes table.mu first; the
// exit handler, the status timer and the conversation id read are the
// session-side callers. The PTY reader must not wait for table.mu, which is
// held across state.json's fsync, so its OnOutput leaves the drain to the
// session's status timer. conn.mu is innermost: conn.send and a connection's
// subscription list are used with either of the others held, and nothing is
// locked under it.

// table holds the sessions and the connections that receive their list.
type table struct {
	home string
	// userHome is the user's home directory, where the agents keep the files
	// their conversation ids are read from; empty turns the reads off. Set
	// before the server serves.
	userHome string

	mu sync.Mutex
	// st is what state.json holds; its Sessions are rebuilt from entries on
	// every save.
	st      state.State
	entries map[uint32]*entry
	// lastSID is the highest sid handed out or loaded, so that no sid is
	// used twice in a daemon's lifetime or collides with a kept record.
	lastSID uint32
	// clients are the connections past the hello. Each gets every sessions
	// broadcast, which is sent under mu so that the lists arrive in the
	// order of the changes they show.
	clients map[*conn]struct{}
	// missed counts the notifications raised while no GUI client was
	// connected, for the next GUI to join.
	missed int
	// readID reads the conversation id a snapshot describes. Tests replace
	// it to stand in for the agents' files.
	readID func(convSnapshot) string
	// starting counts the sessions between beginStart and their listing or
	// failure; an idle shutdown counts them as running.
	starting int
	// stopping is set once a shutdown request is agreed to: no session
	// starts after it.
	stopping bool
}

// entry is one session in the table. A record kept from a previous daemon run
// has no session: it is listed as exited. It is restorable, or holds orphans
// until a kill's rescan finds them gone; either way it can be dismissed.
type entry struct {
	sid  uint32
	inc  string // tells this session apart from another shown in the same place
	pid  int
	sess *session.Session
	// listed is closed once the entry is complete and in the table, before
	// any other connection can find it there. The session's callbacks can
	// run before Start has returned it.
	listed chan struct{}
	// statusTimer drains the session's status when output() asks for it
	// with Reset(0) and at the projector's deadlines. Created stopped before
	// the session starts and never replaced; Reset and Stop are called under
	// the session lock.
	statusTimer *time.Timer

	// Guarded by table.mu.
	rec state.SessionRecord
	// reopening is set while a reopen of this record is starting its
	// session; it refuses a second reopen and a dismiss.
	reopening bool

	// Guarded by the session lock.
	subs   []*subscriber
	exited bool
	code   int
	// finalOff is the ring end when the exit was reported. A subscriber is
	// sent output this far before it is sent the exit.
	finalOff uint64
	// removeOnExit is set by a kill of the running session: the record goes
	// once the exit leaves nothing behind.
	removeOnExit bool
	// drainDue is set while a drain output() asked for has yet to run;
	// output read meanwhile goes out with it.
	drainDue bool
	// idBusy is set while a read of the agent's conversation id is in
	// flight, and idDue when a drain asked for another meanwhile.
	idBusy, idDue bool
}

func newTable(home string, st state.State) *table {
	t := &table{home: home, st: st, entries: make(map[uint32]*entry), clients: make(map[*conn]struct{}), readID: convSnapshot.readFiles}
	for _, r := range st.Sessions {
		if r.SID < 1 || r.SID > math.MaxUint32 || t.entries[uint32(r.SID)] != nil {
			slog.Warn("dropping session record with an invalid or duplicate sid", "sid", r.SID, "pid", r.PID, "orphans", r.Orphans)
			continue
		}
		sid := uint32(r.SID)
		t.entries[sid] = &entry{sid: sid, inc: newInc(), pid: r.PID, rec: r}
		t.lastSID = max(t.lastSID, sid)
	}
	return t
}

// normalizeCwds gives the loaded records the directory their session started
// in, so that the list groups them like new ones: the user's home for an empty
// cwd, else session.RealDir. They are saved with the next change, not for this.
func (t *table) normalizeCwds() {
	for _, e := range t.entries {
		if e.rec.Cwd == "" {
			e.rec.Cwd = t.userHome
		} else {
			e.rec.Cwd = session.RealDir(e.rec.Cwd)
		}
	}
}

// newInc returns 8 random bytes in hex.
func newInc() string {
	b := make([]byte, 8)
	rand.Read(b) // never fails since Go 1.24
	return hex.EncodeToString(b)
}

// beginStart hands out the sid of a session about to start and counts it as
// starting; false, with no sid, once a shutdown has been agreed to.
func (t *table) beginStart() (uint32, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopping {
		return 0, false
	}
	t.starting++
	t.lastSID++
	return t.lastSID, true
}

func (t *table) lookup(sid uint32) *entry {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.entries[sid]
}

// saveLocked writes state.json from the table. A failure is only logged: the
// sessions themselves are unaffected, and the next change writes it again.
func (t *table) saveLocked() {
	recs := make([]state.SessionRecord, 0, len(t.entries))
	for _, sid := range slices.Sorted(maps.Keys(t.entries)) {
		recs = append(recs, t.entries[sid].rec)
	}
	t.st.Sessions = recs
	if err := t.st.Save(t.home); err != nil {
		slog.Error("save state", "err", err)
	}
}

// listLocked describes every session, by sid. It is never nil, so clients
// can always iterate it.
func (t *table) listLocked() []protocol.SessionInfo {
	list := make([]protocol.SessionInfo, 0, len(t.entries))
	for _, sid := range slices.Sorted(maps.Keys(t.entries)) {
		e := t.entries[sid]
		info := protocol.SessionInfo{
			SID: sid, Inc: e.inc, Cwd: e.rec.Cwd, Cmd: e.rec.Cmd, Name: e.rec.Name, Title: e.rec.Title, Agent: e.rec.Agent,
			State: protocol.StateExited, PID: e.pid, Orphans: e.rec.Orphans,
			// Unknown for a record from a previous run, as for a shell
			// whose wait failed.
			Code:       -1,
			Restorable: e.sess == nil && len(e.rec.Orphans) == 0,
		}
		if s := e.sess; s != nil {
			s.Lock()
			info.Cols, info.Rows = s.Size()
			info.Code = e.code
			// An exited session shows no status.
			if !e.exited {
				info.State = protocol.StateRunning
				v, unread := s.Output().View()
				info.Status, info.Unread = statusInfo(v), unread
			}
			s.Unlock()
		}
		list = append(list, info)
	}
	return list
}

func (t *table) broadcastLocked() {
	m := protocol.Sessions{T: protocol.TSessions, List: t.listLocked()}
	for c := range t.clients {
		c.send(m)
	}
}

func (t *table) broadcast() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.broadcastLocked()
}

// join answers c's hello with the current list and adds c to the broadcasts,
// in one step so that no change falls between the list and the first
// broadcast. A GUI is then told how many notifications it missed, if any
// were raised while no GUI was connected.
func (t *table) join(c *conn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	c.send(protocol.Hello{T: protocol.THello, V: protocol.Version, Build: c.srv.opts.Build})
	c.send(protocol.Sessions{T: protocol.TSessions, List: t.listLocked()})
	if c.client == protocol.ClientGUI {
		t.sendReposLocked(c)
	}
	t.sendMissedLocked(c)
	t.clients[c] = struct{}{}
}

// leave ends c's broadcasts and subscriptions. Its sessions keep running: a
// GUI that restarts must find them.
func (t *table) leave(c *conn) {
	t.mu.Lock()
	delete(t.clients, c)
	t.mu.Unlock()
	for _, sub := range c.subscriptions() {
		s := sub.e.sess
		s.Lock()
		sub.e.detach(sub)
		s.Unlock()
	}
}

func noSession(sid uint32) protocol.Error {
	return protocol.Error{T: protocol.TError, Code: protocol.CodeNoSession, SID: sid}
}

func badRequest(sid uint32) protocol.Error {
	return protocol.Error{T: protocol.TError, Code: protocol.CodeBadRequest, SID: sid}
}
