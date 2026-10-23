package convid

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

var claudeStart = time.Date(2026, 10, 23, 10, 0, 0, 0, time.UTC)

func writePidFile(t *testing.T, home string, pid int, content string) {
	t.Helper()
	dir := filepath.Join(home, ".claude", "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, strconv.Itoa(pid)+".json"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func pidJSON(id string, startedAt time.Time) string {
	return `{"pid":1,"sessionId":"` + id + `","cwd":"/tmp/repo","startedAt":` + strconv.FormatInt(startedAt.UnixMilli(), 10) + `,"status":"idle","extra":{"a":1}}`
}

func TestReadClaude(t *testing.T) {
	member := func(pid, pgid int, start time.Time) Member { return Member{PID: pid, PGID: pgid, Start: start} }
	m1 := member(100, 100, claudeStart)
	for _, tc := range []struct {
		name    string
		files   map[int]string
		members []Member
		fg      int
		want    string
	}{
		{"member file", map[int]string{100: pidJSON(idA, claudeStart)}, []Member{m1}, 100, idA},
		{"no directory", nil, []Member{m1}, 100, ""},
		{"pid is no member", map[int]string{200: pidJSON(idA, claudeStart)}, []Member{m1}, 100, ""},
		{"garbage", map[int]string{100: "{nope"}, []Member{m1}, 100, ""},
		{"no sessionId", map[int]string{100: `{"pid":100}`}, []Member{m1}, 100, ""},
		{"bad sessionId", map[int]string{100: pidJSON("not-a-uuid", claudeStart)}, []Member{m1}, 100, ""},
		{"foreground wins", map[int]string{
			100: pidJSON(idA, claudeStart.Add(time.Second)),
			200: pidJSON(idB, claudeStart),
		}, []Member{member(100, 100, claudeStart), member(200, 200, claudeStart)}, 200, idB},
		{"newer without foreground", map[int]string{
			100: pidJSON(idA, claudeStart),
			200: pidJSON(idB, claudeStart.Add(time.Second)),
		}, []Member{member(100, 100, claudeStart), member(200, 200, claudeStart)}, 999, idB},
		{"preferred file lacks sessionId", map[int]string{
			100: pidJSON(idA, claudeStart),
			200: `{"startedAt":` + strconv.FormatInt(claudeStart.UnixMilli(), 10) + `}`,
		}, []Member{member(100, 100, claudeStart), member(200, 200, claudeStart)}, 200, ""},
		{"preferred file has a bad sessionId", map[int]string{
			100: pidJSON(idA, claudeStart),
			200: pidJSON("not-a-uuid", claudeStart),
		}, []Member{member(100, 100, claudeStart), member(200, 200, claudeStart)}, 200, ""},
		{"no startedAt skips the reuse check", map[int]string{100: `{"sessionId":"` + idA + `"}`}, []Member{m1}, 100, idA},
		{"stale startedAt", map[int]string{100: pidJSON(idA, claudeStart.Add(-60*time.Second))}, []Member{m1}, 100, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			for pid, c := range tc.files {
				writePidFile(t, home, pid, c)
			}
			if got := ReadClaude(home, tc.members, tc.fg); got != tc.want {
				t.Fatalf("ReadClaude = %q, want %q", got, tc.want)
			}
		})
	}
}
