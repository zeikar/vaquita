package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/zeikar/vaquita/daemon/internal/state"
)

// install writes the plist into VAQUITA_HOME rather than ~/Library/LaunchAgents:
// launchd then loads the agent only when it is bootstrapped, so nothing starts
// at login and the instance's home holds everything that belongs to it.
func install(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	printOnly := fs.Bool("print", false, "render the plist to stdout and write nothing")
	bootstrap := fs.Bool("bootstrap", false, "run launchctl bootstrap after writing the plist")
	if err := fs.Parse(args); err != nil {
		return errShown
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("install: unexpected argument %q", fs.Arg(0))
	}
	if *printOnly && *bootstrap {
		return fmt.Errorf("install: --print and --bootstrap cannot be combined")
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("find executable: %w", err)
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	home, err := state.Home()
	if err != nil {
		return err
	}
	label := state.Label()
	plist := renderPlist(label, exe, home)

	if *printOnly {
		_, err := os.Stdout.Write(plist)
		return err
	}
	if err := checkExeStable(exe); err != nil {
		return err
	}
	if unstablySigned(exe) {
		fmt.Fprintf(os.Stderr, "warning: %s has no stable signature, so macOS will ask again for folder access after every rebuild; build it with `make SIGN=<identity>`\n", exe)
	}
	path, err := writeAgentPlist(home, label, plist)
	if err != nil {
		return err
	}
	target := fmt.Sprintf("gui/%d", os.Getuid())
	fmt.Printf("wrote %s\n", path)
	if *bootstrap {
		return runBootstrap(target, path)
	}
	fmt.Printf(`
next steps:
  launchctl bootstrap %[1]s %[2]s
  launchctl print %[1]s/%[3]s
  launchctl bootout %[1]s/%[3]s
`, target, shellJoin([]string{path}), label)
	return nil
}

// checkExeStable refuses executables that a LaunchAgent would outlive: go run
// binaries and anything under the temp dir.
// unstablySigned reports whether exe is unsigned or carries only an ad-hoc
// signature (Go's linker signs arm64 binaries that way). TCC ties such a
// binary's permissions to its exact hash, which every build changes.
func unstablySigned(exe string) bool {
	out, err := exec.Command("codesign", "-dv", exe).CombinedOutput()
	if err != nil {
		return bytes.Contains(out, []byte("not signed at all"))
	}
	return bytes.Contains(out, []byte("Signature=adhoc"))
}

func checkExeStable(exe string) error {
	tmp := os.TempDir()
	if r, err := filepath.EvalSymlinks(tmp); err == nil {
		tmp = r
	}
	if strings.Contains(exe, "go-build") || strings.HasPrefix(exe, filepath.Clean(tmp)+string(filepath.Separator)) {
		return fmt.Errorf("refusing to install %s: it is a temporary build; run `go build -o <path>/vaquitad ./cmd/vaquitad` and run install from that binary", exe)
	}
	return nil
}

// writeAgentPlist writes <dir>/<label>.plist. The plist is linted as a
// temporary file in dir and renamed into place only if it passes, so a
// failed reinstall leaves the installed plist as it was and launchd never
// sees a half-written or invalid one.
func writeAgentPlist(dir, label string, plist []byte) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create %s: %w", dir, err)
	}
	path := filepath.Join(dir, label+".plist")
	f, err := os.CreateTemp(dir, label+".*.tmp")
	if err != nil {
		return "", fmt.Errorf("write %s: %w", path, err)
	}
	tmp := f.Name()
	defer os.Remove(tmp) // a no-op once renamed
	_, err = f.Write(plist)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp, 0o644)
	}
	if err != nil {
		return "", fmt.Errorf("write %s: %w", path, err)
	}
	if out, err := exec.Command("plutil", "-lint", tmp).CombinedOutput(); err != nil {
		return "", fmt.Errorf("plutil -lint of the new %s failed: %w\n%s", path, err, out)
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", fmt.Errorf("install %s: %w", path, err)
	}
	return path, nil
}

func runBootstrap(target, path string) error {
	fmt.Printf("running: launchctl bootstrap %s %s\n", target, shellJoin([]string{path}))
	cmd := exec.Command("launchctl", "bootstrap", target, path)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("launchctl bootstrap failed: %w\n%s\nif the agent is already loaded, run `launchctl bootout %s/%s` first",
			err, strings.TrimSpace(stderr.String()), target, strings.TrimSuffix(filepath.Base(path), ".plist"))
	}
	fmt.Println("bootstrapped")
	return nil
}
