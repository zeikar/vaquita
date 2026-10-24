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

- One terminal shown at a time. You can create and kill sessions.
- The sidebar is grouped by repo. Add a repo with the folder picker or `vaquitad repos add`; a session belongs to the repo whose path is the longest prefix of its folder, matched by path component, and the rest sit under "other". Each repo has claude and codex buttons that start an agent in it, and a button to remove it from the list (its sessions keep running).
- Sessions from an earlier daemon run are listed under their repo as "from an earlier run", with Reopen and Dismiss.
- A session is titled by the name you gave it, else by the topic Claude Code or Codex gives its conversation (kept across restarts), else by its command.
- Sessions live in the daemon, so after an app restart the screen is restored.
- A fix for Korean IME input on WebKit, clickable links, file drop, and OSC 52 copy.
- Each session shows its agent's state: a spinner while it works, ⚠ with the permission or question it waits on, 🔑 when it needs a login, ✓ or ✗ when a turn ends, and a dot until you have looked at it.
- A desktop notification when an agent finishes, fails or needs input, unless that session is in front of you. Clicking it opens the session. Notifications missed while the app was closed are summed up in one when it reconnects. A `tauri dev` run, which is not an app bundle, shows none.

## Release build

A release build looks for the daemon and, if none is running, starts its LaunchAgent through launchd. When the agent is not loaded, it first installs it with the vaquitad inside the app, so no separate `vaquitad install` is needed. `tauri dev` never does; it shows a hint instead.

A release build also replaces a running daemon that is not the vaquitad inside it, as after the app was updated: the daemon's build (`vaquitad version`) differs from the app's version. When no session is running, it asks the daemon to stop, which the daemon does only if still none is running or starting, and then starts its own vaquitad. Otherwise a bar offers a restart, since running sessions end with the daemon (they stay listed and can be reopened). A daemon from before builds (0.1.0-rc.3 and earlier) cannot make that check, so it is only ever offered. The app restarts a daemon by itself once per app run at most, and stops none when it could not start its own, such as when it runs from a translocated copy. A daemon built with a plain `make`, whose build is `dev`, is left alone.

`npm run tauri build` produces `app/src-tauri/target/release/bundle/macos/vaquita.app`, with vaquitad built into it; set `VAQUITA_SIGN_IDENTITY` to sign that vaquitad with a stable identity, as `SIGN` does for the daemon. That vaquitad's build is `dev` unless `VERSION` is set; the release sets both it and the app's version from the tag. To pass `VAQUITA_HOME`, run `vaquita.app/Contents/MacOS/vaquita` directly. Without it the app uses the default home, `~/Library/Application Support/vaquita`.
