package session

import (
	"os"
	"strconv"
)

// inheritedEnv is all a child takes from the daemon's environment. A daemon
// started from inside another tool would otherwise pass on that tool's
// variables (CLAUDECODE, CODEX_HOME and the like), which change how agents
// in the session behave. SSH_AUTH_SOCK lets agents push over ssh.
var inheritedEnv = []string{"HOME", "USER", "LOGNAME", "TMPDIR", "PATH", "SSH_AUTH_SOCK", "LANG"}

// fallbackLang applies when the daemon has no LANG, as under launchd:
// without a UTF-8 locale shells mangle non-ASCII text.
const fallbackLang = "en_US.UTF-8"

// ChildEnv returns the environment for the shell running session sid. SHELL is
// that shell rather than the daemon's, so programs that start $SHELL get the
// one the session runs.
func ChildEnv(sid int, shell string) []string {
	env := make([]string, 0, len(inheritedEnv)+5)
	for _, k := range inheritedEnv {
		v := os.Getenv(k)
		if v == "" && k == "LANG" {
			v = fallbackLang
		}
		if v != "" {
			env = append(env, k+"="+v)
		}
	}
	return append(env,
		"SHELL="+shell,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TERM_PROGRAM=vaquita",
		"VAQUITA_SESSION_ID="+strconv.Itoa(sid),
	)
}
