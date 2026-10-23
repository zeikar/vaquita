package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"github.com/zeikar/vaquita/daemon/internal/client"
	"github.com/zeikar/vaquita/daemon/internal/protocol"
)

const reposTimeout = 5 * time.Second

type reposCmd struct {
	op   string // "ls", "add" or "rm"
	path string // absolute; empty for ls
}

func parseRepos(args []string) (reposCmd, error) {
	const form = "usage: vaquitad repos ls | add DIR | rm DIR"
	if len(args) == 0 {
		return reposCmd{}, errors.New(form)
	}
	switch op := args[0]; {
	case op == "ls" && len(args) == 1:
		return reposCmd{op: "ls"}, nil
	case (op == "add" || op == "rm") && len(args) == 2:
		abs, err := filepath.Abs(args[1])
		if err != nil {
			return reposCmd{}, fmt.Errorf("repos %s: %w", op, err)
		}
		return reposCmd{op: op, path: abs}, nil
	default:
		return reposCmd{}, errors.New(form)
	}
}

// awaitRepos returns the list of the next Repos message. The CLI is an
// attach client, which the daemon sends a repos list only in answer to a
// request, so this one answers the request just made.
func awaitRepos(events <-chan client.Event, timeout time.Duration) ([]string, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return nil, errors.New("connection closed")
			}
			if ev.Err != nil {
				return nil, ev.Err
			}
			switch m := ev.Msg.(type) {
			case protocol.Repos:
				return m.List, nil
			case protocol.Error:
				switch m.Code {
				case protocol.CodeBadPath:
					return nil, errors.New("not an absolute path to an existing directory")
				case protocol.CodeBadRequest:
					return nil, errors.New("vaquitad does not know repos (an older daemon?)")
				default:
					return nil, errors.New(m.Code)
				}
			}
		case <-timer.C:
			return nil, errors.New("no answer from vaquitad")
		}
	}
}

func repos(args []string) error {
	cmd, err := parseRepos(args)
	if err != nil {
		return err
	}
	c, _, err := dialDaemon()
	if err != nil {
		return err
	}
	defer c.Close()

	switch cmd.op {
	case "ls":
		err = c.ReposList()
	case "add":
		err = c.ReposAdd(cmd.path)
	case "rm":
		err = c.ReposRemove(cmd.path)
	}
	if err != nil {
		return err
	}
	list, err := awaitRepos(c.Events(), reposTimeout)
	if err != nil {
		return fmt.Errorf("repos %s: %w", cmd.op, err)
	}
	if cmd.op == "ls" {
		for _, p := range list {
			fmt.Println(cell(p))
		}
	}
	return nil
}
