#!/bin/sh
# Runs one browser check end to end, in WebKit (BROWSER=chromium for Chromium).
#
#   tools/browser/check.sh <name> [dir]
#
# runs run.sh up in <dir> (a new temporary folder if none is named), then
# checks/<name>.mjs, which prints PASS and FAIL lines and saves screenshots in
# <dir>/shots; run.sh down follows however the check ends. <dir> is kept for
# the screenshots and logs. Exits with the check's status.
set -eu

usage() {
	echo "usage: $0 <name> [dir]" >&2
	exit 2
}
[ $# -eq 1 ] || [ $# -eq 2 ] || usage
here=$(cd "$(dirname "$0")" && pwd -P)
check=$here/checks/$1.mjs
[ -f "$check" ] || { echo "no check $check" >&2; exit 2; }

if [ ! -d "$here/node_modules" ]; then
	npm ci --prefix "$here" --no-audit --no-fund >&2
fi
if [ $# -eq 2 ]; then
	dir=$2
else
	tmp=${TMPDIR:-/tmp}
	dir=$(mktemp -d "${tmp%/}/vaquita-check.XXXXXX")
fi

# On a signal too, so ^C does not leave the daemon, bridge and vite running.
trap '"$here/run.sh" down "$dir"; echo "screenshots and logs: $dir" >&2' EXIT
trap 'exit 130' INT TERM
"$here/run.sh" up "$dir"
status=0
node "$check" "$dir" || status=$?
exit $status
