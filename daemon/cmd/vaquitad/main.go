package main

import (
	"errors"
	"fmt"
	"os"
)

const usage = `usage: vaquitad <command>

commands:
  serve [--allow-origin ORIGIN]...
           run the daemon in the foreground
  ls       list the running daemon's sessions
  attach <sid>
  attach --new [--cwd DIR] [--name NAME] [-- CMD ARGS...]
           attach this terminal to a session, or to a new one running
           CMD (a plain shell without one); Ctrl-\ detaches and is never
           sent to the session
  repos ls | add DIR | rm DIR
           manage the repos the app groups sessions by
  install [--print | --bootstrap]
           write the LaunchAgent plist (--print: show it only;
           --bootstrap: also load it with launchctl)
  version  print this vaquitad's build
`

// version is the build: a release's version, set with
// -ldflags "-X main.version=...", else dev. The daemon sends it in its hello
// so the app can tell a daemon other than the one it ships.
var version = "dev"

// errShown is returned by a command whose failure has already been shown
// to the user, so that main only sets the exit status.
var errShown = errors.New("failure already shown")

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(os.Args[2:])
	case "ls":
		err = ls(os.Args[2:])
	case "attach":
		err = attach(os.Args[2:])
	case "repos":
		err = repos(os.Args[2:])
	case "install":
		err = install(os.Args[2:])
	case "version", "--version":
		fmt.Println(version)
		return
	case "-h", "--help", "help":
		fmt.Print(usage)
		return
	default:
		fmt.Fprintf(os.Stderr, "vaquitad: unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		if !errors.Is(err, errShown) {
			fmt.Fprintf(os.Stderr, "%v\n", err)
		}
		os.Exit(1)
	}
}
