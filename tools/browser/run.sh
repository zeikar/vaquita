#!/bin/sh
# Drives the app's webview in a plain browser, for UI checks with Playwright.
#
#   tools/browser/run.sh up <dir>     set it up in a new <dir>
#   tools/browser/run.sh down <dir>   stop what up started
#
# up builds vaquitad into <dir> and runs it with a vaquita home of its own, so
# no other vaquita instance is touched; makes a small git repo in <dir>/repo
# with ignored files, registers it and starts two sessions (one in the repo,
# one outside any repo); starts bridge.mjs (the app's Rust commands, on
# 127.0.0.1:14999) and vite on port 1420. Then, in Playwright: add init.js as
# an init script and open http://localhost:1420. Needs go and node.
set -eu

usage() {
	echo "usage: $0 up|down <dir>" >&2
	exit 2
}
[ $# -eq 2 ] || usage
here=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$here/../.." && pwd -P)
mkdir -p "$2"
dir=$(cd "$2" && pwd -P)
vh=$dir/vaquita-home

# shellcheck source=SCRIPTDIR/../procs.sh
. "$here/../procs.sh"

case $1 in
down)
	stop vite
	stop bridge
	stop daemon
	exit 0
	;;
up) ;;
*) usage ;;
esac

if [ -e "$vh" ]; then
	echo "$dir was used before; name a new folder" >&2
	exit 1
fi
for port in 1420 14999; do
	if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
		echo "port $port is taken" >&2
		exit 1
	fi
done

r=$dir/repo
mkdir -p "$vh" "$r/src/lib" "$r/docs" "$r/node_modules/pkg" "$r/dist"
for p in src/index.ts src/App.svelte src/lib/util.ts src/lib/README.md docs/guide.md README.md package.json .env node_modules/pkg/index.js dist/index.html; do
	printf 'example\n' >"$r/$p"
done
printf '# Example\n\nA [link](https://example.com).\n' >"$r/README.md"
printf 'node_modules/\ndist/\n.env\n' >"$r/.gitignore"
cp "$repo/app/app-icon.png" "$r/logo.png"
printf '#!/bin/sh\necho hi\n' >"$r/run.sh"
chmod +x "$r/run.sh"
git -C "$r" init --quiet
git -C "$r" add -A
git -C "$r" -c user.name=check -c user.email=check@example.com commit --quiet -m init

make -s -C "$repo/daemon" BIN="$dir/bin/vaquitad" >/dev/null
cd "$dir"
VAQUITA_HOME=$vh nohup "$dir/bin/vaquitad" serve --allow-origin http://localhost:1420 >"$dir/daemon.log" 2>&1 &
record daemon $!
i=0
until [ -f "$vh/endpoint.json" ]; do
	i=$((i + 1))
	[ $i -le 50 ] || { echo "vaquitad did not start; see $dir/daemon.log" >&2; exit 1; }
	sleep 0.1
done
VAQUITA_HOME=$vh "$dir/bin/vaquitad" repos add "$r" >/dev/null
node "$here/sessions.mjs" "$vh" "$r"

nohup node "$here/bridge.mjs" 14999 "$vh" "$dir/bridge.log" >"$dir/bridge.out" 2>&1 &
record bridge $!
cd "$repo/app"
VAQUITA_HOME=$vh nohup ./node_modules/.bin/vite --port 1420 --strictPort >"$dir/vite.log" 2>&1 &
record vite $!
i=0
until curl -fs -o /dev/null http://localhost:1420/; do
	i=$((i + 1))
	[ $i -le 100 ] || { echo "vite did not start; see $dir/vite.log" >&2; exit 1; }
	sleep 0.2
done
echo "up: in Playwright, add $here/init.js as an init script, then open http://localhost:1420 (bridge log: $dir/bridge.log)"
