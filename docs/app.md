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

- One terminal shown at a time.
- The sidebar is grouped by repo: a session belongs to the repo whose path is the longest prefix of its folder, matched by path component, and the rest sit under "other". A click on a group's header collapses it, and it stays collapsed across restarts. Add a repo with the `+` button (a folder picker), by dropping a folder on the sidebar, or with `vaquitad repos add`.
- Hovering a repo's header shows buttons that start claude or codex in it. Its `⋯` button or a right-click opens a menu to start claude, codex or a shell there, reveal the folder in Finder, or remove the repo from the list (its sessions keep running).
- Each session is a row of two lines. The first has the Claude or OpenAI mark for an agent (a terminal icon for a shell, a box for any other command), the title, the state and the unread dot; the second has the state's message, else "from an earlier run", else the folder, shortened as in `~/D/P/example`. Hovering a row shows its Kill button; a right-click opens a menu to rename it, copy its path, reveal it in Finder or kill it.
- Sessions from an earlier daemon run are listed under their repo as "from an earlier run", with Reopen and Dismiss on hover and in the row's menu.
- New session, the button at the bottom of the sidebar, ⌘T or a right-click on the sidebar's empty space, opens a dialog for the folder (a repo, or any absolute path; it starts in the selected session's repo, else in the folder of the last session it made), the kind (shell, Claude or Codex) and an optional name.
- A session is titled by the name you gave it, else by the topic Claude Code or Codex gives its conversation (kept across restarts), else by its command. Double-click a title, or choose Rename in its menu, to rename the session; clear it to go back to the agent's title.
- Sessions live in the daemon, so after an app restart the screen is restored.
- A fix for Korean IME input on WebKit, clickable links, file drop, and OSC 52 copy.
- Each session shows its agent's state: a spinner while it works, ⚠ with the permission or question it waits on, 🔑 when it needs a login, ✓ or ✗ when a turn ends, and a dot until you have looked at it. A collapsed repo shows ⚠ or 🔑 and the dot for the sessions it hides.
- A desktop notification when an agent finishes, fails or needs input, unless that session is in front of you. Clicking it opens the session. Notifications missed while the app was closed are summed up in one when it reconnects. A `tauri dev` run, which is not an app bundle, shows none.

## Release build

A release build looks for the daemon and, if none is running, starts its LaunchAgent through launchd. When the agent is not loaded, it first installs it with the vaquitad inside the app, so no separate `vaquitad install` is needed. `tauri dev` never does; it shows a hint instead.

A release build also replaces a running daemon that is not the vaquitad inside it, as after the app was updated: the daemon's build (`vaquitad version`) differs from the app's version. When no session is running, it asks the daemon to stop, which the daemon does only if still none is running or starting, and then starts its own vaquitad. Otherwise a bar offers a restart, since running sessions end with the daemon (they stay listed and can be reopened). A daemon from before builds (0.1.0-rc.3 and earlier) cannot make that check, so it is only ever offered. The app restarts a daemon by itself once per app run at most, and stops none when it could not start its own, such as when it runs from a translocated copy. A daemon built with a plain `make`, whose build is `dev`, is left alone.

`npm run tauri build` produces `app/src-tauri/target/release/bundle/macos/vaquita.app`, with vaquitad built into it; set `VAQUITA_SIGN_IDENTITY` to sign that vaquitad with a stable identity, as `SIGN` does for the daemon. That vaquitad's build is `dev` unless `VERSION` is set; the release sets both it and the app's version from the tag. To pass `VAQUITA_HOME`, run `vaquita.app/Contents/MacOS/vaquita` directly. Without it the app uses the default home, `~/Library/Application Support/vaquita`.

## Icon

`app/app-icon.png` is the source of the app icon. After changing it, run `npx tauri icon app-icon.png` in `app/` and delete the `android/`, `ios/` and `64x64.png` it also writes into `src-tauri/icons/`, which the app does not use.

## Screenshot

The README's screenshot is of a demo that `tools/screenshot/demo.sh` sets up in a new folder: a daemon and a HOME of its own, three repos, sessions (seeded by `sessions.mjs`) in which `fake-agent.sh` reports states the way Claude Code and Codex do, and one real Claude Code session that answers a short question with your login. To take it again, with port 1420 free and claude logged in:

```sh
PATH="/opt/homebrew/opt/rustup/bin:$PATH" tools/screenshot/demo.sh up /tmp/vaquita-demo
# once claude has answered, select its row under vaquita
screencapture -iw docs/screenshot.png   # then click the app's window
tools/screenshot/demo.sh down /tmp/vaquita-demo
rm -rf /tmp/vaquita-demo
```
