package session

import (
	"os"
	"strings"
	"testing"
)

func envMap(t *testing.T, env []string) map[string]string {
	t.Helper()
	m := make(map[string]string, len(env))
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			t.Fatalf("malformed entry %q", kv)
		}
		if _, dup := m[k]; dup {
			t.Fatalf("duplicate key %q", k)
		}
		m[k] = v
	}
	return m
}

func TestChildEnvAllowlist(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("ORCA_X", "leak")
	t.Setenv("CODEX_HOME", "/tmp/codex")
	t.Setenv("SSH_AUTH_SOCK", "/tmp/agent.sock")
	t.Setenv("HOME", "/tmp/home")
	t.Setenv("LANG", "ko_KR.UTF-8")
	t.Setenv("TERM", "dumb")
	t.Setenv("TERM_PROGRAM", "OtherTerminal")
	t.Setenv("SHELL", "/bin/bash")

	got := envMap(t, ChildEnv(7, "/bin/zsh"))
	for _, k := range []string{"CLAUDECODE", "ORCA_X", "CODEX_HOME"} {
		if v, ok := got[k]; ok {
			t.Errorf("%s=%q leaked into the child env", k, v)
		}
	}
	want := map[string]string{
		"SSH_AUTH_SOCK":      "/tmp/agent.sock",
		"HOME":               "/tmp/home",
		"LANG":               "ko_KR.UTF-8",
		"SHELL":              "/bin/zsh",
		"TERM":               "xterm-256color",
		"COLORTERM":          "truecolor",
		"TERM_PROGRAM":       "vaquita",
		"FORCE_HYPERLINK":    "1",
		"VAQUITA_SESSION_ID": "7",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}

func TestChildEnvLangFallback(t *testing.T) {
	// launchd starts the daemon without LANG; t.Setenv restores it after.
	t.Setenv("LANG", "")
	if err := os.Unsetenv("LANG"); err != nil {
		t.Fatal(err)
	}
	if got := envMap(t, ChildEnv(1, "/bin/sh"))["LANG"]; got != "en_US.UTF-8" {
		t.Fatalf("LANG = %q, want en_US.UTF-8", got)
	}
}
