# App

A Tauri app in `app/` (Svelte, xterm.js). It needs Node and Rust. Homebrew's `rustup` is keg-only, so put it on the path for cargo and tauri commands: `PATH="/opt/homebrew/opt/rustup/bin:$PATH"`.

## Dev loop

With a dev daemon (see [daemon.md](daemon.md)) allowing the dev server's origin:

```sh
export VAQUITA_HOME=~/.vaquita-dev
vaquitad serve --allow-origin http://localhost:1420
# in another terminal, after the same export, in app/
npm ci
PATH="/opt/homebrew/opt/rustup/bin:$PATH" npm run tauri dev
```

`npm test` and `npm run check` need no daemon. `npm run test:live` talks to the running dev daemon.

## What it does so far

- One terminal shown at a time, in the first tab of a bar above it; files open in tabs after it (see below).
- The sidebar is grouped by repo: a session belongs to the repo whose path is the longest prefix of its folder, matched by path component, and the rest sit under "other". A click on a group's header collapses it, and it stays collapsed across restarts. Add a repo with the `+` button (a folder picker), by dropping a folder on the sidebar, or with `vaquitad repos add`.
- ⌘B or the button at the left of the status line hides the sidebar and shows it again. Dragging its right edge sets its width, from 200 to 480 pixels, and a double-click on the edge sets it back to 280. The terminal takes its new size once the edge is let go, so an agent redraws once rather than all through the drag. Both the width and whether it is hidden are kept across restarts.
- Hovering a repo's header shows buttons that start claude or codex in it. Its `⋯` button or a right-click opens a menu to start claude, codex or a shell there, reveal the folder in Finder, or remove the repo from the list (its sessions keep running).
- Each session is a row of two lines. The first has the Claude or OpenAI mark for an agent (a terminal icon for a shell, a box for any other command), the title, the state and the unread dot; the second has the state's message, else "from an earlier run", else the folder, shortened as in `~/D/P/example`. Hovering a row shows its Kill button; a right-click opens a menu to rename it, copy its path, reveal it in Finder or kill it.
- Sessions from an earlier daemon run are listed under their repo as "from an earlier run". Clicking one reopens it, as Reopen on hover and in the row's menu does; Dismiss is beside it, and Rename is in the menu.
- New session, the button at the bottom of the sidebar, ⌘T or a right-click on the sidebar's empty space, opens a dialog for the folder (a repo, or any absolute path; it starts in the selected session's repo, else in the folder of the last session it made), the kind (shell, Claude or Codex) and an optional name.
- A session is titled by the name you gave it, else by the topic Claude Code or Codex gives its conversation (kept across restarts), else by its command. Double-click a title, or choose Rename in its menu, to rename the session; clear it to go back to the agent's title.
- Sessions live in the daemon, so after an app restart the screen is restored.
- A fix for Korean IME input on WebKit, file drop, and OSC 52 copy.
- ⌘-click opens a link: a web link in the browser; a `file://` link from an agent or a tool, or a path in the text (absolute, `~/…`, or relative to the folder the session started in): text, code, Markdown, images, audio and video open in a tab of the app (below); anything else opens in its default app: a folder in Finder, a document in the app that owns it. Terminal output is not trusted, so some paths are only revealed in Finder, and the status line says why: executables; Finder aliases, and files whose Finder info cannot be read; app bundles, installers and profiles, shell scripts, Terminal and Automator files, and stored links (`.webloc` and the like), also anything inside an app bundle; files whose default app runs or installs what it opens (Terminal, Installer, Python Launcher, Java, Automator's installer, Keychain Access, the iOS app installer, Shortcuts, the input-method registrar) or is Finder itself; and files no app opens, unless they are text or Markdown, which open in a tab. A `.py` file is text, so it opens in a tab; one that cannot be read as text goes to its default app, unless Python Launcher owns it. A third-party app that runs what it opens, set as a default app, is not on that list. A path that does not exist, or a `file://` link to another host, is reported in the status line too. A relative path is taken from the starting folder even after a `cd`, so it may miss; paths with spaces are not detected, and neither is a single-segment path such as `/tmp` (so that `/help` and other slash commands are left alone). Colour bounds a path too, also one joined across lines: where a colour other than the default ends, the path ends, and where one begins, a path may begin. Claude Code draws a path in backticks in a colour of its own, so with a word written right onto it (`~/.zshrc을`, `파일은~/a.ts`) the link is the path alone. That holds next to a `/` too, so a folder in backticks (`~/src/`) does not take the word after it, though a prompt that colours one path in parts has it cut there; text in the default colour reads as before. A path an agent wraps onto the next line itself, indenting the rest, is joined back while each part but the last reaches the right edge and does not already end in a file extension; if the joined path does not exist, the status line says so and ⌘-click opens the part under the pointer instead, or else the first part, when that is a path by itself. The daemon sets `FORCE_HYPERLINK=1` so Claude Code and other Node tools emit the links; they then emit them into piped output as well, and `FORCE_HYPERLINK=0 <cmd>` turns that off for one command.
- Tabs: the terminal is always the first tab (⌘1), and the files opened from it follow. Tabs are grouped per repo, and sessions outside a registered repo share one group; they are restored after a relaunch, with the terminal shown first. ⌘W closes the shown file tab, or the window on the terminal tab; Next and Previous Tab in the View menu are ⌘⇧] and ⌘⇧[, which work everywhere; ⌃Tab and ⌃⇧Tab do the same inside the app.
- What opens in a tab: images, audio and video by extension (a PDF opens in its default app, such as Preview); text and code up to 2 MiB that is valid UTF-8 (also a file with no extension) in a Monaco editor, with ⌘S to save. Markdown (`.md`, `.markdown`) opens as a preview with its source one click away; the preview is sanitized, so it shows no images, media, SVG, forms, styles, classes or ids, links open in the browser, and task-list boxes show as ☐ and ☑. A tab you have not edited reads the file again each time it is shown, so an agent's edits appear. An edited tab keeps its text, and ⌘S asks first if the file changed on disk; a read-only file cannot be saved. Closing an edited tab, ⌘W on the terminal tab and the window's close button ask about unsaved edits.
- Step one's limits: no file tree yet, and ⌘Q does not ask about unsaved edits.
- Each session shows its agent's state: a spinner while it works, ⚠ with the permission or question it waits on, 🔑 when it needs a login, ✓ or ✗ when a turn ends, and a dot until you have looked at it. A collapsed repo shows ⚠ or 🔑 and the dot for the sessions it hides.
- A desktop notification when an agent finishes, fails or needs input, unless that session is in front of you. Clicking it opens the session. Notifications missed while the app was closed are summed up in one when it reconnects. A `tauri dev` run, which is not an app bundle, shows none.
- The status line at the bottom shows whether the daemon is connected, and why not while it is not. What came of something you did shows there for a while: a failure in red for a minute, anything else, such as a path revealed in Finder, in grey for eight seconds. A click on it takes it away, and hovering shows all of a long one.

## Release build

A release build looks for the daemon and, if none is running, starts its LaunchAgent through launchd. When the agent is not loaded, it first installs it with the vaquitad inside the app, so no separate `vaquitad install` is needed. `tauri dev` never does; it shows a hint instead.

A release build also replaces a running daemon that is not the vaquitad inside it, as after an update that changed the daemon: the build the daemon reports (`vaquitad version`, a release's version, a `+` and a fingerprint of the daemon's code) names other code than that of the vaquitad inside the app. A release that leaves the daemon's code alone keeps its fingerprint, so updating to it restarts no daemon. When no session is running, it asks the daemon to stop, which the daemon does only if still none is running or starting, and then starts its own vaquitad. Otherwise a notice offers a restart, since running sessions end with the daemon (they stay listed and can be reopened); × (Not now) hides it until the app starts again. A daemon from before builds (0.1.0-rc.3 and earlier) cannot make that check, so it is only ever offered. The app restarts a daemon by itself once per app run at most, and stops none when it could not start its own, such as when it runs from a translocated copy. A daemon built with a plain `make`, whose build is `dev`, is left alone, and a local `npm run tauri build`, whose vaquitad is `dev`, replaces none.

`npm run tauri build` produces `app/src-tauri/target/release/bundle/macos/vaquita.app`, with vaquitad built into it, at `vaquita.app/Contents/Helpers/vaquitad.app/Contents/MacOS/vaquitad`. That is a helper app whose Info.plist has the app's bundle id, name and icon (and `LSUIElement`, so it has no Dock tile), and whose signature carries the app's identifier, so macOS privacy settings list the folders the daemon is let into under the one "vaquita" entry rather than a second, "vaquitad", with a generic icon. `npm run build:daemon` builds and signs it with `app/scripts/helper-app.sh` before Tauri bundles the app. Without `VAQUITA_SIGN_IDENTITY` it is signed ad hoc, which macOS still counts as a separate client; with it, the helper is signed with the app's identifier, and a release's helper passes the app's designated requirement, which the release workflow checks. The first release with the helper changes the daemon's build, so the app restarts the daemon once (by itself with no session running, else after a notice), and its LaunchAgent then points at the helper. That vaquitad's build is `dev` unless `VERSION` is set; the release sets both it and the app's version from the tag, and the Makefile then adds the fingerprint, which it takes from the daemon's files as committed (tests left out), so a build with `VERSION` needs git. To pass `VAQUITA_HOME`, run `vaquita.app/Contents/MacOS/vaquita` directly. Without it the app uses the default home, `~/Library/Application Support/vaquita`.

Pushing a `v<version>` tag (`v0.1.3`, or `v0.1.3-rc.1` for a prerelease) runs `.github/workflows/release.yml`, which tests, builds, signs and publishes the zip, and the archive and feed the app updates from ([Updates](#updates)). The release's notes open with that version's section of `CHANGELOG.md`, so add it before tagging: a release without one fails before it builds, and a prerelease goes out without.

## Updates

Only a release build looks for updates. `tauri.conf.json` holds the public key update archives are signed with but no feed; the release workflow adds the feed, `https://github.com/zeikar/vaquita/releases/latest/download/latest.json`, so `tauri dev` and a local `npm run tauri build` never check. That is the latest release's feed, and GitHub's latest skips prereleases, so a prerelease is never offered.

The app checks 15 s after it starts and every six hours after that. A failed check, as when offline, shows nothing in the app; a release build has no web inspector, so the reason goes to the app's stderr. A newer version shows a notice in the bottom right, above the status line and over the terminal, so the terminal keeps its size: What's new opens its release page, Update installs it, and × (Not now) hides it until a still newer one is out or the app starts again. Check for Updates… in the app menu, under About, checks at once: it brings the notice back for a version it was closed for, and says in the status line when there is nothing newer or the check failed. Only a build with the feed has that item.

Update downloads `vaquita-<version>-macos-arm64.app.tar.gz` and checks its minisign signature against that key. The signature also names the version it was made for, which must be the feed's (`requireSignedVersion`), so an altered feed cannot pass an older release off as a newer one. The app then swaps the new bundle in for itself, in one step on APFS; where it cannot write, macOS asks for an administrator's password. The app downloaded the archive itself, so the new bundle has no quarantine flag to clear. It quits and is opened again with `open` once it is gone, so it comes back in the tile you keep in the Dock rather than a second one (`open -n`, which starts it while the old one still runs, makes that second tile); `open` passes on the environment, so an app started with `VAQUITA_HOME` comes back in the same home. A failed install, or a download that does not finish within five minutes, shows its reason in the notice with Retry.

Sessions keep running through an update, in the daemon. The daemon still runs its old binary afterwards, until the relaunched app replaces it as described above: by itself when no session is running, else once you confirm.

The release workflow signs the archive with the private key in the `VAQUITA_UPDATER_KEY` and `VAQUITA_UPDATER_KEY_PASSWORD` repository secrets; it is not in the repo. Before it publishes, it checks that the archive is signed with the key `tauri.conf.json` trusts and for the version being released, and that the app inside passes the same signature checks as the zip's.

## Footprint

Measured on 2026-10-29 with a release build on an Apple Silicon Mac: 13 shell sessions, 9 of them holding about 300 lines of output, one of those on screen, left idle for a minute. Memory is macOS's `footprint` (the Memory column of Activity Monitor) of the app, the three WebKit processes it starts and `vaquitad`; the shells and agents in the sessions are not counted. Together they came to about 205 MB (app 32, WebKit 156, daemon 16), and about 110 MB with 10 sessions and no terminal on screen. Opening the first file in a text tab loads Monaco and brings it to about 320 MB; Monaco stays loaded once the tab is closed (about 300 MB) until the app restarts; an app run that never opens a text file never loads it. Idle CPU over each minute was 0% in `ps`.

## Icon

`app/app-icon.png` is the source of the app icon. Its body must be Apple's rounded square exactly, 824 × 824 at 100, 100 on the 1024 canvas, and fully opaque: macOS 26 and later checks each size in the icon on its own, and one that is a few pixels off or slightly see-through is drawn small on a gray plate, as the Dock did on a non-Retina display. After changing it, run `npx tauri icon app-icon.png` in `app/` and delete the `android/`, `ios/` and `64x64.png` it also writes into `src-tauri/icons/`, which the app does not use.

Any build but a release, `tauri dev` included, has `app/app-icon-dev.png` as its icon: the same with an orange D in the top right, inside the body, so a dev build is told apart from the installed app in the Dock and the app switcher. `tauri.conf.json` names `src-tauri/icons-dev/`, and the release workflow names `src-tauri/icons/` instead and checks that the app it built has that icon. After changing the icon, draw the badge again in the same place, run `npx tauri icon app-icon-dev.png -o <a temp folder>` and copy the five files `tauri.conf.json` lists from there into `src-tauri/icons-dev/`. The daemon's helper app follows the same split through `VAQUITA_HELPER_ICON` (`icons-dev/icon.icns` by default), which the release workflow sets to `icons/icon.icns`, and keeps only its sizes up to 256 pixels, which is all its rows in System Settings show.

## Screenshot

The README's screenshot is of a demo that `tools/screenshot/demo.sh` sets up in a new folder: a daemon and a HOME of its own, three repos, sessions (seeded by `sessions.mjs`) in which `fake-agent.sh` reports states the way Claude Code and Codex do, and one real Claude Code session that answers a short question with your login. To take it again, with port 1420 free and claude logged in:

```sh
PATH="/opt/homebrew/opt/rustup/bin:$PATH" tools/screenshot/demo.sh up /tmp/vaquita-demo
# once claude has answered, select its row under vaquita
screencapture -iw docs/screenshot.png   # then click the app's window
tools/screenshot/demo.sh down /tmp/vaquita-demo
rm -rf /tmp/vaquita-demo
```

## Update check

`tools/update-check/check.sh` runs the in-app update once, end to end, on this Mac: it builds a 0.0.1 bundle and a 0.0.2 bundle signed with a throwaway key, serves the update feed on 127.0.0.1:1421, and opens the old bundle. It proves that the app finds the feed, checks the signature, swaps the bundle and relaunches with `VAQUITA_HOME` kept.

It needs node, cargo, python3 and a running dev daemon for `~/.vaquita-dev` from a plain `make` (so its build is `dev`; a release build that finds another build's daemon may restart it, and one that finds none installs a LaunchAgent). The script refuses otherwise, and also when `/usr/bin/open` drops the environment on this Mac, which it tests first with a stand-in bundle. It touches neither `/Applications` nor the default home.

```sh
PATH="/opt/homebrew/opt/rustup/bin:$PATH" tools/update-check/check.sh up /tmp/vaquita-update-check
# within about 15 s a notice says "vaquita 0.0.2 is available."; click Update by hand,
# the app relaunches as 0.0.2; quit it with Cmd+Q
tools/update-check/check.sh down /tmp/vaquita-update-check   # PASS or FAIL
rm -rf /tmp/vaquita-update-check
```

`down` prints `PASS: the bundle is 0.0.2` or `FAIL: the bundle is still <version>` (and exits 1), and stops the feed server and the old app if still running.
