# vaquita

A lightweight alternative to [Orca](https://www.onorca.dev/), the agent IDE, for macOS. It starts from the core: coding agents such as Claude Code and Codex running side by side, each in its own git worktree.

It's at the very start. The daemon works from the terminal, and the app exists in an early form: a session list that shows each agent's state, and one terminal. Alongside it is the tooling used to check the risky parts before building. The plan:

- Sessions live in a small daemon (`vaquitad`), so shells and agents keep running when the app restarts.
- One sidebar shows your repos, their worktrees and the sessions in each, with every agent's state: working, needs input, done.
- Agent state comes from what the agents already write to the terminal (OSC 7501 status reports and their notification sequences), so no hooks or global settings are needed.

## Install

Download `vaquita-<version>-macos-arm64.zip` from [Releases](https://github.com/zeikar/vaquita/releases) (Apple Silicon only), unzip it and move `vaquita.app` to `/Applications`. The app is signed with a self-signed certificate and not notarized, so clear the quarantine flag once (recursive, so the embedded daemon is covered too):

```sh
xattr -dr com.apple.quarantine /Applications/vaquita.app
```

The app installs and starts its daemon by itself. To update, quit vaquita and replace the app in Finder; don't `cp -R` over it while the daemon runs.

## Daemon

Build it and run a dev instance, which keeps its own home so a stable instance is untouched:

```sh
export VAQUITA_HOME=~/.vaquita-dev PATH=~/.vaquita-dev/bin:$PATH
make -C daemon            # builds $VAQUITA_HOME/bin/vaquitad
vaquitad serve
```

A daemon run by launchd should be signed with a stable identity, or macOS asks again for access to folders such as `~/Downloads` after every rebuild. A self-signed certificate is enough (Keychain Access → Certificate Assistant → Create a Certificate, type Code Signing): `make -C daemon SIGN="<certificate name>"`.

From another terminal, after the same `export`:

- `vaquitad ls` lists sessions.
- `vaquitad attach --new` starts a shell session and attaches to it; `attach --new -- <cmd>` runs a command such as an agent instead. `Ctrl-\` detaches and leaves the session running.
- `vaquitad install` writes a LaunchAgent plist into `$VAQUITA_HOME` and prints the `launchctl` commands that load and unload it. Nothing goes into `~/Library/LaunchAgents`, so nothing starts at login. `--bootstrap` also loads it into launchd; `--print` only prints the plist.

A session whose command starts with `codex`, from the app or from `attach --new -- codex`, runs it with `-c` options that turn on Codex's OSC 9 notifications for that session only: the daemon tells a finished Codex turn from a cancelled one by them. Codex typed into a plain shell session runs without them, so its finished turns are not shown.

## App

A Tauri app in `app/` (Svelte, xterm.js). It needs Node and Rust. Homebrew's `rustup` is keg-only, so put it on the path for cargo and tauri commands: `PATH="/opt/homebrew/opt/rustup/bin:$PATH"`.

Dev loop, with the dev daemon from above allowing the dev server's origin:

```sh
export VAQUITA_HOME=~/.vaquita-dev
vaquitad serve --allow-origin http://localhost:1420
# in another terminal, after the same export, in app/
npm ci
PATH="/opt/homebrew/opt/rustup/bin:$PATH" npm run tauri dev
```

`npm test` and `npm run check` need no daemon. `npm run test:live` talks to the running dev daemon.

What it does so far:

- A flat list of sessions, one terminal shown at a time. You can create and kill sessions.
- Sessions live in the daemon, so after an app restart the screen is restored.
- A fix for Korean IME input on WebKit, clickable links, file drop, and OSC 52 copy.
- Each session shows its agent's state: a spinner while it works, ⚠ with the permission or question it waits on, 🔑 when it needs a login, ✓ or ✗ when a turn ends, and a dot until you have looked at it.
- A desktop notification when an agent finishes, fails or needs input, unless that session is in front of you. Clicking it opens the session. Notifications missed while the app was closed are summed up in one when it reconnects.

A release build looks for the daemon and, if none is running, starts its LaunchAgent through launchd. When the agent is not loaded, it first installs it with the vaquitad inside the app, so no separate `vaquitad install` is needed. `tauri dev` never does; it shows a hint instead.

`npm run tauri build` produces `app/src-tauri/target/release/bundle/macos/vaquita.app`, with vaquitad built into it; set `VAQUITA_SIGN_IDENTITY` to sign that vaquitad with a stable identity, as `SIGN` does above. To pass `VAQUITA_HOME`, run `vaquita.app/Contents/MacOS/vaquita` directly. Without it the app uses the default home, `~/Library/Application Support/vaquita`.

## tools/probe

- `probe.py` runs Claude Code or Codex in a PTY, answers terminal queries, and records queries, mode changes, OSC 7501 reports and OSC 9/777 notifications.
  `python3 -I tools/probe/probe.py <claude|claude-noanswer|claude-perm|claude-perm-ghostty|claude-perm-ghostty-blur|codex|codex-notify|codex-plan|codex-question> <out-dir>`
- `accept.py` checks the daemon end to end through `vaquitad attach`, with a PTY standing in for the terminal: re-attaching to a running `claude`, bracketed paste after more than 1MB of output, and a session under launchd (agent socket, `~/Downloads` access, `go test` time against the calling shell). It uses the dev instance and needs its daemon running; see the script's docstring.
  `python3 -I tools/probe/accept.py <claude|paste|launchd> <out-dir>`
- `test.html` and `main.swift` are a WKWebView test bed for xterm.js: a fix for macOS Korean IME input on WebKit, and background-throttling measurements. Run `npm ci` in `tools/probe` first.
- `serve.py` and `serve2.py` are loopback helpers for the page.

## License

[MIT](LICENSE)
