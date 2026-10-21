package state

import (
	"errors"
	"os"
	"testing"
)

func TestWriteEndpointMode(t *testing.T) {
	home := t.TempDir()
	want := Endpoint{URL: "ws://127.0.0.1:1234/ws", Token: "tok", PID: 42}
	if err := WriteEndpoint(home, want); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(EndpointPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", fi.Mode().Perm())
	}
	got, err := ReadEndpoint(home)
	if err != nil || got != want {
		t.Fatalf("ReadEndpoint = %+v, %v; want %+v", got, err, want)
	}
}

func TestLockContention(t *testing.T) {
	home := t.TempDir()
	first, err := Lock(home)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Lock(home); !errors.Is(err, ErrLocked) {
		t.Fatalf("second Lock err = %v, want ErrLocked", err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(LockPath(home)); err != nil {
		t.Fatalf("lock file removed on release: %v", err)
	}
	again, err := Lock(home)
	if err != nil {
		t.Fatalf("Lock after Release: %v", err)
	}
	again.Release()
}

func TestRemoveEndpointIfOwn(t *testing.T) {
	home := t.TempDir()
	if err := WriteEndpoint(home, Endpoint{URL: "u", Token: "other", PID: 1}); err != nil {
		t.Fatal(err)
	}
	if err := RemoveEndpointIfOwn(home, "mine"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(EndpointPath(home)); err != nil {
		t.Fatalf("foreign endpoint was removed: %v", err)
	}
	if err := RemoveEndpointIfOwn(home, "other"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(EndpointPath(home)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("own endpoint still present: %v", err)
	}
	if err := RemoveEndpointIfOwn(home, "other"); err != nil {
		t.Fatalf("missing endpoint should be a no-op: %v", err)
	}
}
