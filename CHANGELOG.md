# Changelog

Each release's notes open with its section here.

## 0.1.4

- vaquita updates itself. It checks for a newer release shortly after launch and every six hours, and a bar at the bottom offers it; one click downloads it, checks its signature, installs it in place and relaunches the app, while your sessions keep running in the daemon. There is no quarantine flag to clear afterwards. This is the first release that can do it, so install this one by hand; the ones after it arrive in the app.

## 0.1.3

- After the daemon restarts, a session that ran Claude Code can be reopened right away. The `caffeinate` Claude Code leaves running for up to five minutes, to keep the Mac awake, no longer counts as a process the session left behind.
- On macOS 26 and later, the Dock on a non-Retina display no longer shows the app icon small on a gray plate.
- A file path that Claude Code breaks onto the next line itself is one ⌘-clickable link again, as long as its first part reaches the right edge. If the joined path does not exist, ⌘-click opens the part under the pointer and the status line says so.
