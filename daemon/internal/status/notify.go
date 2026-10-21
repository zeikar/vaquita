package status

import (
	"bytes"
	"strings"
	"unicode/utf8"
)

// maxNotifyText caps each notification field. An OSC payload is at most 4KB
// already; this keeps the list of recent notifications small.
const maxNotifyText = 2048

// Notify kinds.
const (
	KindOSC9   = "osc9"
	KindOSC777 = "osc777"
)

// Notify is a desktop-notification request from the program: OSC 9 (Codex) or
// OSC 777;notify (Claude Code).
type Notify struct {
	Kind  string
	Title string // OSC 777 only
	Body  string
}

// ParseNotify parses the payload of OSC num. OSC 777 is only a notification
// when its first field is "notify"; its body may contain ';'.
func ParseNotify(num int, payload []byte) (Notify, bool) {
	switch num {
	case 9:
		// Windows Terminal and ConEmu reuse OSC 9 for commands such as
		// 9;4;st;pct progress and 9;9;cwd, which Cargo, systemd and others emit
		// constantly. A numeric first field marks one; those and empty bodies
		// are not notifications.
		if len(payload) == 0 || conEmuCommand(payload) {
			return Notify{}, false
		}
		return Notify{Kind: KindOSC9, Body: text(payload)}, true
	case 777:
		cmd, rest, _ := bytes.Cut(payload, []byte{';'})
		if string(cmd) != "notify" {
			return Notify{}, false
		}
		title, body, _ := bytes.Cut(rest, []byte{';'})
		return Notify{Kind: KindOSC777, Title: text(title), Body: text(body)}, true
	}
	return Notify{}, false
}

// conEmuCommand reports whether p starts with digits that end at a ';' or at
// the end of p, as in "4;1;50" or "12".
func conEmuCommand(p []byte) bool {
	i := 0
	for i < len(p) && p[i] >= '0' && p[i] <= '9' {
		i++
	}
	return i > 0 && (i == len(p) || p[i] == ';')
}

// text copies b as valid UTF-8 of at most maxNotifyText bytes.
func text(b []byte) string {
	if len(b) > maxNotifyText {
		b = b[:maxNotifyText]
		// Drop a character the cut left incomplete.
		for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax; i-- {
			if utf8.RuneStart(b[i]) {
				if !utf8.FullRune(b[i:]) {
					b = b[:i]
				}
				break
			}
		}
	}
	return strings.ToValidUTF8(string(b), "�")
}
