package server

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

func savedRepos(t *testing.T, srv *Server) []string {
	t.Helper()
	st, err := state.Load(srv.opts.Home)
	if err != nil {
		t.Fatal(err)
	}
	return st.Repos
}

func TestReposSentToGUIOnJoinAndOnRequest(t *testing.T) {
	srv := listen(t, Options{State: state.State{Repos: []string{"/tmp"}}})

	gui := dialClient(t, srv)
	gui.waitRepos(func([]string) bool { return true })
	if len(gui.repos) != 1 || !slices.Equal(gui.repos[0], []string{"/tmp"}) {
		t.Fatalf("repos on join = %v, want one list [/tmp]", gui.repos)
	}

	att := dialKind(t, srv, protocol.ClientAttach)
	att.sync()
	if len(att.repos) != 0 {
		t.Fatalf("attach client was sent %v on join", att.repos)
	}
	if err := att.c.ReposList(); err != nil {
		t.Fatal(err)
	}
	if got := att.waitRepos(func([]string) bool { return true }); !slices.Equal(got, []string{"/tmp"}) {
		t.Fatalf("answer to repos.list = %v", got)
	}
}

func TestReposAddKeepsSortedAndSaved(t *testing.T) {
	srv := startServer(t)
	a, b := dialClient(t, srv), dialClient(t, srv)
	a.waitRepos(func([]string) bool { return true })
	b.waitRepos(func([]string) bool { return true })

	dir := t.TempDir()
	pa, pb := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	for _, p := range []string{pa, pb} {
		if err := os.Mkdir(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.c.ReposAdd(pb); err != nil {
		t.Fatal(err)
	}
	want := []string{pb}
	for _, tc := range []*tclient{a, b} {
		if got := tc.waitRepos(func(l []string) bool { return len(l) == 1 }); !slices.Equal(got, want) {
			t.Fatalf("after first add: %v, want %v", got, want)
		}
	}
	if err := a.c.ReposAdd(pa); err != nil {
		t.Fatal(err)
	}
	want = []string{pa, pb}
	for _, tc := range []*tclient{a, b} {
		if got := tc.waitRepos(func(l []string) bool { return len(l) == 2 }); !slices.Equal(got, want) {
			t.Fatalf("after second add: %v, want %v", got, want)
		}
	}
	if got := savedRepos(t, srv); !slices.Equal(got, want) {
		t.Fatalf("state.json repos = %v, want %v", got, want)
	}

	// Adding a known path answers the requester and nobody else.
	nb := len(b.repos)
	na := len(a.repos)
	if err := a.c.ReposAdd(pa); err != nil {
		t.Fatal(err)
	}
	a.waitFor("answer to the repeated add", func() bool { return len(a.repos) == na+1 })
	b.sync()
	if len(b.repos) != nb {
		t.Fatalf("GUI B was sent %d lists for an unchanged add", len(b.repos)-nb)
	}

	// Removing it tells both; an unknown path only the requester.
	if err := a.c.ReposRemove(pa); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []*tclient{a, b} {
		if got := tc.waitRepos(func(l []string) bool { return len(l) == 1 }); !slices.Equal(got, []string{pb}) {
			t.Fatalf("after remove: %v", got)
		}
	}
	if got := savedRepos(t, srv); !slices.Equal(got, []string{pb}) {
		t.Fatalf("state.json repos after remove = %v", got)
	}
	nb, na = len(b.repos), len(a.repos)
	if err := a.c.ReposRemove(pa); err != nil {
		t.Fatal(err)
	}
	a.waitFor("answer to the unknown remove", func() bool { return len(a.repos) == na+1 })
	b.sync()
	if len(b.repos) != nb {
		t.Fatalf("GUI B was sent %d lists for an unknown remove", len(b.repos)-nb)
	}
}

func TestReposAddRefusesBadPaths(t *testing.T) {
	srv := startServer(t)
	gui := dialClient(t, srv)
	gui.waitRepos(func([]string) bool { return true })
	n := len(gui.repos)

	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"relative/path", filepath.Join(t.TempDir(), "missing"), file} {
		gui.errs = nil
		if err := gui.c.ReposAdd(p); err != nil {
			t.Fatal(err)
		}
		gui.waitFor("bad-path", func() bool { return len(gui.errs) > 0 })
		if gui.errs[0].Code != protocol.CodeBadPath {
			t.Fatalf("%q: error %+v, want bad-path", p, gui.errs[0])
		}
	}
	gui.sync()
	if len(gui.repos) != n {
		t.Fatalf("a refused add sent %d lists", len(gui.repos)-n)
	}
}

// A clean path is stored as given; one with ".." is stored as its real path,
// which is where the kernel goes through a symlink, not where a lexical clean
// would.
func TestReposAddStoresRealPathOfUncleanPath(t *testing.T) {
	srv := startServer(t)
	gui := dialClient(t, srv)
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	for i, tc := range []struct{ add, want string }{
		{link, link},
		{link + "/..", filepath.Join(root, "a")},
	} {
		if err := gui.c.ReposAdd(tc.add); err != nil {
			t.Fatal(err)
		}
		got := gui.waitRepos(func(l []string) bool { return len(l) == i+1 })
		if !slices.Contains(got, tc.want) {
			t.Fatalf("add %q: stored %v, want %q among them", tc.add, got, tc.want)
		}
	}
}

func TestReposReachAttachClientOnlyAsItsAnswer(t *testing.T) {
	srv := startServer(t)
	gui := dialClient(t, srv)
	gui.waitRepos(func([]string) bool { return true })
	att := dialKind(t, srv, protocol.ClientAttach)

	d1, d2 := t.TempDir(), t.TempDir()
	if err := att.c.ReposAdd(d1); err != nil {
		t.Fatal(err)
	}
	att.waitRepos(func(l []string) bool { return len(l) == 1 })
	gui.waitRepos(func(l []string) bool { return len(l) == 1 })
	att.sync()
	gui.sync()
	if len(att.repos) != 1 || len(gui.repos) != 2 {
		t.Fatalf("attach got %d lists, GUI got %d; want 1 and 2 (join + change)", len(att.repos), len(gui.repos))
	}

	if err := gui.c.ReposAdd(d2); err != nil {
		t.Fatal(err)
	}
	gui.waitRepos(func(l []string) bool { return len(l) == 2 })
	att.sync()
	if len(att.repos) != 1 {
		t.Fatalf("attach client was sent a list it did not ask for: %v", att.repos)
	}
}
