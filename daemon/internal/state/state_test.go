package state

import (
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestStateRoundtrip(t *testing.T) {
	home := t.TempDir()
	want := State{
		Shell: "/bin/bash",
		Repos: []string{"/tmp/repo", "/tmp/repo-feature"},
		Sessions: []SessionRecord{
			{SID: 1, PID: 4242, Started: time.Date(2026, 10, 21, 12, 30, 0, 123456789, time.UTC), Cwd: "/tmp/work", Cmd: "claude", Name: "main", Agent: "claude", Conversation: "5f4a3c2e-1b0d-4e8f-9a7b-6c5d4e3f2a1b"},
			{SID: 2, PID: 4250, Started: time.Date(2026, 10, 21, 13, 0, 0, 0, time.UTC), Cwd: "/tmp", Orphans: []int{4300, 4301}},
		},
	}
	if err := want.Save(home); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(StatePath(home))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", fi.Mode().Perm())
	}
	got, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Load = %+v, want %+v", got, want)
	}
	data, err := os.ReadFile(StatePath(home))
	if err != nil {
		t.Fatal(err)
	}
	// Record 2 has neither agent nor conversation, so the keys appear once.
	if n := strings.Count(string(data), `"agent"`); n != 1 {
		t.Errorf(`state.json has %d "agent" keys, want 1`, n)
	}
	if n := strings.Count(string(data), `"conversation"`); n != 1 {
		t.Errorf(`state.json has %d "conversation" keys, want 1`, n)
	}
}

func TestStateDefaultShell(t *testing.T) {
	got, err := Load(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got.Shell != "/bin/zsh" || len(got.Sessions) != 0 {
		t.Errorf("Load without a state file = %+v, want shell /bin/zsh and no sessions", got)
	}
}

func TestStateLoadCorrupt(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(StatePath(home), []byte(`{"shell":"/bin/bash","sessions":[{"sid":1},`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := Load(home)
	if err == nil {
		t.Fatal("Load of a truncated file succeeded")
	}
	if !reflect.DeepEqual(got, State{Shell: "/bin/zsh"}) {
		t.Errorf("Load of a truncated file = %+v, want the defaults", got)
	}
}

func TestStateRescan(t *testing.T) {
	started := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	st := State{Shell: "/bin/zsh", Sessions: []SessionRecord{
		{SID: 1, PID: 100, Started: started, Name: "gone", Orphans: []int{101}},
		{SID: 2, PID: 200, Started: started, Name: "left children", Orphans: []int{201}},
		{SID: 3, PID: 300, Started: started, Name: "scan failed", Orphans: []int{301}},
		{SID: 4, PID: 400, Started: started, Name: "pid reused", Orphans: []int{401}},
		{SID: 5, PID: 500, Started: started, Name: "shell still alive"},
	}}
	scanErr := errors.New("test: scan failed")
	var scanned []int
	holding, err := st.Rescan(func(sid int) ([]int, time.Time, error) {
		scanned = append(scanned, sid)
		switch sid {
		case 200:
			return []int{202, 203}, time.Time{}, nil
		case 300:
			return nil, time.Time{}, scanErr
		case 400:
			return []int{400, 401}, started.Add(time.Hour), nil
		case 500:
			return []int{500}, started.Add(500 * time.Millisecond), nil
		}
		return nil, time.Time{}, nil
	})
	if !errors.Is(err, scanErr) {
		t.Errorf("Rescan error %v, want the scan's", err)
	}
	if !reflect.DeepEqual(scanned, []int{100, 200, 300, 400, 500}) {
		t.Errorf("scanned sids %v, want the records' pids", scanned)
	}
	want := []SessionRecord{
		{SID: 1, PID: 100, Started: started, Name: "gone"},
		{SID: 2, PID: 200, Started: started, Name: "left children", Orphans: []int{202, 203}},
		{SID: 3, PID: 300, Started: started, Name: "scan failed", Orphans: []int{301}},
		{SID: 4, PID: 400, Started: started, Name: "pid reused"},
		{SID: 5, PID: 500, Started: started, Name: "shell still alive", Orphans: []int{500}},
	}
	if !reflect.DeepEqual(st.Sessions, want) {
		t.Errorf("Sessions after Rescan = %+v, want %+v", st.Sessions, want)
	}
	if wantHolding := []SessionRecord{want[1], want[2], want[4]}; !reflect.DeepEqual(holding, wantHolding) {
		t.Errorf("Rescan returned %+v, want %+v", holding, wantHolding)
	}
}

func TestStateLoadSortsRepos(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(StatePath(home), []byte(`{"repos":["/tmp/repo-feature","/tmp/repo","/tmp/repo-feature"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"/tmp/repo", "/tmp/repo-feature"}; !reflect.DeepEqual(got.Repos, want) {
		t.Errorf("Repos = %v, want %v", got.Repos, want)
	}
}
