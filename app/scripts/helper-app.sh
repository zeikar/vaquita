#!/bin/bash
# Wraps the built vaquitad in a helper app, Contents/Helpers/vaquitad.app in
# vaquita.app, that carries the app's identifier. macOS privacy (TCC) then
# counts the daemon as part of vaquita rather than as a second client.
# Run from app/: scripts/helper-app.sh <vaquitad> <vaquitad.app>
set -eu

bin="$1"
out="$2"
id="$(plutil -extract identifier raw -o - src-tauri/tauri.conf.json)"
if [ -z "$id" ]; then
	echo "helper-app.sh: no identifier in src-tauri/tauri.conf.json" >&2
	exit 1
fi

rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
cp "$bin" "$out/Contents/MacOS/vaquitad"

# The icon only shows in small rows, such as System Settings' privacy lists;
# its sizes up to 256 pixels keep the download over 1 MB smaller.
icons="$(mktemp -d)"
trap 'rm -rf "$icons"' EXIT
iconutil -c iconset -o "$icons/full.iconset" "src-tauri/${VAQUITA_HELPER_ICON:-icons-dev/icon.icns}"
mkdir "$icons/small.iconset"
for size in 16x16 16x16@2x 32x32 32x32@2x 128x128 128x128@2x; do
	cp "$icons/full.iconset/icon_$size.png" "$icons/small.iconset/"
done
iconutil -c icns -o "$out/Contents/Resources/icon.icns" "$icons/small.iconset"

# CFBundleVersion 0 is below the app's, so LaunchServices prefers vaquita.app
# over this helper, which shares its identifier.
cat > "$out/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>$id</string>
	<key>CFBundleName</key>
	<string>vaquita</string>
	<key>CFBundleDisplayName</key>
	<string>vaquita</string>
	<key>CFBundleExecutable</key>
	<string>vaquitad</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleIconFile</key>
	<string>icon.icns</string>
	<key>CFBundleVersion</key>
	<string>0</string>
	<key>CFBundleShortVersionString</key>
	<string>${VERSION:-0}</string>
	<key>LSUIElement</key>
	<true/>
</dict>
</plist>
PLIST
plutil -lint "$out/Contents/Info.plist"

# Tauri seals the outer app over its nested code without signing it, and
# sealing needs the helper already signed. The app's identifier lets the
# helper satisfy the app's designated requirement, so TCC sees one app.
codesign --force --sign "${VAQUITA_SIGN_IDENTITY:--}" --identifier "$id" "$out"
codesign --verify --strict "$out"
info="$(codesign -dv --verbose=2 "$out" 2>&1)"
if ! grep -qxF "Identifier=$id" <<< "$info"; then
	echo "helper-app.sh: $out is not signed as $id" >&2
	echo "$info" >&2
	exit 1
fi
