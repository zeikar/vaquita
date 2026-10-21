package session

import (
	"log/slog"
	"runtime/debug"
)

// Go runs f in a new goroutine. A panic in f is logged with its stack and
// ends only that goroutine: an unrecovered panic would take the whole daemon
// down, and with it every session it keeps alive.
func Go(name string, f func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("goroutine panicked", "goroutine", name, "panic", r, "stack", string(debug.Stack()))
			}
		}()
		f()
	}()
}
