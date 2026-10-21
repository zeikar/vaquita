package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/zeikar/vaquita/daemon/internal/server"
	"github.com/zeikar/vaquita/daemon/internal/session"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

// originList collects repeated --allow-origin values.
type originList []string

func (o *originList) String() string { return strings.Join(*o, ",") }

// Set insists on one exact origin. The values become coder/websocket
// origin patterns, which are path.Match globs and, without a scheme, match
// the host under any scheme.
func (o *originList) Set(v string) error {
	if strings.ContainsAny(v, `*?[]\`) {
		return fmt.Errorf("%q: origins are matched as glob patterns, so *?[]\\ could admit more than one; give one exact origin such as http://localhost:1420", v)
	}
	u, err := url.Parse(v)
	if err != nil || u.Scheme == "" || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("%q is not an origin such as http://localhost:1420", v)
	}
	*o = append(*o, v)
	return nil
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var allow originList
	fs.Var(&allow, "allow-origin", "also accept WebSocket connections from this browser `origin` (repeatable)")
	fs.Parse(args)
	if fs.NArg() > 0 {
		return fmt.Errorf("serve: unexpected argument %q", fs.Arg(0))
	}

	// Registered before anything is set up so a signal during startup still
	// runs the deferred cleanup instead of killing the process mid-setup.
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
	// Sessions and recovered goroutine panics log through the default
	// logger; they belong in vaquitad.log too.
	slog.SetDefault(log)
	defer func() {
		if err := lock.Release(); err != nil {
			log.Warn("release lock", "err", err)
		}
	}()
	log.Info("vaquitad started", "home", home, "pid", os.Getpid())

	st, err := state.Load(home)
	if err != nil {
		// Left in place for inspection; Load fell back to the defaults.
		log.Error("load state", "err", err)
	} else if err := pruneState(log, home, &st); err != nil {
		return err
	}

	token := server.NewToken()
	srv, err := server.Listen(server.Options{Token: token, AllowOrigins: allow, Shell: st.Shell, State: st})
	if err != nil {
		return err
	}
	defer func() {
		if err := srv.Close(); err != nil {
			log.Warn("close server", "err", err)
		}
		if err := state.RemoveEndpointIfOwn(home, token); err != nil {
			log.Warn("remove endpoint", "err", err)
		}
	}()
	if err := state.WriteEndpoint(home, state.Endpoint{URL: srv.URL(), Token: token, PID: os.Getpid()}); err != nil {
		return fmt.Errorf("write endpoint: %w", err)
	}
	log.Info("vaquitad listening", "url", srv.URL(), "allow_origins", allow)

	s := <-sig
	log.Info("vaquitad stopping", "signal", s.String())
	return nil
}

// pruneState drops the records of sessions from a previous run that are
// gone, reports the ones that are not, and saves the result.
func pruneState(log *slog.Logger, home string, st *state.State) error {
	kept, err := st.PruneDead(session.SessionPIDs)
	if err != nil {
		log.Warn("scan sessions from the previous run; their records are kept", "err", err)
	}
	for _, r := range kept {
		log.Warn("session from the previous run still has processes", "sid", r.SID, "pid", r.PID, "cwd", r.Cwd, "orphans", r.Orphans)
	}
	if err := st.Save(home); err != nil {
		return fmt.Errorf("save state: %w", err)
	}
	return nil
}
