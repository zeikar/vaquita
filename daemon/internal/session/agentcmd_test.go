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

func TestRestoreCommand(t *testing.T) {
	const id = "0b6c8a5e-1f2d-4c3b-9a8e-7d6c5b4a3f21"
	tests := []struct{ cmd, agent, id, want string }{
		{"claude", "", "", "claude --continue"},
		{"claude --model haiku", "", "", "claude --continue"},
		{"", "claude", id, "claude --resume '" + id + "'"},
		{"claude --continue", "claude", id, "claude --resume '" + id + "'"},
		{"codex", "", id, "codex resume '" + id + "'"},
		{"codex", "", "", "codex resume --last"},
		{"codex resume " + id, "codex", "", "codex resume '" + id + "'"},
		{"codex resume '" + id + "'", "codex", "", "codex resume '" + id + "'"},
		{"'codex' 'resume' '" + id + "'", "", "", "codex resume '" + id + "'"},
		{"codex \"please resume " + id + " tomorrow\"", "", "", "codex resume --last"},
		{"'codex' 'resume " + id + " tomorrow'", "", "", "codex resume --last"},
		{"codex -m x resume " + id, "", "", "codex resume --last"},
		{"codex resume " + id, "codex", "0c6c8a5e-1f2d-4c3b-9a8e-7d6c5b4a3f22", "codex resume '0c6c8a5e-1f2d-4c3b-9a8e-7d6c5b4a3f22'"},
		{"codex resume", "codex", "", "codex resume --last"},
		{"codex resume --last", "codex", "not-a-uuid", "codex resume --last"},
		{"  codex --model x", "", "", "codex resume --last"},
		{"sleep 60", "", id, ""},
		{"cd /tmp/repo && claude", "", "", ""},
		{"claudex", "", "", ""},
		{"", "other", id, ""},
	}
	for _, tt := range tests {
		if got := RestoreCommand(tt.cmd, tt.agent, tt.id); got != tt.want {
			t.Errorf("RestoreCommand(%q, %q, %q) = %q, want %q", tt.cmd, tt.agent, tt.id, got, tt.want)
		}
	}
	want := "codex" + codexOpts + " resume '" + id + "'"
	if got := AgentCommand(RestoreCommand("codex", "codex", id)); got != want {
		t.Errorf("AgentCommand(RestoreCommand) = %q, want %q", got, want)
	}
}
