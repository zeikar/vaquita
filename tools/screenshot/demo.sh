#!/bin/sh
# The demo behind the README screenshot, so it can be taken again the same way.
#
#   tools/screenshot/demo.sh up <dir>     set it up in a new <dir> and open the app
#   tools/screenshot/demo.sh down <dir>   stop what up started
#
# up builds vaquitad into <dir> and runs it with a vaquita home of its own and
# HOME set to <dir>/home, so rows and prompts show ~ paths and no other
# vaquita instance is touched. It adds three repos under ~/src (vaquita is a
# clone of this repo), starts the sessions in sessions.mjs whose agents are
# stand-ins, and opens the app in dev mode (vite on port 1420 and a debug
# build, which starts no daemon of its own). Once the app is connected it
# starts the real Claude Code for one short turn, with your login. Needs go,
# node, cargo, zsh and a logged-in claude.
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
app=$repo/app/src-tauri/target/debug/vaquita

# shellcheck source=SCRIPTDIR/../procs.sh
. "$here/../procs.sh"

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

# A daemon restores the sessions of its last run, so each demo starts afresh.
if [ -e "$vh" ]; then
	echo "$dir was used before; name a new folder" >&2
	exit 1
fi
if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
	echo "port 1420 is taken, by another dev server?" >&2
	exit 1
fi

mkdir -p "$home/src/api-server" "$home/src/web-app" "$vh"
git clone --quiet "$repo" "$home/src/vaquita"
# Its log then names the branch and tags, not the origin's branches too.
git -C "$home/src/vaquita" remote remove origin
# What a checkout has after npm install and a build, so the files panel shows
# ignored folders dimmed when app/ is expanded.
mkdir -p "$home/src/vaquita/app/node_modules" "$home/src/vaquita/app/dist"
: >"$home/src/vaquita/app/node_modules/.package-lock.json"
: >"$home/src/vaquita/app/dist/index.html"

# The other two repos get a few files, so their trees are not empty.
# seed <repo> <path>...: an empty file per path, then git init and a commit.
seed() {
	r=$home/src/$1
	shift
	for p in "$@"; do
		mkdir -p "$r/$(dirname "$p")"
		: >"$r/$p"
	done
	printf 'node_modules/\ndist/\n.env\n' >"$r/.gitignore"
	git -C "$r" init --quiet
	git -C "$r" add -A
	git -C "$r" -c user.name=demo -c user.email=demo@example.com commit --quiet -m init
	mkdir -p "$r/node_modules"
	: >"$r/.env"
}
seed api-server go.mod main.go README.md Dockerfile internal/auth/login.go internal/auth/ratelimit.go internal/retry/retry.go internal/retry/retry_test.go
seed web-app package.json tsconfig.json README.md index.html src/main.ts src/App.svelte src/settings/Settings.svelte src/settings/theme.css src/chart/UsageChart.svelte public/logo.svg
make -s -C "$repo/daemon" BIN="$dir/bin/vaquitad" >/dev/null

cat >"$home/.zshrc" <<'ZSHRC'
PROMPT='%F{75}%~%f %# '
# Its partial-line mark would show once the app resizes the terminal.
unsetopt prompt_sp
# The real claude would try to update itself into this HOME.
export DISABLE_AUTOUPDATER=1
ZSHRC

# claude keeps its login in the keychain, which macOS looks up under HOME.
mkdir -p "$home/Library"
ln -s "$HOME/Library/Keychains" "$home/Library/Keychains"
node "$here/claude-config.mjs" "$home" "$home/src/vaquita"

cd "$dir"
HOME=$home VAQUITA_HOME=$vh SHELL=/bin/zsh nohup "$dir/bin/vaquitad" serve --allow-origin http://localhost:1420 >"$dir/daemon.log" 2>&1 &
record daemon $!
i=0
until [ -f "$vh/endpoint.json" ]; do
	i=$((i + 1))
	[ $i -le 50 ] || { echo "vaquitad did not start; see $dir/daemon.log" >&2; exit 1; }
	sleep 0.1
done
for r in api-server vaquita web-app; do
	VAQUITA_HOME=$vh "$dir/bin/vaquitad" repos add "$home/src/$r" >/dev/null
done
node "$here/sessions.mjs" "$vh" "$home" "$here/fake-agent.sh" agents

cd "$repo/app"
VAQUITA_HOME=$vh nohup ./node_modules/.bin/vite --port 1420 --strictPort >"$dir/vite.log" 2>&1 &
record vite $!
(cd src-tauri && cargo build -q)
i=0
until curl -fs -o /dev/null http://localhost:1420/; do
	i=$((i + 1))
	[ $i -le 100 ] || { echo "vite did not start; see $dir/vite.log" >&2; exit 1; }
	sleep 0.2
done
guis() { grep -c 'msg="client connected".*client=gui' "$vh/vaquitad.log" || true; }
before=$(guis)
HOME=$home VAQUITA_HOME=$vh nohup "$app" >"$dir/app.log" 2>&1 &
record app $!

# claude reports its state only once a terminal answers its query, which the
# app's does for each session it shows.
i=0
until [ "$(guis)" -gt "$before" ]; do
	i=$((i + 1))
	[ $i -le 150 ] || { echo "the app did not connect; see $dir/app.log" >&2; exit 1; }
	sleep 0.2
done
sleep 2
node "$here/sessions.mjs" "$vh" "$home" "$here/fake-agent.sh" claude
echo "up: once claude has answered, select its row and take the shot (see docs/app.md)"
