#!/bin/bash
# First install of vaquita:
#   curl -fsSL https://raw.githubusercontent.com/zeikar/vaquita/main/install.sh | bash
#
# Fetching with curl leaves no quarantine flag, so the self-signed app opens
# without `xattr`. An app already in place is left alone: it updates itself.

set -euo pipefail

REPO="https://github.com/zeikar/vaquita"

fail() {
	echo "vaquita: $*" >&2
	exit 1
}

# All in a function, so a download cut short runs nothing.
main() {
	[[ "$(uname -s)" == Darwin ]] || fail "vaquita runs on macOS only."
	# uname -m says x86_64 in a shell under Rosetta; this does not.
	[[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" == 1 ]] || fail "vaquita runs on Apple Silicon only."

	local d
	for d in /Applications "$HOME/Applications"; do
		if [[ -e "$d/vaquita.app" ]]; then
			fail "$d/vaquita.app is already installed. It updates itself: the app offers each new release. To replace it by hand, quit vaquita and swap the app in Finder."
		fi
	done

	local dest=/Applications
	if [[ ! -w "$dest" ]]; then
		dest="$HOME/Applications"
		mkdir -p "$dest"
	fi

	# The app is copied beside its final place and renamed when complete, so a
	# copy cut short never looks like an installed app.
	local tmp staging="$dest/.vaquita.app.installing-$$"
	tmp="$(mktemp -d)"
	# Expanded now: these are local and gone by the time EXIT fires.
	# shellcheck disable=SC2064
	trap "rm -rf '$tmp' '$staging'" EXIT

	# latest.json is the feed the app polls, so it names the latest release.
	local version
	curl -fsSL "$REPO/releases/latest/download/latest.json" -o "$tmp/latest.json"
	version="$(plutil -extract version raw -o - "$tmp/latest.json")" || fail "could not read the latest version."

	local zip="vaquita-$version-macos-arm64.zip"
	echo "Downloading vaquita $version..."
	curl -fSL --progress-bar "$REPO/releases/download/v$version/$zip" -o "$tmp/$zip"
	curl -fsSL "$REPO/releases/download/v$version/$zip.sha256" -o "$tmp/$zip.sha256"
	(cd "$tmp" && shasum -a 256 -c "$zip.sha256" >/dev/null) || fail "the download does not match its checksum."

	ditto -xk "$tmp/$zip" "$tmp/out"
	[[ -d "$tmp/out/vaquita.app" ]] || fail "$zip has no vaquita.app."
	ditto "$tmp/out/vaquita.app" "$staging"
	# rename(2), not mv: mv would move it inside an app another run put there meanwhile.
	perl -e 'rename($ARGV[0], $ARGV[1]) or die "$!\n"' "$staging" "$dest/vaquita.app" ||
		fail "could not put vaquita.app in $dest."

	echo "Installed vaquita $version in $dest."
	open "$dest/vaquita.app" || echo "Open $dest/vaquita.app to start it."
}

main "$@"
