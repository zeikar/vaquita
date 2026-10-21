package main

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/zeikar/vaquita/daemon/internal/state"
)

func serve() error {
	// Registered first so a signal during startup still runs the deferred
	// cleanup instead of killing the process mid-setup.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	home, err := state.Home()
	if err != nil {
		return err
	}
	lock, err := state.Lock(home)
	if errors.Is(err, state.ErrLocked) {
		return fmt.Errorf("vaquitad already running for %s", home)
	}
	if err != nil {
		return err
	}

	logFile, err := os.OpenFile(state.LogPath(home), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		lock.Release()
		return fmt.Errorf("open log: %w", err)
	}
	defer logFile.Close()
	log := slog.New(slog.NewTextHandler(io.MultiWriter(os.Stderr, logFile), nil))
	defer func() {
		if err := lock.Release(); err != nil {
			log.Warn("release lock", "err", err)
		}
	}()

	log.Info("vaquitad started", "home", home, "pid", os.Getpid())
	s := <-sig
	log.Info("vaquitad stopping", "signal", s.String())
	return nil
}
