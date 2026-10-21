# vaquita

A lightweight alternative to [Orca](https://www.onorca.dev/), the agent IDE, for macOS. It starts from the core: coding agents such as Claude Code and Codex running side by side, each in its own git worktree.

It's at the very start. The daemon works from the terminal; the app doesn't exist yet. Alongside it is the tooling used to check the risky parts before building. The plan:

- Sessions live in a small daemon (`vaquitad`), so shells and agents keep running when the app restarts.
- One sidebar shows your repos, their worktrees and the sessions in each, with every agent's state: working, needs input, done.
- Agent state comes from what the agents already write to the terminal (OSC 7501 status reports and their notification sequences), so no hooks or global settings are needed.

## Daemon

Build it and run a dev instance, which keeps its own home so a stable instance is untouched:

```sh
cd daemon && go build -o ~/.vaquita-dev/bin/vaquitad ./cmd/vaquitad
export VAQUITA_HOME=~/.vaquita-dev PATH=~/.vaquita-dev/bin:$PATH
vaquitad serve
```

From another terminal, after the same `export`:

- `vaquitad ls` lists sessions.
- `vaquitad attach --new` starts a shell session and attaches to it; `attach --new -- <cmd>` runs a command such as an agent instead. `Ctrl-\` detaches and leaves the session running.
- `vaquitad install --print` prints the LaunchAgent plist without writing anything.

## tools/probe

- `probe.py` runs Claude Code or Codex in a PTY, answers terminal queries, and records queries, mode changes, OSC 7501 reports and OSC 9/777 notifications.
  `python3 -I tools/probe/probe.py <claude|claude-noanswer|claude-perm|claude-perm-ghostty|claude-perm-ghostty-blur|codex|codex-notify> <out-dir>`
- `test.html` and `main.swift` are a WKWebView test bed for xterm.js: a fix for macOS Korean IME input on WebKit, and background-throttling measurements. Run `npm ci` in `tools/probe` first.
- `serve.py` and `serve2.py` are loopback helpers for the page.

## License

[MIT](LICENSE)
