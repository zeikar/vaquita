package state

import (
	"errors"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestStateRoundtrip(t *testing.T) {
	home := t.TempDir()
	want := State{
		Shell: "/bin/bash",
		Sessions: []SessionRecord{
			{SID: 1, PID: 4242, Started: time.Date(2026, 10, 21, 12, 30, 0, 123456789, time.UTC), Cwd: "/tmp/work", Cmd: "claude", Name: "main"},
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

func TestStatePruneDead(t *testing.T) {
	started := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	st := State{Shell: "/bin/zsh", Sessions: []SessionRecord{
		{SID: 1, PID: 100, Started: started, Name: "gone"},
		{SID: 2, PID: 200, Started: started, Name: "left children", Orphans: []int{201}},
		{SID: 3, PID: 300, Started: started, Name: "scan failed", Orphans: []int{301}},
		{SID: 4, PID: 400, Started: started, Name: "pid reused"},
		{SID: 5, PID: 500, Started: started, Name: "shell still alive"},
	}}
	scanErr := errors.New("test: scan failed")
	var scanned []int
	kept, err := st.PruneDead(func(sid int) ([]int, time.Time, error) {
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
		t.Errorf("PruneDead error %v, want the scan's", err)
	}
	if !reflect.DeepEqual(scanned, []int{100, 200, 300, 400, 500}) {
		t.Errorf("scanned sids %v, want the records' pids", scanned)
	}
	want := []SessionRecord{
		{SID: 2, PID: 200, Started: started, Name: "left children", Orphans: []int{202, 203}},
		{SID: 3, PID: 300, Started: started, Name: "scan failed", Orphans: []int{301}},
		{SID: 5, PID: 500, Started: started, Name: "shell still alive", Orphans: []int{500}},
	}
	if !reflect.DeepEqual(kept, want) {
		t.Errorf("PruneDead = %+v, want %+v", kept, want)
	}
	if !reflect.DeepEqual(st.Sessions, want) {
		t.Errorf("Sessions after PruneDead = %+v, want %+v", st.Sessions, want)
	}
}
