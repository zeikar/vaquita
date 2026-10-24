package server

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

func TestCleanName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"  fix login  ", "fix login"},
		{"a\x1b[31mb\x07", "a[31mb"},
		{"\x01 x\u0085\x7f", "x"},
		{" \x00\t\n ", ""},
		{strings.Repeat("가", 250), strings.Repeat("가", 200)},
		// The cut can end on a space, which goes too.
		{strings.Repeat("a", 199) + " bcd", strings.Repeat("a", 199)},
	}
	for _, c := range cases {
		if got := cleanName(c.in); got != c.want {
			t.Errorf("cleanName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// A create's name is cleaned as a rename's is.
func TestCreateCleansTheName(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	sid := a.started("replay of the new session", func() error { return a.c.Create("", "", " a\x1bb\n ", 80, 24) })
	if i := a.waitListed(sid, running); i.Name != "ab" {
		t.Errorf("listed with the name %q, want %q", i.Name, "ab")
	}
	if r := savedRecord(t, srv, sid); r == nil || r.Name != "ab" {
		t.Errorf("state.json holds %+v, want the name %q", r, "ab")
	}
}

// A session is renamed running, exited or as a record from an earlier run,
// in the list and in state.json, with the name cleaned; a name that cleans to
// nothing clears it.
func TestRename(t *testing.T) {
	srv := startRecords(t, goneRecord(t, 7, t.TempDir(), "old"))
	a := dialClient(t, srv)
	run := a.create("sleep 60")
	done := a.create("exit 0")
	a.waitExit(done)

	rename := func(sid uint32, name, want string) {
		t.Helper()
		if err := a.c.Rename(sid, name); err != nil {
			t.Fatal(err)
		}
		a.waitListed(sid, func(i protocol.SessionInfo) bool { return i.Name == want })
		if r := savedRecord(t, srv, sid); r == nil || r.Name != want {
			t.Errorf("state.json holds %+v for %d, want the name %q", r, sid, want)
		}
	}
	for _, sid := range []uint32{run, done, 7} {
		want := fmt.Sprintf("session %d", sid)
		rename(sid, "  "+want+"\x1b ", want)
	}
	rename(run, " \x01 ", "")
	if len(a.errs) != 0 {
		t.Errorf("errors %+v, want none", a.errs)
	}
}

// A rename that leaves the name as it is neither saves nor sends a list.
func TestRenameUnchanged(t *testing.T) {
	rec := goneRecord(t, 7, t.TempDir(), "old")
	rec.Name = "x"
	srv := startRecords(t, rec)
	a := dialClient(t, srv)
	// A save would write it again.
	if err := os.Remove(state.StatePath(srv.opts.Home)); err != nil {
		t.Fatal(err)
	}
	n := len(a.lists)
	if err := a.c.Rename(7, " x "); err != nil {
		t.Fatal(err)
	}
	a.sync()
	if len(a.lists) != n || len(a.errs) != 0 {
		t.Errorf("got %d lists and errors %+v, want neither", len(a.lists)-n, a.errs)
	}
	if _, err := os.Stat(state.StatePath(srv.opts.Home)); !os.IsNotExist(err) {
		t.Errorf("state.json was saved (stat: %v)", err)
	}
}

func TestRenameUnknownSession(t *testing.T) {
	srv := startSessionServer(t, Options{})
	a := dialClient(t, srv)
	wantErr(t, "rename", answer(a, func() error { return a.c.Rename(99, "x") }), protocol.CodeNoSession, 99)
}

// A renamed record reopens under its new name. One whose name was cleared
// reopens as one that never had a name: titled by its agent until the agent
// gives a title.
func TestRenamedRecordReopens(t *testing.T) {
	named := goneRecord(t, 7, t.TempDir(), "claude")
	cleared := goneRecord(t, 8, t.TempDir(), "claude")
	cleared.Name = "w"
	srv := startRecords(t, named, cleared)
	stubAgents(t)
	a := dialClient(t, srv)
	for sid, name := range map[uint32]string{7: "fix login", 8: ""} {
		if err := a.c.Rename(sid, name); err != nil {
			t.Fatal(err)
		}
		a.waitListed(sid, func(i protocol.SessionInfo) bool { return i.Name == name })
	}

	cases := []struct {
		record      uint32
		name, title string
	}{
		{7, "fix login", ""},
		{8, "", "claude"},
	}
	for _, c := range cases {
		sid := a.reopen(c.record, 80, 24)
		if i := a.waitListed(sid, running); i.Name != c.name || i.Title != c.title {
			t.Errorf("record %d reopened listed with name %q and title %q, want %q and %q", c.record, i.Name, i.Title, c.name, c.title)
		}
		if r := savedRecord(t, srv, sid); r == nil || r.Name != c.name || r.Title != c.title {
			t.Errorf("state.json holds %+v for record %d's new session, want name %q and title %q", r, c.record, c.name, c.title)
		}
	}
}

// A rename that lands while a reopen is starting is kept, and the stand-in
// title follows the name the record has when the new session takes its place.
func TestRenameDuringReopen(t *testing.T) {
	named := goneRecord(t, 7, t.TempDir(), "claude")
	cleared := goneRecord(t, 8, t.TempDir(), "claude")
	cleared.Name = "w"
	srv := startRecords(t, named, cleared)
	stubAgents(t)
	a := dialClient(t, srv)
	srv.table.mu.Lock()
	var reopener *conn
	for c := range srv.table.clients {
		reopener = c
	}
	srv.table.mu.Unlock()

	cases := []struct {
		record      uint32
		name, title string
	}{
		{7, "fix login", ""},
		{8, "", "claude"},
	}
	for _, c := range cases {
		sid := a.started("replay of the reopened session", func() error {
			// From reading the record to swapping it out, a reopen takes
			// its connection's lock only to add the subscription, so holding
			// it stops the reopen in between. Nothing holds t.mu waiting for
			// that lock meanwhile: no session is listed and nothing else is
			// sent.
			reopener.mu.Lock()
			defer reopener.mu.Unlock()
			if err := a.c.Reopen(c.record, 80, 24); err != nil {
				return err
			}
			deadline := time.Now().Add(sessTimeout)
			for {
				srv.table.mu.Lock()
				e := srv.table.entries[c.record]
				started := e != nil && e.reopening
				if started {
					e.rec.Name = c.name
				}
				srv.table.mu.Unlock()
				if started {
					return nil
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("record %d: no reopen within %v", c.record, sessTimeout)
				}
				time.Sleep(time.Millisecond)
			}
		})
		if i := a.waitListed(sid, running); i.Name != c.name || i.Title != c.title {
			t.Errorf("record %d reopened listed with name %q and title %q, want %q and %q", c.record, i.Name, i.Title, c.name, c.title)
		}
		if r := savedRecord(t, srv, sid); r == nil || r.Name != c.name || r.Title != c.title {
			t.Errorf("state.json holds %+v for record %d's new session, want name %q and title %q", r, c.record, c.name, c.title)
		}
	}
}
