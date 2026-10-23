package convid

import (
	"bufio"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const (
	// codexSlack lets a conversation that started just before the session's
	// recorded start still count, as the two clocks are read apart.
	codexSlack = 2 * time.Second
	// codexFirstLine bounds the first line read of a rollout file; the
	// session_meta payload can be large.
	codexFirstLine = 64 << 10
	rolloutTime    = "2006-01-02T15-04-05"
	// codexMaxDays is how many days back from Now the walk goes at most.
	codexMaxDays = 30
)

// MaxRolloutFiles bounds how many rollout files one ReadCodex reads. A
// variable so that tests can lower it.
var MaxRolloutFiles = 200

// CodexQuery describes the session whose codex conversation is wanted.
type CodexQuery struct {
	Cwd   string
	Since time.Time // when the session started
	// Now bounds the search. Date directories and file-name times are read in
	// its location, so callers pass a local time (time.Now()).
	Now time.Time
	// Claimed holds ids that another live session already has.
	Claimed map[string]bool
}

// ReadCodex infers the id of the codex conversation started in q.Cwd since
// q.Since: the newest one not claimed by another session. "" if none.
func ReadCodex(home string, q CodexQuery) string {
	root := filepath.Join(home, ".codex", "sessions")
	cutoff := q.Since.Add(-codexSlack)
	var bestID string
	var bestTime time.Time
	var bestName string
	read := 0
	cwd := resolve(q.Cwd)
	today := dateOf(q.Now)
	// The newest conversation wins, so days further back add only I/O.
	first := dateOf(q.Since.In(q.Now.Location())).AddDate(0, 0, -1)
	if floor := today.AddDate(0, 0, -codexMaxDays); first.Before(floor) {
		first = floor
	}
	for day := today; !day.Before(first); day = day.AddDate(0, 0, -1) {
		dir := filepath.Join(root, day.Format("2006"), day.Format("01"), day.Format("02"))
		entries, err := os.ReadDir(dir)
		if err != nil {
			if !os.IsNotExist(err) {
				slog.Debug("convid: list codex sessions", "dir", dir, "err", err)
			}
			continue
		}
		var names []string
		for _, e := range entries {
			if n := e.Name(); strings.HasPrefix(n, "rollout-") && strings.HasSuffix(n, ".jsonl") {
				names = append(names, n)
			}
		}
		// ReadDir sorts ascending and the names start with the time.
		slices.Reverse(names)
		for _, name := range names {
			if t, ok := rolloutNameTime(name, q.Now.Location()); !ok || t.Before(cutoff) {
				continue
			}
			if read >= MaxRolloutFiles {
				return bestID
			}
			read++
			id, ts, ok := readMeta(filepath.Join(dir, name), q, cwd, cutoff)
			if !ok {
				continue
			}
			if bestID == "" || ts.After(bestTime) || ts.Equal(bestTime) && name > bestName {
				bestID, bestTime, bestName = id, ts, name
			}
		}
	}
	return bestID
}

func dateOf(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, t.Location())
}

// rolloutNameTime parses the local time in rollout-<time>-<id>.jsonl.
func rolloutNameTime(name string, loc *time.Location) (time.Time, bool) {
	rest, ok := strings.CutPrefix(name, "rollout-")
	if !ok || len(rest) < len(rolloutTime) {
		return time.Time{}, false
	}
	t, err := time.ParseInLocation(rolloutTime, rest[:len(rolloutTime)], loc)
	return t, err == nil
}

// readMeta reads the first line of a rollout file and returns its id and
// timestamp when it is a session_meta line that fits q.
func readMeta(path string, q CodexQuery, cwd string, cutoff time.Time) (string, time.Time, bool) {
	f, err := os.Open(path)
	if err != nil {
		slog.Debug("convid: open codex rollout", "path", path, "err", err)
		return "", time.Time{}, false
	}
	defer f.Close()
	// The limit's extra byte tells a line of exactly the limit from a longer one.
	line, err := bufio.NewReaderSize(io.LimitReader(f, codexFirstLine+1), 4096).ReadBytes('\n')
	if err != nil && err != io.EOF {
		slog.Debug("convid: read codex rollout", "path", path, "err", err)
		return "", time.Time{}, false
	}
	if len(line) > codexFirstLine {
		slog.Debug("convid: codex rollout first line too long", "path", path)
		return "", time.Time{}, false
	}
	var m struct {
		Type    string `json:"type"`
		Payload struct {
			ID        string `json:"id"`
			Cwd       string `json:"cwd"`
			Timestamp string `json:"timestamp"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(line, &m); err != nil || m.Type != "session_meta" {
		return "", time.Time{}, false
	}
	ts, err := time.Parse(time.RFC3339, m.Payload.Timestamp)
	if err != nil || ts.Before(cutoff) || !ValidID(m.Payload.ID) || q.Claimed[m.Payload.ID] || resolve(m.Payload.Cwd) != cwd {
		return "", time.Time{}, false
	}
	return m.Payload.ID, ts, true
}
