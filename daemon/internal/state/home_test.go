package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHomeHonoursEnvAndCreatesDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "home")
	t.Setenv("VAQUITA_HOME", dir)
	got, err := Home()
	if err != nil {
		t.Fatal(err)
	}
	if got != dir {
		t.Fatalf("Home() = %q, want %q", got, dir)
	}
	fi, err := os.Stat(got)
	if err != nil || !fi.IsDir() {
		t.Fatalf("home not created: %v", err)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Fatalf("mode = %v, want 0700", fi.Mode().Perm())
	}
}

func TestHomeMakesRelativePathAbsolute(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("VAQUITA_HOME", "rel-home")
	got, err := Home()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(got) {
		t.Fatalf("Home() = %q, want absolute", got)
	}
}

func TestLabel(t *testing.T) {
	t.Setenv("VAQUITA_HOME", "")
	def := Label()
	if def != "io.github.zeikar.vaquitad" {
		t.Fatalf("default label = %q", def)
	}
	t.Setenv("VAQUITA_HOME", "/home/u/.vaquita-dev")
	dev := Label()
	if dev == def {
		t.Fatal("dev label equals default label")
	}
	if dev != Label() {
		t.Fatal("label is not stable")
	}
	if len(dev) != len(def)+1+8 {
		t.Fatalf("dev label = %q, want 8 hex suffix", dev)
	}
}
