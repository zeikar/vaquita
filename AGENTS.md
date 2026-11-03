# Working on vaquita

vaquita is a macOS app (Tauri v2 + Svelte 5 in `app/`) over a Go session daemon (`daemon/`). Read before changing code:

- [README.md](README.md) for what it is, [docs/app.md](docs/app.md) and [docs/daemon.md](docs/daemon.md) for how each part works, and [docs/decisions.md](docs/decisions.md) for why it is built that way.
- **[docs/app.md › Rules the app keeps](docs/app.md#rules-the-app-keeps)** before any change to the app, and **[docs/daemon.md › Rules the daemon keeps](docs/daemon.md#rules-the-daemon-keeps)** before any change to the daemon. Every plan and review checks a change against them.

Conventions:

- Code, comments, commit messages and docs are in English. Comments say why, not what, and match the density of the code around them.
- Examples and test data use neutral paths such as `/tmp/repo` or `~/src/example`, never real personal or company paths.
- UI changes can be checked in a browser with [tools/browser](docs/app.md#browser-check) before the built app.
- Tests sit next to the code: vitest (happy-dom) in `app/src/lib`, `cargo test` in `app/src-tauri`, `go test` in `daemon`. Run `npm test`, `npm run check` and `cargo test` before calling app work done.
- A user-visible change to a release adds its lines to the top section of [CHANGELOG.md](CHANGELOG.md) before the tag.
- A release is a pushed `vX.Y.Z` tag: `.github/workflows/release.yml` builds, signs and publishes it, with that version's CHANGELOG section as the top of its notes, and fails without one. A `vX.Y.Z-rc.N` tag is a prerelease, which may go without and never reaches the in-app updater.

Safety:

- Never touch an installed vaquita, its app or its home (`~/Library/Application Support/vaquita`); work against a dev daemon (`VAQUITA_HOME=~/.vaquita-dev`, see [docs/app.md › Dev loop](docs/app.md#dev-loop)). Ask before installing or bootstrapping a LaunchAgent.
- Stop only the processes you started, by their PIDs, never by a broad pattern such as `pkill -f vite`.
- Two agents working in one clone use separate git worktrees: switching branches under another session breaks its work.
- After a crash, start from [docs/app.md › When the app crashes](docs/app.md#when-the-app-crashes).
