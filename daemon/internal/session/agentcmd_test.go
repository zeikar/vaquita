package session

import (
	"os/exec"
	"slices"
	"strings"
	"testing"
)

const (
	optNotifications = `tui.notifications=["agent-turn-complete","approval-requested","plan-mode-prompt","async-question"]`
	optMethod        = `tui.notification_method="osc9"`
	optCondition     = `tui.notification_condition="always"`
	codexOpts        = " -c '" + optNotifications + "' -c '" + optMethod + "' -c '" + optCondition + "'"
)

func TestAgentCommand(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"codex", "codex" + codexOpts},
		{"codex resume --last", "codex" + codexOpts + " resume --last"},
		{"  codex --model x", "codex" + codexOpts + " --model x"},
		// How vaquitad attach --new -- codex resume --last sends it.
		{"'codex' 'resume' '--last'", "'codex'" + codexOpts + " 'resume' '--last'"},
		{"codex\necho done", "codex" + codexOpts + "\necho done"},
		{"'codex", "'codex"},
		{"claude", "claude"},
		{"cd /tmp/repo && codex", "cd /tmp/repo && codex"},
		{"codexx", "codexx"},
		{"", ""},
	} {
		if got := AgentCommand(c.in); got != c.want {
			t.Errorf("AgentCommand(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestAgentCommandSurvivesTheShell(t *testing.T) {
	got := AgentCommand("codex resume --last")
	if !strings.HasPrefix(got, "codex ") {
		t.Fatalf("AgentCommand = %q, want it to start with %q", got, "codex ")
	}
	script := `printf '%s\n'` + strings.TrimPrefix(got, "codex")
	out, err := exec.Command("/bin/sh", "-c", script).Output()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"-c", optNotifications, "-c", optMethod, "-c", optCondition, "resume", "--last"}
	if lines := strings.Split(strings.TrimSuffix(string(out), "\n"), "\n"); !slices.Equal(lines, want) {
		t.Errorf("shell argv = %q, want %q", lines, want)
	}
}
