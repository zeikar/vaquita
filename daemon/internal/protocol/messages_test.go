package protocol

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Zero values that carry meaning must stay on the wire: a client reads a
// missing "off" or "ro" as undefined, not as 0 or false.
func TestMessageJSON(t *testing.T) {
	cases := []struct {
		msg  any
		want string
	}{
		{Live{T: TLive, SID: 3, Gen: 7}, `{"t":"live","sid":3,"gen":7,"off":0,"ro":false}`},
		{Ack{T: TAck, SID: 3, Gen: 7}, `{"t":"ack","sid":3,"gen":7,"off":0}`},
		{
			Status{T: TStatus, SID: 3, Status: &StatusInfo{State: ViewInput, Kind: "permission", Msg: "Allow?"}, Unread: true},
			`{"t":"status","sid":3,"status":{"state":"input","kind":"permission","msg":"Allow?"},"unread":true}`,
		},
		{Status{T: TStatus, SID: 3}, `{"t":"status","sid":3,"status":null,"unread":false}`},
		{Notify{T: TNotify, SID: 3, Kind: NotifyDone, Msg: "finished"}, `{"t":"notify","sid":3,"kind":"done","msg":"finished"}`},
		{Notify{T: TNotify, Kind: NotifyMissed, Count: 2}, `{"t":"notify","kind":"missed","count":2}`},
		{Seen{T: TSeen, SID: 3}, `{"t":"seen","sid":3}`},
		{Repos{T: TRepos, List: []string{}}, `{"t":"repos","list":[]}`},
		{Repos{T: TRepos, List: []string{"/tmp/repo", "/tmp/repo-feature"}}, `{"t":"repos","list":["/tmp/repo","/tmp/repo-feature"]}`},
		{ReposList{T: TReposList}, `{"t":"repos.list"}`},
		{ReposAdd{T: TReposAdd, Path: "/tmp/repo"}, `{"t":"repos.add","path":"/tmp/repo"}`},
		{ReposRemove{T: TReposRemove, Path: "/tmp/repo"}, `{"t":"repos.remove","path":"/tmp/repo"}`},
		{Reopen{T: TReopen, SID: 7, Cols: 120, Rows: 40}, `{"t":"reopen","sid":7,"cols":120,"rows":40}`},
		{Dismiss{T: TDismiss, SID: 7}, `{"t":"dismiss","sid":7}`},
		{
			Sessions{T: TSessions, List: []SessionInfo{
				{SID: 1, Inc: "a", State: StateExited, Restorable: true},
				{SID: 2, Inc: "a", State: StateRunning},
			}},
			`{"t":"sessions","list":[` +
				`{"sid":1,"inc":"a","cwd":"","cmd":"","name":"","cols":0,"rows":0,"state":"exited","pid":0,"code":0,"restorable":true},` +
				`{"sid":2,"inc":"a","cwd":"","cmd":"","name":"","cols":0,"rows":0,"state":"running","pid":0,"code":0}]}`,
		},
		{
			Sessions{T: TSessions, List: []SessionInfo{
				{SID: 1, Inc: "a", State: StateRunning, Status: &StatusInfo{State: ViewWorking}, Unread: true},
				{SID: 2, Inc: "a", State: StateRunning},
			}},
			`{"t":"sessions","list":[` +
				`{"sid":1,"inc":"a","cwd":"","cmd":"","name":"","cols":0,"rows":0,"state":"running","pid":0,"code":0,"status":{"state":"working"},"unread":true},` +
				`{"sid":2,"inc":"a","cwd":"","cmd":"","name":"","cols":0,"rows":0,"state":"running","pid":0,"code":0}]}`,
		},
	}
	for _, c := range cases {
		b, err := json.Marshal(c.msg)
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != c.want {
			t.Errorf("Marshal(%T) = %s, want %s", c.msg, b, c.want)
		}
		got, err := ParseMessage(b)
		if err != nil {
			t.Fatalf("ParseMessage(%s): %v", b, err)
		}
		if !reflect.DeepEqual(got, c.msg) {
			t.Errorf("ParseMessage(%s) = %#v, want %#v", b, got, c.msg)
		}
	}
}
