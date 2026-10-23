# vaquita

A lightweight alternative to [Orca](https://www.onorca.dev/), the agent IDE, for macOS. It starts from the core: coding agents such as Claude Code and Codex running side by side in the repos they work on.

It's at the very start. The daemon works from the terminal, and the app exists in an early form: a session list grouped by repo that shows each agent's state, and one terminal. Alongside it is the tooling used to check the risky parts before building. The plan:

- Sessions live in a small daemon (`vaquitad`), so shells and agents keep running when the app restarts.
- One sidebar shows your repos and the sessions in each, with every agent's state: working, needs input, done.
- Agent state comes from what the agents already write to the terminal (OSC 7501 status reports and their notification sequences), so no hooks or global settings are needed.

## Install

Download `vaquita-<version>-macos-arm64.zip` from [Releases](https://github.com/zeikar/vaquita/releases) (Apple Silicon only), unzip it and move `vaquita.app` to `/Applications`. The app is signed with a self-signed certificate and not notarized, so clear the quarantine flag once (recursive, so the embedded daemon is covered too):

```sh
xattr -dr com.apple.quarantine /Applications/vaquita.app
```

The app installs and starts its daemon by itself. To update, quit vaquita and replace the app in Finder; don't `cp -R` over it while the daemon runs.

## Develop

A dev instance keeps its own home, so a stable install is untouched:

```sh
export VAQUITA_HOME=~/.vaquita-dev PATH=~/.vaquita-dev/bin:$PATH
make -C daemon
vaquitad serve --allow-origin http://localhost:1420
# in another terminal, after the same export, in app/
npm ci
PATH="/opt/homebrew/opt/rustup/bin:$PATH" npm run tauri dev
```

## Docs

- [Daemon](docs/daemon.md): `vaquitad` commands, Codex notifications, reopening sessions after a restart.
- [App](docs/app.md): the dev loop, what the app does so far, release builds.
- [tools/probe](docs/probe.md): the recorders and test beds used to check the risky parts.

## License

[MIT](LICENSE)
