package main

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// The release sets the build through the linker, so the variable's name is
// part of the contract with the Makefile.
func TestVersionPrintsTheLinkedBuild(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "vaquitad")
	if out, err := exec.Command("go", "build", "-ldflags", "-X main.version=1.2.3-test", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	for _, arg := range []string{"version", "--version"} {
		out, err := exec.Command(bin, arg).Output()
		if err != nil {
			t.Fatalf("vaquitad %s: %v", arg, err)
		}
		if string(out) != "1.2.3-test\n" {
			t.Errorf("vaquitad %s printed %q, want %q", arg, out, "1.2.3-test\n")
		}
	}
}
