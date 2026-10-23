// Package convid finds the conversation id of the claude or codex running in
// a PTY session, so that a session can be reopened into the same conversation.
//
// Claude Code writes ~/.claude/sessions/<pid>.json for each running process,
// with the current conversation id as "sessionId". Codex has no such file; its
// conversation file ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
// starts with a session_meta line carrying the id, cwd and start time, so the
// id is inferred from the files written since the session started.
//
// Both are the agents' own undocumented internals and may change with any
// release. The readers therefore never return errors: whatever goes wrong, a
// missing file, a changed format or a bad id, the answer is "no id" and the
// caller falls back to continuing the latest conversation.
package convid

import (
	"path/filepath"
	"time"
)

// Member is what the readers know of a process in a PTY session.
type Member struct {
	PID, PGID int
	Start     time.Time
}

// ValidID reports whether id is UUID-shaped (8-4-4-4-12 hex digits). Ids end
// up on a shell command line, so nothing else is accepted.
func ValidID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F') {
				return false
			}
		}
	}
	return true
}

// resolve gives the path two names of the same place share: p with its
// symlinks resolved, or only cleaned when that fails.
func resolve(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}
