package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"slices"
	"strconv"
	"syscall"

	"golang.org/x/term"

	"github.com/zeikar/vaquita/daemon/internal/protocol"
)

// attach connects this terminal, in raw mode, to a session: a debugging
// client, and the way to try an agent in a session without the GUI.
func attach(args []string) error {
	cfg, err := parseAttach(args)
	if err != nil {
		return err
	}
	// Both ends must be the terminal: the fence needs the terminal to see
	// the output and answer on the input.
	in, out := int(os.Stdin.Fd()), int(os.Stdout.Fd())
	if !term.IsTerminal(in) || !term.IsTerminal(out) {
		return errors.New("attach: stdin and stdout must be a terminal")
	}
	c, list, err := dialDaemon()
	if err != nil {
		return err
	}
	if !cfg.create && !slices.ContainsFunc(list, func(s protocol.SessionInfo) bool { return s.SID == cfg.sid }) {
		c.Close()
		return fmt.Errorf("attach: %s: vaquitad has no session %d", protocol.CodeNoSession, cfg.sid)
	}

	// From raw mode on, signals go through leave, which restores the
	// terminal.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)
	old, err := term.MakeRaw(in)
	if err != nil {
		c.Close()
		return fmt.Errorf("attach: raw mode: %w", err)
	}
	restore := func() {
		if err := term.Restore(in, old); err != nil {
			fmt.Fprintf(os.Stderr, "attach: restore the terminal: %v\n", err)
		}
	}
	size := func() (int, int, error) { return defaultSize(term.GetSize(in)) }
	a := newAttacher(cfg, c, os.Stdin, os.Stdout, size, restore)
	// Leaves the terminal usable on a panic; after run it does nothing.
	defer a.leave(ending{msg: "[vaquita] internal error; detached", failed: true})
	if e := a.run(stop, winch); e.failed {
		return errShown
	}
	return nil
}

func parseAttach(args []string) (attachConfig, error) {
	fs := flag.NewFlagSet("attach", flag.ExitOnError)
	create := fs.Bool("new", false, "start a new session and attach to it")
	cwd := fs.String("cwd", "", "working `directory` of the new session (default: the current one)")
	name := fs.String("name", "", "`name` of the new session")
	fs.Parse(args)

	if !*create {
		if *cwd != "" || *name != "" {
			return attachConfig{}, errors.New("attach: --cwd and --name are for --new")
		}
		if fs.NArg() != 1 {
			return attachConfig{}, errors.New("usage: vaquitad attach <sid> | attach --new [--cwd DIR] [--name NAME] [-- CMD ARGS...]")
		}
		sid, err := strconv.ParseUint(fs.Arg(0), 10, 32)
		if err != nil || sid == 0 {
			return attachConfig{}, fmt.Errorf("attach: %q is not a session id", fs.Arg(0))
		}
		return attachConfig{sid: uint32(sid)}, nil
	}

	cfg := attachConfig{create: true, cwd: *cwd, name: *name}
	// The daemon would resolve a relative path against its own directory.
	if cfg.cwd == "" {
		cfg.cwd = "."
	}
	abs, err := absPath(cfg.cwd)
	if err != nil {
		return attachConfig{}, fmt.Errorf("attach: --cwd: %w", err)
	}
	cfg.cwd = abs
	// Without a command the session is a plain shell.
	if fs.NArg() > 0 {
		cfg.cmd = shellJoin(fs.Args())
	}
	return cfg, nil
}

// defaultSize stands in 80x24 for a dimension the terminal reports as zero
// (ssh -T, some script/expect PTYs), as tmux does: the daemon refuses a
// zero-sized session.
func defaultSize(cols, rows int, err error) (int, int, error) {
	if err != nil {
		return cols, rows, err
	}
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	return cols, rows, nil
}
