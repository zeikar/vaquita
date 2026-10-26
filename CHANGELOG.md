# Changelog

Each release's notes open with its section here.

## 0.1.8

- A message in the status line no longer stays until the next one. A failure shows in red for a minute; anything else, such as a path revealed in Finder or "vaquita is up to date", shows in grey for eight seconds. A click takes a message away, and hovering shows all of a long one.
- A second long path on a line Claude Code wraps, as in a before-and-after summary of two files, is one ⌘-clickable link too. It used to be split in two, the second half pointing at a file that does not exist.

## 0.1.7

- A file path Claude Code writes in backticks links only as far as its colour goes, also when Claude Code wraps it onto the next line, so text written right onto it, as Korean and Japanese often do, is no longer taken into the link and ⌘-click opens the file.

## 0.1.6

- An update no longer asks to restart the daemon unless the daemon itself changed. A daemon's build now names its code, and releases that leave the daemon alone ship the same one. Updating to this release still asks once, as the running daemon's build is from before.
- The update and daemon-restart notices are cards in the bottom right, over the terminal, so one coming or going no longer resizes the terminal. The daemon notice can be closed for the rest of the run, and the update notice says your sessions keep running through the relaunch.
- Buttons, focus rings and unread marks take the icon's cyan instead of the editor blue.

## 0.1.5

- Check for Updates… in the vaquita menu, under About, looks for a newer release at once. It brings back the update bar for a version you closed it for, and the status line says when vaquita is up to date or the check failed.
- Clicking a session from an earlier run, such as one that ended when the daemon restarted, reopens it. It used to only select the row; Reopen on hover and in the row's menu still work, and Rename is in that menu.

## 0.1.4

- vaquita updates itself. It checks for a newer release shortly after launch and every six hours, and a bar at the bottom offers it; one click downloads it, checks its signature, installs it in place and relaunches the app, while your sessions keep running in the daemon. There is no quarantine flag to clear afterwards. This is the first release that can do it, so install this one by hand; the ones after it arrive in the app.

## 0.1.3

- After the daemon restarts, a session that ran Claude Code can be reopened right away. The `caffeinate` Claude Code leaves running for up to five minutes, to keep the Mac awake, no longer counts as a process the session left behind.
- On macOS 26 and later, the Dock on a non-Retina display no longer shows the app icon small on a gray plate.
- A file path that Claude Code breaks onto the next line itself is one ⌘-clickable link again, as long as its first part reaches the right edge. If the joined path does not exist, ⌘-click opens the part under the pointer and the status line says so.
