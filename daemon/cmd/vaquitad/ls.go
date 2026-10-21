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

	"github.com/zeikar/vaquita/daemon/internal/client"
	"github.com/zeikar/vaquita/daemon/internal/protocol"
	"github.com/zeikar/vaquita/daemon/internal/state"
)

const dialTimeout = 5 * time.Second

func ls(args []string) error {
	if len(args) > 0 {
		return fmt.Errorf("ls: unexpected argument %q", args[0])
	}
	home, err := state.Home()
	if err != nil {
		return err
	}
	ep, err := state.ReadEndpoint(home)
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("vaquitad is not running for %s", home)
	}
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	defer cancel()
	c, list, err := client.Dial(ctx, ep, protocol.ClientAttach)
	if err != nil {
		return fmt.Errorf("cannot reach vaquitad for %s at %s: %w", home, ep.URL, err)
	}
	defer c.Close()

	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "SID\tSTATE\tPID\tCWD\tCMD\tNAME\tORPHANS")
	for _, s := range list {
		orphans := make([]string, len(s.Orphans))
		for i, pid := range s.Orphans {
			orphans[i] = strconv.Itoa(pid)
		}
		fmt.Fprintf(tw, "%d\t%s\t%d\t%s\t%s\t%s\t%s\n", s.SID, s.State, s.PID, s.Cwd, s.Cmd, s.Name, strings.Join(orphans, ","))
	}
	return tw.Flush()
}
