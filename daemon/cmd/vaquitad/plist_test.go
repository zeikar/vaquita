package main

import (
	"bytes"
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
		"<key>AssociatedBundleIdentifiers</key>\n\t<array>\n\t\t<string>io.github.zeikar.vaquita</string>\n\t</array>",
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
	dir := filepath.Join(t.TempDir(), "home")
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

func TestWriteAgentPlistKeepsInstalledOnInvalid(t *testing.T) {
	dir := t.TempDir()
	good := renderPlist("bad", "/e", "/h")
	if _, err := writeAgentPlist(dir, "bad", good); err != nil {
		t.Fatal(err)
	}
	if _, err := writeAgentPlist(dir, "bad", []byte("not a plist")); err == nil {
		t.Fatal("expected lint failure")
	}
	got, err := os.ReadFile(filepath.Join(dir, "bad.plist"))
	if err != nil || !bytes.Equal(got, good) {
		t.Fatalf("installed plist = %q, %v; want it untouched", got, err)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "*.tmp")); len(left) != 0 {
		t.Fatalf("temporary files left behind: %v", left)
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

func TestUnstablySigned(t *testing.T) {
	// Fixtures signed here, so the test holds on arm64 (where Go's linker
	// ad-hoc signs) and amd64 (where it leaves binaries unsigned) alike.
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	fixture := func(name string, codesign ...string) string {
		path := filepath.Join(dir, name)
		b, err := os.ReadFile(exe)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, b, 0o755); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command("codesign", append(codesign, path)...).CombinedOutput(); err != nil {
			t.Fatalf("codesign %v: %v\n%s", codesign, err, out)
		}
		return path
	}
	if !unstablySigned(fixture("adhoc", "--force", "--sign", "-")) {
		t.Error("ad-hoc signed binary not reported")
	}
	if !unstablySigned(fixture("unsigned", "--remove-signature")) {
		t.Error("unsigned binary not reported")
	}
	if unstablySigned("/bin/ls") {
		t.Error("/bin/ls (Apple-signed) reported")
	}
}
