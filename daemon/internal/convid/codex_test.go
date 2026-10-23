package convid

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var codexNow = time.Date(2026, 10, 23, 13, 30, 0, 0, time.Local)

// rollout writes a rollout file named and dated from when, in local time as
// codex does.
func rollout(t *testing.T, home string, when time.Time, id, cwd string) {
	t.Helper()
	line := fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":%q,"cwd":%q,"timestamp":%q,"originator":"codex-tui"}}`+"\n",
		when.UTC().Format(time.RFC3339), id, cwd, when.UTC().Format(time.RFC3339))
	writeRollout(t, home, when, id, line)
}

func writeRollout(t *testing.T, home string, when time.Time, id, content string) {
	t.Helper()
	l := when.Local()
	dir := filepath.Join(home, ".codex", "sessions", l.Format("2006"), l.Format("01"), l.Format("02"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	name := "rollout-" + l.Format("2006-01-02T15-04-05") + "-" + id + ".jsonl"
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadCodex(t *testing.T) {
	since := codexNow.Add(-time.Hour)
	q := func(cwd string) CodexQuery { return CodexQuery{Cwd: cwd, Since: since, Now: codexNow} }
	cwd, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	t.Run("match", func(t *testing.T) {
		home := t.TempDir()
		rollout(t, home, since.Add(time.Minute), idA, cwd)
		if got := ReadCodex(home, q(cwd)); got != idA {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("wrong cwd", func(t *testing.T) {
		home := t.TempDir()
		rollout(t, home, since.Add(time.Minute), idA, "/tmp/elsewhere")
		if got := ReadCodex(home, q(cwd)); got != "" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("before since", func(t *testing.T) {
		home := t.TempDir()
		rollout(t, home, since.Add(-time.Minute), idA, cwd)
		if got := ReadCodex(home, q(cwd)); got != "" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("newest of two", func(t *testing.T) {
		home := t.TempDir()
		rollout(t, home, since.Add(time.Minute), idA, cwd)
		rollout(t, home, since.Add(2*time.Minute), idB, cwd)
		if got := ReadCodex(home, q(cwd)); got != idB {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("newest claimed", func(t *testing.T) {
		home := t.TempDir()
		rollout(t, home, since.Add(time.Minute), idA, cwd)
		rollout(t, home, since.Add(2*time.Minute), idB, cwd)
		query := q(cwd)
		query.Claimed = map[string]bool{idB: true}
		if got := ReadCodex(home, query); got != idA {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("cwd through symlink", func(t *testing.T) {
		home := t.TempDir()
		link := filepath.Join(t.TempDir(), "link")
		if err := os.Symlink(cwd, link); err != nil {
			t.Fatal(err)
		}
		rollout(t, home, since.Add(time.Minute), idA, cwd)
		if got := ReadCodex(home, q(link)); got != idA {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("date bound", func(t *testing.T) {
		home := t.TempDir()
		// Filed two days before Since, with a timestamp that would match.
		old := since.AddDate(0, 0, -2)
		line := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"cwd":%q,"timestamp":%q}}`+"\n",
			idA, cwd, since.Add(time.Minute).UTC().Format(time.RFC3339))
		writeRollout(t, home, old, idA, line)
		if got := ReadCodex(home, q(cwd)); got != "" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("unusable first lines", func(t *testing.T) {
		home := t.TempDir()
		when := since.Add(3 * time.Minute)
		writeRollout(t, home, when, idA, `{"type":"event_msg","payload":{}}`+"\n")
		writeRollout(t, home, when.Add(time.Second), idB, "garbage\n")
		writeRollout(t, home, when.Add(2*time.Second), idC, "")
		if got := ReadCodex(home, q(cwd)); got != "" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("file limit", func(t *testing.T) {
		defer func(n int) { MaxRolloutFiles = n }(MaxRolloutFiles)
		MaxRolloutFiles = 1
		home := t.TempDir()
		rollout(t, home, since.Add(time.Minute), idA, cwd)
		rollout(t, home, since.Add(2*time.Minute), idB, "/tmp/elsewhere")
		if got := ReadCodex(home, q(cwd)); got != "" {
			t.Fatalf("got %q, want only the newest file read", got)
		}
	})

	t.Run("old Since still finds today", func(t *testing.T) {
		home := t.TempDir()
		rollout(t, home, codexNow.Add(-time.Minute), idA, cwd)
		query := q(cwd)
		query.Since = time.Time{}
		if got := ReadCodex(home, query); got != idA {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("timestamp tie goes to the later name", func(t *testing.T) {
		home := t.TempDir()
		when := since.Add(time.Minute)
		rollout(t, home, when, idA, cwd)
		// Same timestamp, a later name.
		l := when.Local().Add(time.Second)
		line := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"cwd":%q,"timestamp":%q}}`+"\n",
			idB, cwd, when.UTC().Format(time.RFC3339))
		writeRollout(t, home, l, idB, line)
		if got := ReadCodex(home, q(cwd)); got != idB {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("first line over the cap", func(t *testing.T) {
		home := t.TempDir()
		pad := strings.Repeat("x", codexFirstLine)
		line := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"cwd":%q,"timestamp":%q,"pad":%q}}`+"\n",
			idA, cwd, since.Add(time.Minute).UTC().Format(time.RFC3339), pad)
		writeRollout(t, home, since.Add(time.Minute), idA, line)
		if got := ReadCodex(home, q(cwd)); got != "" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("midnight crossing", func(t *testing.T) {
		zone := time.FixedZone("test", 9*3600)
		started := time.Date(2026, 10, 23, 23, 59, 0, 0, zone)
		now := time.Date(2026, 10, 24, 0, 5, 0, 0, zone)
		home := t.TempDir()
		// Filed in the next day's directory, as local dates are.
		dir := filepath.Join(home, ".codex", "sessions", "2026", "10", "24")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		when := time.Date(2026, 10, 24, 0, 1, 0, 0, zone)
		line := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"cwd":%q,"timestamp":%q}}`+"\n",
			idA, cwd, when.UTC().Format(time.RFC3339))
		name := "rollout-2026-10-24T00-01-00-" + idA + ".jsonl"
		if err := os.WriteFile(filepath.Join(dir, name), []byte(line), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := ReadCodex(home, CodexQuery{Cwd: cwd, Since: started, Now: now}); got != idA {
			t.Fatalf("got %q", got)
		}
	})
}
