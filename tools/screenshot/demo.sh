#!/bin/sh
# The demo behind the README screenshot, so it can be taken again the same way.
#
#   tools/screenshot/demo.sh up <dir>     set it up in <dir> and open the app
#   tools/screenshot/demo.sh down <dir>   stop what up started
#
# up builds vaquitad into <dir> and runs it with a vaquita home of its own and
# HOME set to <dir>/home, so rows and prompts show ~ paths and no other
# vaquita instance is touched (Go's build caches are shared). It adds three
# repos under ~/src (vaquita is a clone of this repo), starts the sessions in
# sessions.mjs, and opens the app in dev mode (vite on port 1420 and a debug
# build, which starts no daemon of its own). Needs go, node, cargo and zsh.
set -eu

usage() {
	echo "usage: $0 up|down <dir>" >&2
	exit 2
}
[ $# -eq 2 ] || usage
here=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$here/../.." && pwd -P)
mkdir -p "$2"
# Physical, as zsh's ~ only matches a session folder spelled the same way.
dir=$(cd "$2" && pwd -P)
home=$dir/home
vh=$dir/vaquita-home

# Stops the process up recorded under that name, and only that one.
stop() {
	[ -f "$dir/$1.pid" ] || return 0
	kill "$(cat "$dir/$1.pid")" 2>/dev/null || true
	rm -f "$dir/$1.pid"
}

case $1 in
down)
	stop app
	stop vite
	stop daemon
	exit 0
	;;
up) ;;
*) usage ;;
esac

if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
	echo "port 1420 is taken, by another dev server?" >&2
	exit 1
fi
if [ -f "$dir/daemon.pid" ]; then
	echo "$dir is already up; run down first" >&2
	exit 1
fi

mkdir -p "$home/src/api-server" "$home/src/web-app" "$vh"
if [ ! -d "$home/src/vaquita" ]; then
	git clone --quiet "$repo" "$home/src/vaquita"
	# Its log then names the branch and tags, not the origin's branches too.
	git -C "$home/src/vaquita" remote remove origin
fi
make -s -C "$repo/daemon" BIN="$dir/bin/vaquitad" >/dev/null

# The plain shell in vaquita shows two commands as if typed; the agent
# sessions, which zsh runs with -c, show only their own output.
cat >"$home/.zshrc" <<ZSHRC
export PATH="$dir/bin:\$PATH" GIT_PAGER=cat GOCACHE="$(go env GOCACHE)" GOMODCACHE="$(go env GOMODCACHE)"
PROMPT='%F{75}%~%f %# '
if [[ -z \$ZSH_EXECUTION_STRING && -z \$DEMO_SHOWN && \$PWD == \$HOME/src/vaquita ]]; then
	export DEMO_SHOWN=1
	for c in 'git log --oneline -8' 'go -C daemon test ./...'; do print -P "\$PROMPT\$c"; eval "\$c"; done
fi
ZSHRC

cd "$dir"
HOME=$home VAQUITA_HOME=$vh SHELL=/bin/zsh nohup "$dir/bin/vaquitad" serve --allow-origin http://localhost:1420 >"$dir/daemon.log" 2>&1 &
echo $! >"$dir/daemon.pid"
i=0
until [ -f "$vh/endpoint.json" ]; do
	i=$((i + 1))
	[ $i -le 50 ] || { echo "vaquitad did not start; see $dir/daemon.log" >&2; exit 1; }
	sleep 0.1
done
for r in api-server vaquita web-app; do
	VAQUITA_HOME=$vh "$dir/bin/vaquitad" repos add "$home/src/$r" >/dev/null
done
node "$here/sessions.mjs" "$vh" "$home" "$here/fake-agent.sh"

cd "$repo/app"
VAQUITA_HOME=$vh nohup ./node_modules/.bin/vite --port 1420 --strictPort >"$dir/vite.log" 2>&1 &
echo $! >"$dir/vite.pid"
(cd src-tauri && cargo build -q)
i=0
until curl -fs -o /dev/null http://localhost:1420/; do
	i=$((i + 1))
	[ $i -le 100 ] || { echo "vite did not start; see $dir/vite.log" >&2; exit 1; }
	sleep 0.2
done
HOME=$home VAQUITA_HOME=$vh nohup src-tauri/target/debug/vaquita >"$dir/app.log" 2>&1 &
echo $! >"$dir/app.pid"
echo "up: select the shell under vaquita, then take the shot (see docs/app.md)"
