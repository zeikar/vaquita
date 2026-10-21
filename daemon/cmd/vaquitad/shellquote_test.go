package main

import (
	"os/exec"
	"testing"
)

func TestShellJoin(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"printf", "%s\n", "a b", "c;d"}, `'printf' '%s` + "\n" + `' 'a b' 'c;d'`},
		{[]string{"echo", ""}, `'echo' ''`},
		{[]string{"it's"}, `'it'\''s'`},
	} {
		if got := shellJoin(tc.args); got != tc.want {
			t.Errorf("shellJoin(%q) = %q, want %q", tc.args, got, tc.want)
		}
	}
}

// The joined string, run by a real shell, hands each argument over intact:
// spaces do not split one, ';' and '$' are not syntax, and an empty one is
// still passed.
func TestShellJoinRoundTrip(t *testing.T) {
	args := []string{"printf", "<%s>", "a b", "c;d", "", "it's", "$HOME", "*"}
	out, err := exec.Command("/bin/sh", "-c", shellJoin(args)).Output()
	if err != nil {
		t.Fatal(err)
	}
	if want := "<a b><c;d><><it's><$HOME><*>"; string(out) != want {
		t.Errorf("output = %q, want %q", out, want)
	}
}
