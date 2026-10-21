package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
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

// PruneDead re-scans each record's PTY session with scan, whose argument is
// the record's PID and which reports the members' pids and, if the process
// with that pid still leads the session, when it started. A record is dropped
// when its session is empty, or when its leader started at another time than
// the record says: the pid has been reused for someone else's session. Any
// other record is kept with Orphans set to what the scan found, except that a
// record whose scan failed is kept unchanged and its error joined into the
// one returned. PruneDead sets st.Sessions to the kept records and returns
// them for the caller to log.
func (st *State) PruneDead(scan func(sid int) (pids []int, leaderStart time.Time, err error)) ([]SessionRecord, error) {
	var kept []SessionRecord
	var errs []error
	for _, r := range st.Sessions {
		pids, leaderStart, err := scan(r.PID)
		if err != nil {
			errs = append(errs, fmt.Errorf("scan session %d (pid %d): %w", r.SID, r.PID, err))
			kept = append(kept, r)
			continue
		}
		if len(pids) == 0 {
			continue
		}
		if d := leaderStart.Sub(r.Started); !leaderStart.IsZero() && (d > startSlack || d < -startSlack) {
			continue
		}
		r.Orphans = pids
		kept = append(kept, r)
	}
	st.Sessions = kept
	return kept, errors.Join(errs...)
}
