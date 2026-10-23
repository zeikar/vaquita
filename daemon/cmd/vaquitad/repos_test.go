package main

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/client"
	"github.com/zeikar/vaquita/daemon/internal/protocol"
)

func TestParseRepos(t *testing.T) {
	wantRel, err := filepath.Abs("sub/dir")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		args []string
		want reposCmd
		bad  bool
	}{
		{name: "ls", args: []string{"ls"}, want: reposCmd{op: "ls"}},
		{name: "add relative", args: []string{"add", "sub/dir"}, want: reposCmd{op: "add", path: wantRel}},
		{name: "rm", args: []string{"rm", "/tmp/repo"}, want: reposCmd{op: "rm", path: "/tmp/repo"}},
		{name: "no args", args: nil, bad: true},
		{name: "add without dir", args: []string{"add"}, bad: true},
		{name: "rm with two dirs", args: []string{"rm", "/a", "/b"}, bad: true},
		{name: "ls with argument", args: []string{"ls", "x"}, bad: true},
		{name: "unknown op", args: []string{"drop", "/tmp/repo"}, bad: true},
	} {
		got, err := parseRepos(tc.args)
		if tc.bad {
			if err == nil {
				t.Errorf("%s: want an error, got %+v", tc.name, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%s: got %+v, %v; want %+v", tc.name, got, err, tc.want)
		}
	}
}

func eventsOf(closed bool, msgs ...any) <-chan client.Event {
	ch := make(chan client.Event, len(msgs))
	for _, m := range msgs {
		ch <- client.Event{Msg: m}
	}
	if closed {
		close(ch)
	}
	return ch
}

func TestAwaitRepos(t *testing.T) {
	list := []string{"/tmp/repo", "/tmp/repo-feature"}
	got, err := awaitRepos(eventsOf(false,
		protocol.Sessions{T: protocol.TSessions},
		protocol.Repos{T: protocol.TRepos, List: list}), time.Second)
	if err != nil || !reflect.DeepEqual(got, list) {
		t.Errorf("sessions then repos: got %v, %v", got, list)
	}

	for _, tc := range []struct{ code, want string }{
		{protocol.CodeBadPath, "not an absolute path to an existing directory"},
		{protocol.CodeBadRequest, "vaquitad does not know repos (an older daemon?)"},
		{"other-code", "other-code"},
	} {
		_, err := awaitRepos(eventsOf(false, protocol.Error{T: protocol.TError, Code: tc.code}), time.Second)
		if err == nil || err.Error() != tc.want {
			t.Errorf("code %s: got %v, want %q", tc.code, err, tc.want)
		}
	}

	if _, err := awaitRepos(eventsOf(true), time.Second); err == nil || err.Error() != "connection closed" {
		t.Errorf("closed channel: got %v", err)
	}
	if _, err := awaitRepos(eventsOf(false), 20*time.Millisecond); err == nil || err.Error() != "no answer from vaquitad" {
		t.Errorf("timeout: got %v", err)
	}
}
