package server

import (
	"log/slog"
	"strings"
	"unicode"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
)

// maxNameRunes caps a session name. A row shows far less, and the name goes
// out in every sessions list and into state.json, so a stray paste must not
// make it long.
const maxNameRunes = 200

// cleanName makes the name a create or a rename gives a session a one-line
// label: without control characters, which a label has no use for, trimmed,
// and cut to maxNameRunes.
func cleanName(name string) string {
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name))
	if r := []rune(name); len(r) > maxNameRunes {
		name = strings.TrimRightFunc(string(r[:maxNameRunes]), unicode.IsSpace)
	}
	return name
}

// rename sets the name of a session, running or exited, or of a record from
// an earlier run, which a reopen carries over. An empty name clears it, so the
// row is titled by the agent's title again.
func (c *conn) rename(m protocol.Rename) {
	name := cleanName(m.Name)
	t := c.srv.table
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.entries[m.SID]
	if e == nil {
		c.send(noSession(m.SID))
		return
	}
	if e.rec.Name == name {
		return
	}
	e.rec.Name = name
	slog.Info("session renamed", "sid", m.SID, "name", name)
	t.saveLocked()
	t.broadcastLocked()
}
