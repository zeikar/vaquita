package main

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

// An agreed shutdown request stops the daemon as SIGTERM does: it exits 0
// and removes its endpoint file.
func TestShutdownRequestStopsTheDaemon(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "vaquitad")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	home := t.TempDir()
	cfg, _ := json.Marshal(state.State{Shell: "/bin/sh"})
	if err := os.WriteFile(state.StatePath(home), cfg, 0o600); err != nil {
		t.Fatal(err)
	}
	daemon := exec.Command(bin, "serve")
	daemon.Env = []string{"VAQUITA_HOME=" + home, "HOME=" + t.TempDir(), "PATH=/usr/bin:/bin"}
	if err := daemon.Start(); err != nil {
		t.Fatal(err)
	}
	var waitErr error
	exited := make(chan struct{})
	go func() { waitErr = daemon.Wait(); close(exited) }()
	t.Cleanup(func() {
		select {
		case <-exited:
		default:
			daemon.Process.Kill()
			<-exited
		}
	})

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	var ep state.Endpoint
	for {
		var err error
		if ep, err = state.ReadEndpoint(home); err == nil {
			break
		}
		if ctx.Err() != nil {
			t.Fatalf("no endpoint: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	ws, _, err := websocket.Dial(ctx, ep.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if err := wsjson.Write(ctx, ws, protocol.Hello{T: protocol.THello, V: protocol.Version, Token: ep.Token, Client: protocol.ClientAttach}); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Write(ctx, ws, protocol.Shutdown{T: protocol.TShutdown, Idle: true}); err != nil {
		t.Fatal(err)
	}
	// Read on until the daemon closes the connection.
	for {
		if _, _, err := ws.Read(ctx); err != nil {
			break
		}
	}
	select {
	case <-exited:
		if waitErr != nil {
			t.Fatalf("daemon exited with %v", waitErr)
		}
	case <-ctx.Done():
		t.Fatal("daemon did not exit")
	}
	if _, err := os.Stat(state.EndpointPath(home)); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("endpoint file after the exit: %v", err)
	}
}
