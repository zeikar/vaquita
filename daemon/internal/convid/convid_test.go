package convid

import (
	"os"
	"path/filepath"
	"testing"
)

const (
	idA = "1e384cb4-cf8e-4a61-b8be-9bbd9f093a8c"
	idB = "01a166f1-5cfb-7552-a0bd-cd891592ca64"
	idC = "5b0e2c3a-9d7f-4e1a-8c55-0f2d6a7b1e90"
)

func TestValidID(t *testing.T) {
	for _, tc := range []struct {
		id   string
		want bool
	}{
		{idA, true},
		{"1E384CB4-CF8E-4A61-B8BE-9BBD9F093A8C", true},
		{idA[:35], false},
		{"-" + idA[1:], false},
		{idA[:35] + "\n", false},
		{idA[:35] + "g", false},
		{"", false},
	} {
		if got := ValidID(tc.id); got != tc.want {
			t.Errorf("ValidID(%q) = %v, want %v", tc.id, got, tc.want)
		}
	}
}

func TestResolve(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	if resolve(dir) != resolve(link) {
		t.Error("a symlink and its target differ")
	}
	if resolve(dir) == resolve(filepath.Join(dir, "other")) {
		t.Error("different paths are the same")
	}
	if resolve("/nonexistent/a/../b") != resolve("/nonexistent/b") {
		t.Error("cleaned fallback differs")
	}
}
