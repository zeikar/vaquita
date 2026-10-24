package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

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
	log.Info("vaquitad started", "home", home, "pid", os.Getpid(), "build", version)

	st, err := loadState(log, home)
	if err != nil {
		return err
	}

	token := server.NewToken()
	srv, err := server.Listen(server.Options{Token: token, AllowOrigins: allow, Shell: st.Shell, Home: home, State: st, Build: version})
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

	select {
	case s := <-sig:
		log.Info("vaquitad stopping", "signal", s.String())
	case <-srv.Stopping():
		log.Info("vaquitad stopping", "reason", "shutdown request")
	}
	return nil
}

// loadState reads state.json and rescans the records of sessions from the
// previous run, which stay listed as restorable once they hold no processes.
// A file that cannot be loaded is moved aside for inspection and the
// daemon starts from the defaults: every change to the sessions saves
// state.json, which would overwrite it and lose the records and settings it
// holds, even when the failure was only a passing read error. If it cannot
// be moved aside, the daemon does not start.
func loadState(log *slog.Logger, home string) (state.State, error) {
	st, err := state.Load(home)
	if err == nil {
		return st, rescanState(log, home, &st, session.SessionPIDs)
	}
	path := state.StatePath(home)
	aside := fmt.Sprintf("%s.bad-%d", path, time.Now().Unix())
	if rerr := os.Rename(path, aside); errors.Is(rerr, fs.ErrNotExist) {
		log.Error("load state; the file has gone since", "err", err)
	} else if rerr != nil {
		return st, fmt.Errorf("load state: %w; cannot move it aside, so it is not overwritten: %w", err, rerr)
	} else {
		log.Error("load state; moved it aside and starting from the defaults", "err", err, "moved_to", aside)
	}
	return st, nil
}

// rescanState re-checks the records of sessions from a previous run, reports
// the ones that still have processes, and saves the result. No record is
// dropped: one without processes is restorable. It fails when a scan fails,
// since a record is listed as restorable only once a scan has confirmed its
// session is empty; nothing is saved then.
func rescanState(log *slog.Logger, home string, st *state.State, scan func(sid int) ([]int, time.Time, error)) error {
	holding, err := st.Rescan(scan)
	if err != nil {
		return fmt.Errorf("cannot tell whether the previous run's sessions left processes; not starting: %w", err)
	}
	for _, r := range holding {
		log.Warn("session from the previous run still has processes", "sid", r.SID, "pid", r.PID, "cwd", r.Cwd, "orphans", r.Orphans)
	}
	log.Info("sessions from the previous run", "restorable", len(st.Sessions)-len(holding))
	if err := st.Save(home); err != nil {
		return fmt.Errorf("save state: %w", err)
	}
	return nil
}
