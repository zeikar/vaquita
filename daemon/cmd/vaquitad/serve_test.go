package main

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/zeikar/vaquita/daemon/internal/state"
)

// A state.json that cannot be loaded is moved aside before anything can
// overwrite it with the defaults.
func TestLoadStateMovesBadFileAside(t *testing.T) {
	home := t.TempDir()
	bad := []byte(`{"shell":"/bin/bash","sessions":[{"sid":3,`)
	if err := os.WriteFile(state.StatePath(home), bad, 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := loadState(slog.New(slog.NewTextHandler(io.Discard, nil)), home)
	if err != nil {
		t.Fatalf("loadState: %v", err)
	}
	if st.Shell != "/bin/zsh" || len(st.Sessions) != 0 {
		t.Errorf("state = %+v, want the defaults", st)
	}
	if _, err := os.Stat(state.StatePath(home)); !os.IsNotExist(err) {
		t.Errorf("state.json still in place: %v", err)
	}
	moved, err := filepath.Glob(state.StatePath(home) + ".bad-*")
	if err != nil || len(moved) != 1 {
		t.Fatalf("moved-aside files = %v, %v; want one", moved, err)
	}
	if got, err := os.ReadFile(moved[0]); err != nil || string(got) != string(bad) {
		t.Errorf("%s holds %q, %v; want the original", moved[0], got, err)
	}
}

// When the bad file cannot be moved aside the daemon must not start, or its
// first save would overwrite it.
func TestLoadStateRefusesWhenMoveFails(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(state.StatePath(home), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Without write permission on the directory the rename fails.
	if err := os.Chmod(home, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(home, 0o700) })
	if _, err := loadState(slog.New(slog.NewTextHandler(io.Discard, nil)), home); err == nil {
		t.Fatal("loadState succeeded although state.json could not be moved aside")
	}
	if got, err := os.ReadFile(state.StatePath(home)); err != nil || string(got) != "not json" {
		t.Errorf("state.json = %q, %v; want it untouched", got, err)
	}
}
