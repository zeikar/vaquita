#!/bin/sh
# A local end-to-end check of the in-app update, so it can be run again the same way.
#
#   tools/update-check/check.sh up <dir>     set it up in a new <dir> and open the old app
#   tools/update-check/check.sh down <dir>   say whether it became 0.0.2, and stop what up started
#
# up builds two bundles, 0.0.1 and 0.0.2, the second signed with a throwaway
# key that the first trusts, serves the update on 127.0.0.1:1421 and opens the
# 0.0.1 bundle from <dir>. Click Update in its bar by hand; down then reads
# the bundle's version. The app talks to the dev daemon of ~/.vaquita-dev,
# which must be running. Needs node, cargo, python3 and that daemon.
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
vh=$HOME/.vaquita-dev
bundle=$dir/app/vaquita.app

# shellcheck source=SCRIPTDIR/../procs.sh
. "$here/../procs.sh"

case $1 in
down)
	v=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$bundle/Contents/Info.plist" 2>/dev/null || true)
	# The relaunched app was not started by this script and is left alone.
	stop app
	stop server
	if [ "$v" = 0.0.2 ]; then
		echo "PASS: the bundle is 0.0.2"
	else
		echo "FAIL: the bundle is still ${v:-unknown}"
		exit 1
	fi
	exit 0
	;;
up) ;;
*) usage ;;
esac

# A release build that finds no daemon installs a LaunchAgent for its home, and
# one that finds a daemon of another build restarts it through launchctl when
# no session runs (daemon-update.ts). Only a dev build is left alone.
hint="start a dev daemon first: VAQUITA_HOME=$vh make -C daemon, then run that vaquitad serve"
[ -f "$vh/endpoint.json" ] || { echo "no $vh/endpoint.json; $hint" >&2; exit 1; }
pid=$(jq -r .pid "$vh/endpoint.json")
kill -0 "$pid" 2>/dev/null || { echo "the daemon in $vh is not running; $hint" >&2; exit 1; }
# The executable the process has open; argv[0] can be a bare name that resolves elsewhere.
exe=$(lsof -p "$pid" -a -d txt -Fn | sed -n 's/^n//p' | head -1)
[ "$("$exe" version 2>/dev/null)" = dev ] || { echo "the daemon in $vh is not a dev build; $hint" >&2; exit 1; }

# The first file up writes, so a rerun after a failed build is refused too.
if [ -e "$dir/key" ]; then
	echo "$dir was used before; name a new folder" >&2
	exit 1
fi
if lsof -nP -iTCP:1421 -sTCP:LISTEN >/dev/null 2>&1; then
	echo "port 1421 is taken" >&2
	exit 1
fi

# The relaunch after the update goes through /usr/bin/open -n. If that drops
# VAQUITA_HOME, the 0.0.2 build would use the default home and the stable
# daemon, so find out first, with a bundle that only writes the variable down.
mkdir -p "$dir/probe.app/Contents/MacOS"
cat >"$dir/probe.app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleIdentifier</key><string>dev.vaquita.update-check-probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
cat >"$dir/probe.app/Contents/MacOS/probe" <<EOS
#!/bin/sh
echo "\$VAQUITA_HOME" >"$dir/probe.out"
EOS
chmod +x "$dir/probe.app/Contents/MacOS/probe"
VAQUITA_HOME=$vh /usr/bin/open -n "$dir/probe.app"
i=0
until [ -s "$dir/probe.out" ]; do
	i=$((i + 1))
	[ $i -le 100 ] || break
	sleep 0.1
done
if [ "$(cat "$dir/probe.out" 2>/dev/null)" != "$vh" ]; then
	echo "open -n drops VAQUITA_HOME on this Mac, so the update would relaunch into the default home; not going on" >&2
	exit 1
fi

cd "$repo/app"
npx tauri signer generate -w "$dir/key" -p '' >/dev/null
# The .pub file is already the base64 string the config's pubkey takes.
pub=$(cat "$dir/key.pub")
feed=http://127.0.0.1:1421/latest.json
conf() {
	jq -n --arg v "$1" --arg pub "$pub" --arg feed "$feed" --argjson artifacts "$2" '{
		version: $v,
		bundle: { createUpdaterArtifacts: $artifacts },
		plugins: { updater: { pubkey: $pub, endpoints: [$feed], dangerousInsecureTransportProtocol: true } }
	}'
}
conf 0.0.1 false >"$dir/old.json"
conf 0.0.2 true >"$dir/new.json"

built=$repo/app/src-tauri/target/release/bundle/macos
npx tauri build --config "$dir/old.json" >"$dir/build-old.log" 2>&1 || { echo "the old build failed; see $dir/build-old.log" >&2; exit 1; }
mkdir -p "$dir/app"
ditto "$built/vaquita.app" "$bundle"

TAURI_SIGNING_PRIVATE_KEY=$(cat "$dir/key") TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' \
	npx tauri build --config "$dir/new.json" >"$dir/build-new.log" 2>&1 || { echo "the new build failed; see $dir/build-new.log" >&2; exit 1; }
mkdir -p "$dir/www"
cp "$built/vaquita.app.tar.gz" "$dir/www/vaquita-0.0.2.app.tar.gz"
# The signature goes in without a trailing newline, as the updater decodes it strictly.
jq -n \
	--arg url http://127.0.0.1:1421/vaquita-0.0.2.app.tar.gz \
	--arg signature "$(cat "$built/vaquita.app.tar.gz.sig")" \
	--arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	'{ version: "0.0.2", notes: "", pub_date: $pub_date, platforms: { "darwin-aarch64": { url: $url, signature: $signature } } }' \
	>"$dir/www/latest.json"

cd "$dir/www"
nohup python3 -m http.server 1421 --bind 127.0.0.1 >"$dir/server.log" 2>&1 &
record server $!
i=0
until curl -fs -o /dev/null "$feed"; do
	i=$((i + 1))
	[ $i -le 50 ] || { echo "the feed did not come up; see $dir/server.log" >&2; exit 1; }
	sleep 0.1
done

cd "$dir"
VAQUITA_HOME=$vh nohup "$bundle/Contents/MacOS/vaquita" >"$dir/app.log" 2>&1 &
record app $!
echo "up: within about 15 s the app shows \"vaquita 0.0.2 is available.\"; click Update,"
echo "the app relaunches as 0.0.2 (quit that one with Cmd+Q when done), then run: $0 down $dir"
