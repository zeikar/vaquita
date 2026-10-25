VAQUITA_HOME ?= $(HOME)/.vaquita-dev
BIN = $(VAQUITA_HOME)/bin/vaquitad

# SIGN names a code-signing identity, such as a self-signed certificate in the
# login keychain. Without it the binary keeps Go's ad-hoc signature, which
# changes with every build, and macOS forgets the folder permissions (TCC) it
# granted a launchd-run daemon each time the binary is replaced.
SIGN ?=

# VERSION is the release; the release workflow sets it from the tag. BUILD is
# what vaquitad reports (`vaquitad version`, the hello): dev for a plain make,
# else VERSION and, after a +, a fingerprint of the daemon's committed files
# other than tests. The app replaces a running daemon whose fingerprint differs
# from the one it ships, so a release that leaves the daemon alone restarts no
# daemon, and it leaves a dev one alone.
VERSION ?= dev
ifeq ($(VERSION),dev)
BUILD := dev
else
# Outside git the fingerprint would be that of no files, the same for any code.
ifeq ($(shell git ls-tree HEAD . 2>/dev/null),)
$(error VERSION is set, but the daemon's files are not committed in git, which its fingerprint is taken from)
endif
# The fingerprint is of the committed files, and go build compiles the ones on
# disk, so they must be the same.
ifneq ($(shell git status --porcelain -- . | grep -v '_test\.go$$'),)
$(error VERSION is set, but the daemon has uncommitted changes, which its fingerprint would not show)
endif
BUILD := $(VERSION)+$(shell git ls-tree -r HEAD . | grep -v '_test\.go$$' | git hash-object --stdin | cut -c1-12)
endif

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
	go build -trimpath -ldflags "-s -w -X main.version=$(BUILD)" -o "$(BIN).tmp" ./cmd/vaquitad
ifneq ($(SIGN),)
	codesign --force --sign "$(SIGN)" --identifier io.github.zeikar.vaquitad "$(BIN).tmp"
endif
	mv "$(BIN).tmp" "$(BIN)"
