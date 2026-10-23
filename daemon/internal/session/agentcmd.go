package session

import (
	"strings"

	"github.com/zeikar/vaquita/daemon/internal/convid"
)

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
	rest, end := firstWord(cmd)
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

// firstWord returns cmd without its leading blanks and the length of the
// first word in that.
func firstWord(cmd string) (rest string, end int) {
	rest = strings.TrimLeft(cmd, " \t")
	end = strings.IndexAny(rest, " \t\n")
	if end < 0 {
		end = len(rest)
	}
	return rest, end
}

// RestoreCommand returns the command that reopens a session whose record has
// cmd, the agent kind ("claude" or "codex", or empty) and the conversation id
// the daemon saw while it ran. The kind is the recorded agent, else the first
// word of cmd, so an agent that was typed into a plain shell is resumed too.
// Without a kind it is "": a plain shell in the session's cwd. The rest of
// the typed command (options, a subcommand such as `resume --last`, a `cd`
// before it) is dropped: it may already be a resume of another conversation,
// and keeping it would make a second restore differ from the first. The
// result is meant to go through AgentCommand, which adds Codex's options.
func RestoreCommand(cmd, agent, id string) string {
	kind := agent
	if kind != "claude" && kind != "codex" {
		rest, end := firstWord(cmd)
		switch rest[:end] {
		case "claude", "'claude'":
			kind = "claude"
		case "codex", "'codex'":
			kind = "codex"
		default:
			return ""
		}
	}
	// A recorded id wins: it is newer than the typed one after a /new. Codex
	// only appends to the rollout of `codex resume <id>`, so the reader never
	// sees an older conversation and the typed id is all there is.
	if kind == "codex" && !convid.ValidID(id) {
		id = explicitResumeID(cmd)
	}
	ok := convid.ValidID(id)
	switch {
	case kind == "claude" && ok:
		return "claude --resume " + shellQuote(id)
	case kind == "claude":
		return "claude --continue"
	case ok:
		return "codex resume " + shellQuote(id)
	}
	return "codex resume --last"
}

// explicitResumeID returns the id in a typed `codex resume <id>`, "" if the
// command has another shape. Each word is bare or fully single-quoted, as
// `vaquitad attach` and RestoreCommand send them. Options before `resume` are
// not recognized, and a quoted prompt that holds the words is one word, so
// text elsewhere in the command is never taken for an id.
func explicitResumeID(cmd string) string {
	w := strings.Fields(cmd)
	if len(w) < 3 || unquoteWord(w[0]) != "codex" || unquoteWord(w[1]) != "resume" {
		return ""
	}
	if id := unquoteWord(w[2]); convid.ValidID(id) {
		return id
	}
	return ""
}

// unquoteWord returns w without one pair of single quotes around it, or ""
// if w has any other quote: a field of a longer quoted word is not a word.
func unquoteWord(w string) string {
	if len(w) >= 2 && w[0] == '\'' && w[len(w)-1] == '\'' {
		w = w[1 : len(w)-1]
	}
	if strings.Contains(w, "'") {
		return ""
	}
	return w
}
