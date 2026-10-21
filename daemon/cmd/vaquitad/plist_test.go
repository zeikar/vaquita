package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zeikar/vaquita/daemon/internal/state"
)

func lint(t *testing.T, path string) {
	t.Helper()
	if out, err := exec.Command("plutil", "-lint", path).CombinedOutput(); err != nil {
		t.Fatalf("plutil -lint: %v\n%s", err, out)
	}
}

func TestRenderedPlistLints(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.plist")
	if err := os.WriteFile(p, renderPlist("io.example.test", "/opt/bin/vaquitad", "/tmp/h"), 0o644); err != nil {
		t.Fatal(err)
	}
	lint(t, p)
}

func TestLabelsDiffer(t *testing.T) {
	t.Setenv("VAQUITA_HOME", "")
	def := state.Label()
	t.Setenv("VAQUITA_HOME", filepath.Join(os.Getenv("HOME"), ".vaquita-dev"))
	if dev := state.Label(); dev == def {
		t.Fatalf("dev and default labels are both %q", dev)
	}
}

func TestLaunchdKeys(t *testing.T) {
	s := string(renderPlist("l", "/e", "/h"))
	for _, want := range []string{
		"<key>ProcessType</key>\n\t<string>Interactive</string>",
		"<key>AbandonProcessGroup</key>\n\t<true/>",
		"<key>KeepAlive</key>\n\t<false/>",
		"<key>RunAtLoad</key>\n\t<true/>",
		"<string>/h/launchd.stderr.log</string>",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in\n%s", want, s)
		}
	}
}

func TestPlistEscapesPaths(t *testing.T) {
	b := renderPlist("l", "/a&b/vaquitad", "/h&<home>")
	s := string(b)
	if !strings.Contains(s, "/a&amp;b/vaquitad") || !strings.Contains(s, "/h&amp;&lt;home&gt;") {
		t.Fatalf("values not escaped:\n%s", s)
	}
	p := filepath.Join(t.TempDir(), "x.plist")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	lint(t, p)
}

func TestWriteAgentPlist(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "LaunchAgents")
	path, err := writeAgentPlist(dir, "io.example.test", renderPlist("io.example.test", "/e", "/h"))
	if err != nil {
		t.Fatal(err)
	}
	if path != filepath.Join(dir, "io.example.test.plist") {
		t.Fatalf("path = %s", path)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o644 {
		t.Fatalf("stat = %v, %v", fi, err)
	}
}

func TestWriteAgentPlistRemovesInvalid(t *testing.T) {
	dir := t.TempDir()
	if _, err := writeAgentPlist(dir, "bad", []byte("not a plist")); err == nil {
		t.Fatal("expected lint failure")
	}
	if _, err := os.Stat(filepath.Join(dir, "bad.plist")); !os.IsNotExist(err) {
		t.Fatalf("invalid plist left behind: %v", err)
	}
}

func TestCheckExeStable(t *testing.T) {
	// install resolves symlinks before the check; do the same here.
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := checkExeStable(filepath.Join(dir, "vaquitad")); err == nil {
		t.Error("temp dir executable accepted")
	}
	if err := checkExeStable("/x/go-build123/b001/exe/vaquitad"); err == nil {
		t.Error("go-build executable accepted")
	}
	if err := checkExeStable("/opt/vaquita/bin/vaquitad"); err != nil {
		t.Errorf("stable path refused: %v", err)
	}
}
