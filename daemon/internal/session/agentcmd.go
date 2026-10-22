package session

import "strings"

// codexOptions make Codex emit OSC 9 notifications for turn completion,
// approval requests, plan-mode prompts and questions.
// vaquita judges turn completion from those notifications, and decides itself
// whether to show one, so the condition is "always".
var codexOptions = []string{
	`tui.notifications=["agent-turn-complete","approval-requested","plan-mode-prompt","async-question"]`,
	`tui.notification_method="osc9"`,
	`tui.notification_condition="always"`,
}

// AgentCommand adds per-session options to a command that starts Codex. The
// options go right after `codex`, as root options, so a subcommand such as
// `codex resume --last` keeps working. The word may be single-quoted, as
// `vaquitad attach --new -- codex` sends it. Other commands come back
// unchanged. Callers keep the typed command for display and the record.
func AgentCommand(cmd string) string {
	rest := strings.TrimLeft(cmd, " \t")
	end := strings.IndexAny(rest, " \t\n")
	if end < 0 {
		end = len(rest)
	}
	if word := rest[:end]; word != "codex" && word != "'codex'" {
		return cmd
	}
	var b strings.Builder
	b.WriteString(rest[:end])
	for _, o := range codexOptions {
		b.WriteString(" -c " + shellQuote(o))
	}
	return b.String() + rest[end:]
}
