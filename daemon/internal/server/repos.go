package server

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
)

// repoPath returns p cleaned if it names an existing directory.
func repoPath(p string) (string, error) {
	if !filepath.IsAbs(p) {
		return "", errors.New("not an absolute path")
	}
	p = filepath.Clean(p)
	fi, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if !fi.IsDir() {
		return "", fmt.Errorf("%s is not a directory", p)
	}
	return p, nil
}

// reposLocked returns a copy of the repo list, never nil so it encodes as
// an array. t.mu must be held.
func (t *table) reposLocked() []string {
	return append([]string{}, t.st.Repos...)
}

func (t *table) sendReposLocked(c *conn) {
	c.send(protocol.Repos{T: protocol.TRepos, List: t.reposLocked()})
}

// reposChangedLocked sends the list to every GUI and to c, the requester.
// An attach client is sent it only as the answer to its own request: an
// older one closes the connection on a message type it does not know.
func (t *table) reposChangedLocked(c *conn) {
	for g := range t.clients {
		if g.client == protocol.ClientGUI {
			t.sendReposLocked(g)
		}
	}
	if c.client != protocol.ClientGUI {
		t.sendReposLocked(c)
	}
}

func (c *conn) reposList() {
	t := c.srv.table
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sendReposLocked(c)
}

func (c *conn) reposAdd(m protocol.ReposAdd) {
	// The stat may be slow, so it runs before t.mu is taken.
	p, err := repoPath(m.Path)
	if err != nil {
		slog.Info("repo refused", "path", m.Path, "err", err)
		c.send(protocol.Error{T: protocol.TError, Code: protocol.CodeBadPath})
		return
	}
	t := c.srv.table
	t.mu.Lock()
	defer t.mu.Unlock()
	i, found := slices.BinarySearch(t.st.Repos, p)
	if found {
		t.sendReposLocked(c)
		return
	}
	t.st.Repos = slices.Insert(t.st.Repos, i, p)
	slog.Info("repo added", "path", p)
	t.saveLocked()
	t.reposChangedLocked(c)
}

func (c *conn) reposRemove(m protocol.ReposRemove) {
	// No stat: a folder that is gone must still be removable.
	p := filepath.Clean(m.Path)
	t := c.srv.table
	t.mu.Lock()
	defer t.mu.Unlock()
	i, found := slices.BinarySearch(t.st.Repos, p)
	if !found {
		t.sendReposLocked(c)
		return
	}
	t.st.Repos = slices.Delete(t.st.Repos, i, i+1)
	slog.Info("repo removed", "path", p)
	t.saveLocked()
	t.reposChangedLocked(c)
}
