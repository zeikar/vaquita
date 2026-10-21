// Package status parses and stores what programs in a session report about
// themselves: OSC 7501 program-status records and OSC 9/777 notifications.
// It only keeps the data; turning it into sidebar states or events is up to
// the callers.
package status

import (
	"bytes"
	"encoding/base64"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Limits from the OSC 7501 specification, plus the caps this package puts on
// free text so that stored records stay small.
const (
	MaxRecords = 256

	maxIDSegments = 8
	maxIDSegment  = 32
	maxIDLen      = 128
	maxAppLen     = 32
	maxMsgLen     = 2048
	maxTitleLen   = 192
)

// Report states.
const (
	StateIdle    = "idle"
	StateWorking = "working"
	StateDone    = "done"
	StateBlocked = "blocked"
	StateError   = "error"
	StateClear   = "clear"
)

// Report is one parsed OSC 7501 status report. Absent optional fields are
// empty strings, and HasProgress tells an absent progress from 0.
type Report struct {
	// Query is a bare "?" capability query. The terminal answers it, so
	// nothing else is set.
	Query bool

	// ID names a child record such as a subagent, with '/' separating levels.
	// Empty is the session's root record.
	ID          string
	State       string
	Kind        string // permission, question or auth
	Msg         string
	Title       string
	App         string
	Progress    int
	HasProgress bool
}

// ParseReport parses the bytes after "7501;" of an OSC 7501 string. It
// reports false for a report that must be dropped: a missing or unknown
// state, or an invalid id (which would otherwise be applied to the wrong
// record). Other bad fields are left out of an otherwise valid report: an
// unknown kind, a progress outside 0-100, an overlong app, and a msg or title
// that is not base64 of valid UTF-8 or decodes past its cap. Malformed pairs
// and unknown keys are skipped, and the last value of a repeated key wins.
// The caller drops oversized (truncated) strings before calling.
func ParseReport(payload []byte) (Report, bool) {
	if string(payload) == "?" {
		return Report{Query: true}, true
	}
	var state, id, kind, msg, title, app, progress string
	for len(payload) > 0 {
		var pair []byte
		pair, payload, _ = bytes.Cut(payload, []byte{':'})
		k, v, ok := bytes.Cut(pair, []byte{'='})
		if !ok {
			continue
		}
		switch string(k) {
		case "state":
			state = string(v)
		case "id":
			id = string(v)
		case "kind":
			kind = string(v)
		case "msg":
			msg = string(v)
		case "title":
			title = string(v)
		case "app":
			app = string(v)
		case "progress":
			progress = string(v)
		}
	}

	var r Report
	switch state {
	case StateIdle, StateWorking, StateDone, StateBlocked, StateError, StateClear:
		r.State = state
	default:
		return Report{}, false
	}
	// An empty id= is the same as none.
	if id != "" {
		if !validID(id) {
			return Report{}, false
		}
		r.ID = id
	}
	switch kind {
	case "permission", "question", "auth":
		r.Kind = kind
	}
	if len(app) <= maxAppLen && validName(app) {
		r.App = app
	}
	// Atoi alone would accept signs and long zero runs.
	if len(progress) >= 1 && len(progress) <= 3 && strings.Trim(progress, "0123456789") == "" {
		if n, _ := strconv.Atoi(progress); n <= 100 {
			r.Progress, r.HasProgress = n, true
		}
	}
	r.Msg = decodeText(msg, maxMsgLen)
	r.Title = decodeText(title, maxTitleLen)
	return r, true
}

func validID(id string) bool {
	if len(id) > maxIDLen {
		return false
	}
	segs := strings.Split(id, "/")
	if len(segs) > maxIDSegments {
		return false
	}
	for _, seg := range segs {
		if len(seg) < 1 || len(seg) > maxIDSegment {
			return false
		}
		if !validName(seg) {
			return false
		}
	}
	return true
}

// validName reports whether s only has the characters of an id segment. The
// specification's pattern allows "." and ".." as segments, so they are kept.
func validName(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '_' || c == '.' || c == '+' || c == '-':
		default:
			return false
		}
	}
	return true
}

// decodeText decodes base64 text, with or without padding, to at most max
// bytes. Anything invalid yields "": a field is only useful whole.
func decodeText(s string, max int) string {
	s = strings.TrimRight(s, "=")
	if s == "" || base64.RawStdEncoding.DecodedLen(len(s)) > max {
		return ""
	}
	b, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil || !utf8.Valid(b) {
		return ""
	}
	return string(b)
}
