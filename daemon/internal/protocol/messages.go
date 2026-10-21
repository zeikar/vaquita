// Package protocol defines what vaquitad and its clients exchange over their
// single WebSocket: JSON control messages in text frames, keyed by "t", and
// session data in binary frames.
package protocol

import (
	"encoding/json"
	"fmt"
)

// Version is compared in the hello; a daemon and client that disagree do not
// talk further.
const Version = 1

// MaxMessage is the read limit both ends set. coder/websocket's default of
// 32KB is below a full binary frame and a long sessions list.
const MaxMessage = 1 << 20

// Client kinds a hello declares. Which subscriber may write to a session
// depends on them.
const (
	ClientGUI    = "gui"
	ClientAttach = "attach"
)

// Message types, the "t" field.
const (
	THello       = "hello"
	TCreate      = "create"
	TSubscribe   = "subscribe"
	TUnsubscribe = "unsubscribe"
	TAck         = "ack"
	TResize      = "resize"
	TKill        = "kill"
	TError       = "error"
	TSessions    = "sessions"
	TReplay      = "replay"
	TLive        = "live"
	TExit        = "exit"
)

// Error codes.
const (
	CodeVersion       = "version"
	CodeNoSession     = "no-session"
	CodeInputOverflow = "input-overflow"
	CodeBadRequest    = "bad-request"
	CodeOrphans       = "orphans"
)

// Session states in SessionInfo.
const (
	StateRunning = "running"
	StateExited  = "exited"
)

// Hello is the first message of a connection in both directions. The client
// sends V, Token and Client; the daemon answers with V alone.
type Hello struct {
	T      string `json:"t"`
	V      int    `json:"v"`
	Token  string `json:"token,omitempty"`
	Client string `json:"client,omitempty"`
}

// Create starts a session; the connection that sent it is subscribed to it.
type Create struct {
	T    string `json:"t"`
	Cwd  string `json:"cwd,omitempty"`
	Cmd  string `json:"cmd,omitempty"`
	Name string `json:"name,omitempty"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type Subscribe struct {
	T   string `json:"t"`
	SID uint32 `json:"sid"`
}

type Unsubscribe struct {
	T   string `json:"t"`
	SID uint32 `json:"sid"`
}

// Ack reports how far the client has consumed a session's output, as a ring
// offset within generation Gen.
type Ack struct {
	T   string `json:"t"`
	SID uint32 `json:"sid"`
	Gen uint32 `json:"gen"`
	Off uint64 `json:"off"`
}

type Resize struct {
	T    string `json:"t"`
	SID  uint32 `json:"sid"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type Kill struct {
	T   string `json:"t"`
	SID uint32 `json:"sid"`
}

// Error reports a failed request. V is set for CodeVersion, PIDs for
// CodeOrphans.
type Error struct {
	T    string `json:"t"`
	Code string `json:"code"`
	V    int    `json:"v,omitempty"`
	// SID is left out for errors not about a session; session ids start
	// at 1, so zero never names one.
	SID  uint32 `json:"sid,omitempty"`
	PIDs []int  `json:"pids,omitempty"`
}

// SessionInfo describes one session in a Sessions list.
type SessionInfo struct {
	SID uint32 `json:"sid"`
	// Inc tells apart sessions that got the same SID from different daemon
	// runs.
	Inc   string `json:"inc"`
	Cwd   string `json:"cwd"`
	Cmd   string `json:"cmd"`
	Name  string `json:"name"`
	Cols  int    `json:"cols"`
	Rows  int    `json:"rows"`
	State string `json:"state"`
	PID   int    `json:"pid"`
	Code  int    `json:"code"` // exit code; meaningful once State is StateExited
	// Orphans are processes left in the session's PTY session after its
	// shell exited.
	Orphans []int `json:"orphans,omitempty"`
}

// Sessions is the full session list, sent after the hello and on changes.
type Sessions struct {
	T    string        `json:"t"`
	List []SessionInfo `json:"list"`
}

// Replay announces the replay of ring offsets [From, To) in generation Gen.
// FrameReplay frames follow, the first carrying the mode prefix.
type Replay struct {
	T    string `json:"t"`
	SID  uint32 `json:"sid"`
	Gen  uint32 `json:"gen"`
	From uint64 `json:"from"`
	To   uint64 `json:"to"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// Live ends a replay; output from Off on comes in FrameLive frames. RO is set
// when this subscriber may not write to the session.
type Live struct {
	T   string `json:"t"`
	SID uint32 `json:"sid"`
	Gen uint32 `json:"gen"`
	Off uint64 `json:"off"`
	RO  bool   `json:"ro"`
}

// Exit reports that the session's shell exited, after its last output.
type Exit struct {
	T    string `json:"t"`
	SID  uint32 `json:"sid"`
	Code int    `json:"code"`
}

// ParseMessage decodes a text frame into the message struct its "t" names,
// returned by value.
func ParseMessage(data []byte) (any, error) {
	var head struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("parse message: %w", err)
	}
	switch head.T {
	case THello:
		return parse[Hello](data)
	case TCreate:
		return parse[Create](data)
	case TSubscribe:
		return parse[Subscribe](data)
	case TUnsubscribe:
		return parse[Unsubscribe](data)
	case TAck:
		return parse[Ack](data)
	case TResize:
		return parse[Resize](data)
	case TKill:
		return parse[Kill](data)
	case TError:
		return parse[Error](data)
	case TSessions:
		return parse[Sessions](data)
	case TReplay:
		return parse[Replay](data)
	case TLive:
		return parse[Live](data)
	case TExit:
		return parse[Exit](data)
	}
	return nil, fmt.Errorf("parse message: unknown type %q", head.T)
}

func parse[M any](data []byte) (any, error) {
	var m M
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse %T: %w", m, err)
	}
	return m, nil
}
