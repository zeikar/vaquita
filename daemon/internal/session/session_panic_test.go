package session

import (
	"bytes"
	"log"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// panicOnce panics the first time it sees OSC 4242, standing in for a
// parser bug.
type panicOnce struct {
	Sink
	hit chan struct{}
}

func (p *panicOnce) OSC(num int, payload []byte, oversized bool) {
	if num == 4242 && p.hit != nil {
		close(p.hit)
		p.hit = nil
		panic("test: sink panic")
	}
	p.Sink.OSC(num, payload, oversized)
}

// syncBuffer is a bytes.Buffer safe for the reader goroutine to log into.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureLogs sends the default slog logger's output to the returned buffer
// until the test ends.
func captureLogs(t *testing.T) *syncBuffer {
	logs := new(syncBuffer)
	prev, prevOut, prevFlags := slog.Default(), log.Writer(), log.Flags()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	// Restoring slog's default handler leaves the log package writing to
	// ours, so log is restored too.
	t.Cleanup(func() {
		slog.SetDefault(prev)
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	})
	return logs
}

func TestSessionRecoversScannerPanic(t *testing.T) {
	logs := captureLogs(t)
	ts := startSession(t, `read l; printf '\033]4242;x\007'; read l; printf after:$l; exit 0`, nil)
	hit := make(chan struct{})
	ts.Lock()
	sink := &panicOnce{Sink: ts.out.live.sink, hit: hit}
	panicking := NewScanner(sink)
	ts.out.live = panicking
	ts.Unlock()

	ts.write(t, "1\n")
	select {
	case <-hit:
	case <-time.After(testTimeout):
		t.Fatal("the sink never saw the OSC")
	}
	ts.write(t, "2\n")
	r := ts.waitExit(t)
	if !strings.Contains(r.ring, "after:2") {
		t.Errorf("output after the panic is missing: %q", tail(r.ring))
	}
	ts.Lock()
	replaced := ts.out.live != panicking
	ts.Unlock()
	if !replaced {
		t.Error("the scanner was not replaced after the panic")
	}
	if !strings.Contains(logs.String(), "test: sink panic") {
		t.Errorf("panic not logged: %q", tail(logs.String()))
	}
}

// Nothing reading the master would keep the shell from exiting, so a
// panicking OnOutput must not end the reader.
func TestSessionRecoversOnOutputPanic(t *testing.T) {
	logs := captureLogs(t)
	hit := make(chan struct{})
	var once sync.Once
	ts := startSession(t, "printf before; read l; printf after:$l; exit 0", func() {
		once.Do(func() {
			close(hit)
			panic("test: OnOutput panic")
		})
	})
	select {
	case <-hit:
	case <-time.After(testTimeout):
		t.Fatal("OnOutput was never called")
	}
	ts.write(t, "x\n")
	if r := ts.waitExit(t); !strings.Contains(r.ring, "after:x") {
		t.Errorf("output after the panic is missing: %q", tail(r.ring))
	}
	if !strings.Contains(logs.String(), "test: OnOutput panic") {
		t.Errorf("panic not logged: %q", tail(logs.String()))
	}
}
