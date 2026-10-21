package main

import "strings"

// shellJoin makes args one shell command line that runs them exactly as
// given: each is single-quoted, so the shell sees no syntax in them.
func shellJoin(args []string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
	}
	return strings.Join(quoted, " ")
}
