package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"time"
)

// startSlack allows for the gap between when the kernel started a shell and
// the Started the daemon recorded for it right after.
const startSlack = 2 * time.Second

func defaultState() State { return State{Shell: "/bin/zsh"} }

// State is what state.json keeps across daemon restarts.
type State struct {
	// Shell is the absolute path of the shell sessions run; launchd provides
	// no $SHELL to fall back on.
	Shell    string          `json:"shell"`
	Sessions []SessionRecord `json:"sessions"`
	// Repos are the registered repos: cleaned absolute paths, sorted and
	// unique. Nil in files written before repos existed.
	Repos []string `json:"repos"`
}

// SessionRecord describes a session the daemon started.
type SessionRecord struct {
	SID     int       `json:"sid"`
	PID     int       `json:"pid"` // the shell's pid, also its PTY session's id
	Started time.Time `json:"started"`
	Cwd     string    `json:"cwd"`
	Cmd     string    `json:"cmd,omitempty"`
	Name    string    `json:"name,omitempty"`
	// Orphans are processes found still in the PTY session after the shell
	// exited. They are reported, never signalled: the pids may since have
	// been reused.
	Orphans []int `json:"orphans,omitempty"`
	// Agent is the agent last seen reporting in the session, claude or
	// codex, and Conversation that agent's conversation id as last read
	// while it was alive; a reopen resumes it.
	Agent        string `json:"agent,omitempty"`
	Conversation string `json:"conversation,omitempty"`
}

// Load reads state.json from home. A missing file yields the defaults, as do
// fields the file leaves out; on any error the defaults come with it.
func Load(home string) (State, error) {
	st := defaultState()
	data, err := os.ReadFile(StatePath(home))
	if errors.Is(err, os.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(data, &st); err != nil {
		return defaultState(), fmt.Errorf("parse %s: %w", StatePath(home), err)
	}
	// A hand-edited file may break the order adding and removing a repo
	// rely on.
	slices.Sort(st.Repos)
	st.Repos = slices.Compact(st.Repos)
	return st, nil
}

// Save replaces state.json in home atomically.
func (st State) Save(home string) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return WriteAtomic(StatePath(home), data, 0o600)
}

// Rescan re-scans the record's PTY session with scan, whose argument is the
// record's PID and which reports the members' pids and, if the process with
// that pid still leads the session, when it started. Orphans becomes what the
// scan found, or nil when the session is empty or its leader started at
// another time than the record says (the pid has been reused for someone
// else's session). When the scan fails the record is left as it was and the
// error returned.
func (r *SessionRecord) Rescan(scan func(sid int) (pids []int, leaderStart time.Time, err error)) error {
	pids, leaderStart, err := scan(r.PID)
	if err != nil {
		return err
	}
	if d := leaderStart.Sub(r.Started); len(pids) == 0 || (!leaderStart.IsZero() && (d > startSlack || d < -startSlack)) {
		pids = nil
	}
	r.Orphans = pids
	return nil
}

// Rescan calls SessionRecord.Rescan for every record. No record is dropped: a
// record whose session holds no processes is restorable, so it stays until
// the user reopens or dismisses it. It returns the records that still hold
// processes for the caller to log (one whose scan failed counts by what it
// already holds), and the scan errors joined.
func (st *State) Rescan(scan func(sid int) (pids []int, leaderStart time.Time, err error)) ([]SessionRecord, error) {
	var holding []SessionRecord
	var errs []error
	for i := range st.Sessions {
		r := &st.Sessions[i]
		if err := r.Rescan(scan); err != nil {
			errs = append(errs, fmt.Errorf("scan session %d (pid %d): %w", r.SID, r.PID, err))
		}
		if len(r.Orphans) > 0 {
			holding = append(holding, *r)
		}
	}
	return holding, errors.Join(errs...)
}
