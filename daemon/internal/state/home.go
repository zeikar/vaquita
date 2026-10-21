// Package state owns the on-disk layout of a vaquitad instance.
package state

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

const baseLabel = "io.github.zeikar.vaquitad"

// Home returns the instance directory: $VAQUITA_HOME or the default under
// Application Support. It is made absolute and created with mode 0700.
func Home() (string, error) {
	dir := os.Getenv("VAQUITA_HOME")
	if dir == "" {
		u, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home directory: %w", err)
		}
		dir = filepath.Join(u, "Library", "Application Support", "vaquita")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("make %q absolute: %w", dir, err)
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return "", fmt.Errorf("create %s: %w", abs, err)
	}
	return abs, nil
}

func LockPath(home string) string     { return filepath.Join(home, "vaquitad.lock") }
func EndpointPath(home string) string { return filepath.Join(home, "endpoint.json") }
func StatePath(home string) string    { return filepath.Join(home, "state.json") }
func LogPath(home string) string      { return filepath.Join(home, "vaquitad.log") }

// Label is the launchd label for this instance. The default home keeps the
// plain label; a custom VAQUITA_HOME gets a hash suffix so instances don't
// collide in launchd.
func Label() string {
	custom := os.Getenv("VAQUITA_HOME")
	if custom == "" {
		return baseLabel
	}
	// Hash the absolute form so relative and absolute spellings of one home
	// share a label, as they share everything else.
	if abs, err := filepath.Abs(custom); err == nil {
		custom = abs
	}
	sum := sha256.Sum256([]byte(custom))
	return baseLabel + "." + hex.EncodeToString(sum[:])[:8]
}
