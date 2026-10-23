# tools/probe

The tooling used to check the risky parts before building.

- `probe.py` runs Claude Code or Codex in a PTY, answers terminal queries, and records queries, mode changes, OSC 7501 reports and OSC 9/777 notifications.
  `python3 -I tools/probe/probe.py <claude|claude-noanswer|claude-perm|claude-perm-ghostty|claude-perm-ghostty-blur|codex|codex-notify|codex-plan|codex-question> <out-dir>`
- `accept.py` checks the daemon end to end through `vaquitad attach`, with a PTY standing in for the terminal: re-attaching to a running `claude`, bracketed paste after more than 1MB of output, and a session under launchd (agent socket, `~/Downloads` access, `go test` time against the calling shell). It uses the dev instance and needs its daemon running; see the script's docstring.
  `python3 -I tools/probe/accept.py <claude|paste|launchd> <out-dir>`
- `test.html` and `main.swift` are a WKWebView test bed for xterm.js: a fix for macOS Korean IME input on WebKit, and background-throttling measurements. Run `npm ci` in `tools/probe` first.
- `serve.py` and `serve2.py` are loopback helpers for the page.
