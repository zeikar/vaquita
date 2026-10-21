package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// ErrLocked means another vaquitad already holds the instance lock.
var ErrLocked = errors.New("vaquitad already running")

// WriteAtomic writes data to path via a temp file in the same directory so
// readers never see a partial file.
func WriteAtomic(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	fail := func(err error) error {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Chmod(perm); err != nil {
		return fail(err)
	}
	// Without the sync a crash right after the rename can leave an empty file
	// where state.json used to be.
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

// LockHandle holds the instance lock for as long as its file stays open.
type LockHandle struct {
	f *os.File
}

// Lock takes a non-blocking exclusive flock on the instance lock file.
func Lock(home string) (*LockHandle, error) {
	f, err := os.OpenFile(LockPath(home), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, fmt.Errorf("lock %s: %w", LockPath(home), err)
	}
	return &LockHandle{f: f}, nil
}

// Release closes the lock file, which drops the flock. The file itself is left
// in place: a newer daemon may already hold it.
func (l *LockHandle) Release() error {
	return l.f.Close()
}

// Endpoint tells clients where the running daemon listens.
type Endpoint struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

func WriteEndpoint(home string, e Endpoint) error {
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return WriteAtomic(EndpointPath(home), data, 0o600)
}

func ReadEndpoint(home string) (Endpoint, error) {
	var e Endpoint
	data, err := os.ReadFile(EndpointPath(home))
	if err != nil {
		return e, err
	}
	if err := json.Unmarshal(data, &e); err != nil {
		return e, fmt.Errorf("parse %s: %w", EndpointPath(home), err)
	}
	return e, nil
}

// RemoveEndpointIfOwn deletes the endpoint file only if it still carries our
// token, so a daemon shutting down never removes its successor's file.
func RemoveEndpointIfOwn(home, token string) error {
	e, err := ReadEndpoint(home)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if e.Token != token {
		return nil
	}
	if err := os.Remove(EndpointPath(home)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
