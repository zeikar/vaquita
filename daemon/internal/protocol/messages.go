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
	TStatus      = "status"
	TNotify      = "notify"
	TSeen        = "seen"

	TReposList   = "repos.list"
	TReposAdd    = "repos.add"
	TReposRemove = "repos.remove"
	TRepos       = "repos"
	TReopen      = "reopen"
	TDismiss     = "dismiss"
	TShutdown    = "shutdown"
	TRename      = "rename"
)

// Error codes.
const (
	CodeVersion       = "version"
	CodeNoSession     = "no-session"
	CodeInputOverflow = "input-overflow"
	CodeBadRequest    = "bad-request"
	CodeOrphans       = "orphans"

	CodeBadPath          = "bad-path"
	CodeConversationLive = "conversation-live"
	CodeBusy             = "busy"
)

// Session states in SessionInfo.
const (
	StateRunning = "running"
	StateExited  = "exited"
)

// View states a sidebar row can show (StatusInfo.State).
const (
	ViewWorking = "working"
	ViewInput   = "input"
	ViewAuth    = "auth"
	ViewDone    = "done"
	ViewError   = "error"
)

// Notification kinds in Notify. NotifyMissed summarizes the notifications
// that fell while no GUI was connected.
const (
	NotifyDone   = "done"
	NotifyError  = "error"
	NotifyInput  = "input"
	NotifyAuth   = "auth"
	NotifyMissed = "missed"
)

// Hello is the first message of a connection in both directions. The client
// sends V, Token and Client; the daemon answers with V and its Build, which
// an older daemon leaves out.
type Hello struct {
	T      string `json:"t"`
	V      int    `json:"v"`
	Token  string `json:"token,omitempty"`
	Client string `json:"client,omitempty"`
	Build  string `json:"build,omitempty"`
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
// CodeOrphans. CodeBadPath answers a repos.add whose path is not an absolute
// directory; CodeConversationLive answers a reopen of a record whose agent
// conversation is open in another session.
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
	// Restorable marks a record from an earlier daemon run: no PTY here and
	// no orphans, so Reopen and Dismiss accept it.
	Restorable bool `json:"restorable,omitempty"`
	// Title is the title the agent gave the session as its window title,
	// Claude Code's topic or Codex's thread name (see
	// state.SessionRecord.Title); left out when there is none, which is
	// all an older daemon ever sends. A row is titled by its Name, else this,
	// else its Cmd.
	Title string `json:"title,omitempty"`
	// Agent is the agent kind the record keeps, claude or codex (see
	// state.SessionRecord.Agent); left out when there is none, which is all
	// an older daemon ever sends. The app picks a row's icon by it, else by
	// the first word of Cmd.
	Agent string `json:"agent,omitempty"`
	// Status and Unread are left out when the row shows nothing, which is
	// all an older daemon ever sends.
	Status *StatusInfo `json:"status,omitempty"`
	Unread bool        `json:"unread,omitempty"`
}

// StatusInfo is what a session's row shows. Kind (permission or question)
// refines the input and auth states; Msg is the text to show.
type StatusInfo struct {
	State string `json:"state"`
	Kind  string `json:"kind,omitempty"`
	Msg   string `json:"msg,omitempty"`
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

// Status reports a change of one session's row. A null Status clears it, so
// neither field is left out.
type Status struct {
	T      string      `json:"t"`
	SID    uint32      `json:"sid"`
	Status *StatusInfo `json:"status"`
	Unread bool        `json:"unread"`
}

// Notify asks the GUI for a notification. It names a session, except for
// NotifyMissed, which carries the Count of notifications instead.
type Notify struct {
	T     string `json:"t"`
	SID   uint32 `json:"sid,omitempty"`
	Kind  string `json:"kind"`
	Msg   string `json:"msg,omitempty"`
	Count int    `json:"count,omitempty"`
}

// Seen tells the daemon the user has looked at a session.
type Seen struct {
	T   string `json:"t"`
	SID uint32 `json:"sid"`
}

// ReposList asks for the repo list; the daemon answers the requester with
// Repos.
type ReposList struct {
	T string `json:"t"`
}

// ReposAdd registers the absolute directory Path as a repo.
type ReposAdd struct {
	T    string `json:"t"`
	Path string `json:"path"`
}

// ReposRemove unregisters a repo. Sessions under it are not touched.
type ReposRemove struct {
	T    string `json:"t"`
	Path string `json:"path"`
}

// Repos is the registered repo list. Senders pass a non-nil List so that an
// empty one shows as [] on the wire, never null.
type Repos struct {
	T    string   `json:"t"`
	List []string `json:"list"`
}

// Reopen starts a new session from the restorable record SID, like a Create;
// the connection that sent it is subscribed to the new session.
type Reopen struct {
	T    string `json:"t"`
	SID  uint32 `json:"sid"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// Dismiss removes the record SID of a session from an earlier daemon run.
type Dismiss struct {
	T   string `json:"t"`
	SID uint32 `json:"sid"`
}

// Rename names session SID, running or exited, or the record of one from an
// earlier daemon run; an empty Name clears the name. A change shows in the
// next Sessions list; an unknown SID is answered with CodeNoSession.
type Rename struct {
	T    string `json:"t"`
	SID  uint32 `json:"sid"`
	Name string `json:"name"`
}

// Shutdown asks the daemon to stop as it does on SIGTERM; the app sends it to
// replace an outdated daemon with its own. With Idle it stops only when no
// session is running or starting, and answers CodeBusy otherwise. Once it has
// agreed it starts no more sessions, and its closing every connection is the
// answer.
type Shutdown struct {
	T    string `json:"t"`
	Idle bool   `json:"idle"`
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
	case TStatus:
		return parse[Status](data)
	case TNotify:
		return parse[Notify](data)
	case TSeen:
		return parse[Seen](data)
	case TReposList:
		return parse[ReposList](data)
	case TReposAdd:
		return parse[ReposAdd](data)
	case TReposRemove:
		return parse[ReposRemove](data)
	case TRepos:
		return parse[Repos](data)
	case TReopen:
		return parse[Reopen](data)
	case TDismiss:
		return parse[Dismiss](data)
	case TShutdown:
		return parse[Shutdown](data)
	case TRename:
		return parse[Rename](data)
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
