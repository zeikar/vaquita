package server

import (
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
)

// requestShutdown sends a shutdown on a connection of its own.
func requestShutdown(t *testing.T, srv *Server, idle bool) *websocket.Conn {
	t.Helper()
	ws := mustDial(t, srv, "")
	handshake(t, ws)
	writeJSON(t, ws, protocol.Shutdown{T: protocol.TShutdown, Idle: idle})
	return ws
}

func wantBusy(t *testing.T, srv *Server, ws *websocket.Conn) {
	t.Helper()
	for {
		if e, ok := readMessage(t, ws).(protocol.Error); ok {
			if e.Code != protocol.CodeBusy {
				t.Fatalf("answer = %+v, want %q", e, protocol.CodeBusy)
			}
			break
		}
	}
	select {
	case <-srv.Stopping():
		t.Fatal("the refused shutdown stopped the daemon")
	default:
	}
}

func wantStopping(t *testing.T, srv *Server) {
	t.Helper()
	select {
	case <-srv.Stopping():
	case <-time.After(sessTimeout):
		t.Fatal("the shutdown was not agreed to")
	}
}

func TestIdleShutdownIsRefusedWhileASessionRuns(t *testing.T) {
	srv := startSessionServer(t, Options{})
	tc := dialClient(t, srv)
	tc.create("")
	wantBusy(t, srv, requestShutdown(t, srv, true))
	// The daemon goes on as before.
	tc.create("")
}

func TestIdleShutdownIsRefusedWhileASessionStarts(t *testing.T) {
	srv := startSessionServer(t, Options{})
	// As between beginStart and the session's listing.
	srv.table.mu.Lock()
	srv.table.starting++
	srv.table.mu.Unlock()
	wantBusy(t, srv, requestShutdown(t, srv, true))
	srv.table.mu.Lock()
	srv.table.starting--
	srv.table.mu.Unlock()
}

// Records of an earlier run and exited sessions hold no process of the
// daemon's, so an idle shutdown goes ahead; nothing starts after it.
func TestIdleShutdownStopsNewSessions(t *testing.T) {
	srv := startRecords(t, goneRecord(t, 7, "/tmp", ""))
	tc := dialClient(t, srv)
	tc.waitExit(tc.create("exit 3"))
	requestShutdown(t, srv, true)
	wantStopping(t, srv)

	wantErr(t, "create", answer(tc, func() error { return tc.c.Create("", "", "", 80, 24) }), protocol.CodeBadRequest, 0)
	wantErr(t, "reopen", answer(tc, func() error { return tc.c.Reopen(7, 80, 24) }), protocol.CodeBadRequest, 7)
	srv.table.mu.Lock()
	reopening := srv.table.entries[7].reopening
	srv.table.mu.Unlock()
	if reopening {
		t.Error("the refused reopen left the record marked as reopening")
	}
}

func TestForcedShutdownGoesAheadWithRunningSessions(t *testing.T) {
	srv := startSessionServer(t, Options{})
	tc := dialClient(t, srv)
	tc.create("")
	requestShutdown(t, srv, false)
	wantStopping(t, srv)
}
