VAQUITA_HOME ?= $(HOME)/.vaquita-dev
BIN = $(VAQUITA_HOME)/bin/vaquitad

# SIGN names a code-signing identity, such as a self-signed certificate in the
# login keychain. Without it the binary keeps Go's ad-hoc signature, which
# changes with every build, and macOS forgets the folder permissions (TCC) it
# granted a launchd-run daemon each time the binary is replaced.
SIGN ?=

# Built and signed beside the target, then renamed into place, so a running
# daemon keeps its old file until it is restarted. Paths are quoted, and the
# directory comes from dirname rather than $(dir), which splits on spaces: the
# default home is under "Application Support".
.PHONY: build
build:
	mkdir -p "$$(dirname "$(BIN)")"
	go build -o "$(BIN).tmp" ./cmd/vaquitad
ifneq ($(SIGN),)
	codesign --force --sign "$(SIGN)" --identifier io.github.zeikar.vaquitad "$(BIN).tmp"
endif
	mv "$(BIN).tmp" "$(BIN)"
