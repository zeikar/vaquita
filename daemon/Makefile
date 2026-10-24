VAQUITA_HOME ?= $(HOME)/.vaquita-dev
BIN = $(VAQUITA_HOME)/bin/vaquitad

# SIGN names a code-signing identity, such as a self-signed certificate in the
# login keychain. Without it the binary keeps Go's ad-hoc signature, which
# changes with every build, and macOS forgets the folder permissions (TCC) it
# granted a launchd-run daemon each time the binary is replaced.
SIGN ?=

# VERSION is the build vaquitad reports (`vaquitad version`, the hello). The
# release workflow sets it from the tag; the app replaces a running daemon
# whose build differs from the one it ships, and leaves a dev one alone.
VERSION ?= dev

# Without the symbol table and DWARF (-s -w) the binary is a third smaller and
# its zip half the size; panics still name functions and lines. -trimpath keeps
# the builder's folders out of it.
#
# Built and signed beside the target, then renamed into place, so a running
# daemon keeps its old file until it is restarted. Paths are quoted, and the
# directory comes from dirname rather than $(dir), which splits on spaces: the
# default home is under "Application Support".
.PHONY: build
build:
	mkdir -p "$$(dirname "$(BIN)")"
	go build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o "$(BIN).tmp" ./cmd/vaquitad
ifneq ($(SIGN),)
	codesign --force --sign "$(SIGN)" --identifier io.github.zeikar.vaquitad "$(BIN).tmp"
endif
	mv "$(BIN).tmp" "$(BIN)"
