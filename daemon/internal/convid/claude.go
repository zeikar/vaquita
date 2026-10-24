package convid

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// claudeStartSlack is how far a pid file's startedAt may come before the start
// time of the process with that pid before the file is taken for a leftover of
// an earlier process that had the pid. Later is fine at any distance: claude
// writes the file only once its folder is trusted, which can take a while.
const claudeStartSlack = 15 * time.Second

// ReadClaude returns the conversation id of the claude among members, "" if
// none is found. foreground is the PTY's foreground process group. A file of
// a claude killed by SIGKILL stays behind, which the pid and start time checks
// are for. The pid identifies the file, so the session's cwd is not compared.
func ReadClaude(home string, members []Member, foreground int) string {
	dir := filepath.Join(home, ".claude", "sessions")
	var best struct {
		have    bool
		id      string
		fg      bool
		started int64
	}
	for _, m := range members {
		data, err := os.ReadFile(filepath.Join(dir, strconv.Itoa(m.PID)+".json"))
		if err != nil {
			if !os.IsNotExist(err) {
				slog.Debug("convid: read claude pid file", "pid", m.PID, "err", err)
			}
			continue
		}
		var f struct {
			SessionID string `json:"sessionId"`
			StartedAt int64  `json:"startedAt"`
		}
		if err := json.Unmarshal(data, &f); err != nil {
			slog.Debug("convid: decode claude pid file", "pid", m.PID, "err", err)
			continue
		}
		// A file without startedAt has nothing to compare, so it skips the
		// check for a reused pid.
		if f.StartedAt != 0 && m.Start.Sub(time.UnixMilli(f.StartedAt)) > claudeStartSlack {
			continue
		}
		fg := m.PGID == foreground
		// Inside the foreground group the earliest claude is the session's
		// agent: one it launched inherits the group and starts later.
		// Elsewhere the newest wins.
		if best.have && (best.fg && !fg ||
			best.fg == fg && (fg && best.started <= f.StartedAt || !fg && best.started >= f.StartedAt)) {
			continue
		}
		best.have, best.id, best.fg, best.started = true, f.SessionID, fg, f.StartedAt
	}
	// Only the preferred file counts: another claude in the session, one the
	// agent launched, is not the session's agent.
	if !ValidID(best.id) {
		return ""
	}
	return best.id
}
