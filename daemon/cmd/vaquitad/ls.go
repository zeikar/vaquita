package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/zeikar/vaquita/daemon/internal/client"
	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

const dialTimeout = 5 * time.Second

func ls(args []string) error {
	if len(args) > 0 {
		return fmt.Errorf("ls: unexpected argument %q", args[0])
	}
	c, list, err := dialDaemon()
	if err != nil {
		return err
	}
	defer c.Close()

	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "SID\tSTATE\tPID\tCWD\tCMD\tNAME\tORPHANS")
	for _, s := range list {
		orphans := make([]string, len(s.Orphans))
		for i, pid := range s.Orphans {
			orphans[i] = strconv.Itoa(pid)
		}
		fmt.Fprintf(tw, "%d\t%s\t%d\t%s\t%s\t%s\t%s\n", s.SID, s.State, s.PID, cell(s.Cwd), cell(s.Cmd), cell(s.Name), strings.Join(orphans, ","))
	}
	return tw.Flush()
}

// cell quotes s, as Go would, if it holds anything but printable text: a
// newline or tab would break the table, and an escape would reach the
// terminal.
func cell(s string) string {
	if !utf8.ValidString(s) || strings.ContainsFunc(s, func(r rune) bool { return !unicode.IsPrint(r) }) {
		return strconv.Quote(s)
	}
	return s
}

// dialDaemon connects to this instance's daemon as an attach client and
// returns the session list it sends after the hello.
func dialDaemon() (*client.Client, []protocol.SessionInfo, error) {
	home, err := state.Home()
	if err != nil {
		return nil, nil, err
	}
	ep, err := state.ReadEndpoint(home)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, fmt.Errorf("vaquitad is not running for %s", home)
	}
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	defer cancel()
	c, list, err := client.Dial(ctx, ep, protocol.ClientAttach)
	if err != nil {
		return nil, nil, fmt.Errorf("cannot reach vaquitad for %s at %s: %w", home, ep.URL, err)
	}
	return c, list, nil
}
