# Working on vaquita

vaquita is a macOS app (Tauri v2 + Svelte 5 in `app/`) over a Go session daemon (`daemon/`). Read before changing code:

- [README.md](README.md) for what it is, [docs/app.md](docs/app.md) and [docs/daemon.md](docs/daemon.md) for how each part works, and [docs/decisions.md](docs/decisions.md) for why it is built that way.
- **[docs/app.md › Rules the app keeps](docs/app.md#rules-the-app-keeps)** before any change to the app, and **[docs/daemon.md › Rules the daemon keeps](docs/daemon.md#rules-the-daemon-keeps)** before any change to the daemon. Every plan and review checks a change against them.

Conventions:

- Code, comments, commit messages and docs are in English. Comments say why, not what, and match the density of the code around them.
- Examples and test data use neutral paths such as `/tmp/repo` or `~/src/example`, never real personal or company paths.
- Tests sit next to the code: vitest (happy-dom) in `app/src/lib`, `cargo test` in `app/src-tauri`, `go test` in `daemon`. Run `npm test`, `npm run check` and `cargo test` before calling app work done.
- A user-visible change to a release adds its lines to the top section of [CHANGELOG.md](CHANGELOG.md) before the tag.
