# Design decisions

Why vaquita is built the way it is. [app.md](app.md) and [daemon.md](daemon.md) say what each part does and the rules a change keeps; this page gives the reasons behind them, and what would make a decision worth revisiting. Dates appear only where a decision changed.

## Why it exists

vaquita keeps the part of [Orca](https://www.onorca.dev/) that was used every day, running agents and terminals side by side, and drops the weight. Measured on a test machine with about ten mostly idle sessions, Orca ran 11 processes with about 1.4 GB of resident memory and about 15% CPU in total. Most of that came from its design rather than from Electron:

- the same PTY output is parsed by three VT emulators (a headless one in its daemon, one in its main process, and the renderer's);
- more than ten servers, workers and pollers run from startup;
- external commands run on timers (`git worktree list` every 2 s, `git status` every 3 s, `gh` every 1 to 2 minutes, `lsof` every 30 s);
- terminal daemons of different protocol versions run at once.

Of Orca's features, running agents and terminal tabs were used constantly, usage tracking now and then, and the browser, split panes and automations almost never.

## Goals and non-goals

Goals, in order:

1. **Sessions survive the app.** Shells and agents keep running when the app quits, crashes or updates. While vaquita is developed with vaquita, a dev app restarts dozens of times a day.
2. **Every repo and its sessions in one sidebar**, each session with its agent's state: working, waiting for input, or done.
3. **Notifications** when a turn ends or an agent waits.
4. **Light**: targets were a daemon under 30 MB plus 1 MB per session, the app with its WebKit processes under 200 to 250 MB, and next to no idle CPU. All three were met ([Footprint](app.md#footprint)).

Not built, on purpose:

- **Hooks or edits to the agents' settings.** Claude Code and Codex already report their state in the terminal ([below](#agent-state-without-hooks)).
- **SSH, Windows, Linux, mobile.**
- **A built-in browser, a chat UI, issue trackers.**
- **Source control, pull requests, checks, ports, plugins.** The files panel shows and edits files, and lists and diffs what changed since the last commit, read-only, and stops there.
- **Split panes**, until tabs prove not enough.
- **Worktrees** for now ([below](#grouped-by-repo)).

Two non-goals were dropped. In-app updates were added on 2026-10-25, after the app had learned to replace an outdated daemon by itself. An in-app editor was added on 2026-10-27: the plan had been a read-only diff and an "open in external editor" button, but the editor in use was Orca's own, so leaving Orca needed one; the larger download was accepted.

## Two processes: daemon and app

`vaquitad` owns the PTYs and runs under launchd; the app is a client that can come and go. The daemon never draws a screen. It does four things: keeps and relays the output bytes, reads the agents' status reports, tracks terminal modes, and decides on notifications and unread state. Unread state, notification decisions and the last notification time live in the daemon's session records, so a restarted app has nothing to lose.

```
vaquitad (Go, LaunchAgent)
  per session: PTY -> scanner -> ring (1 MB, monotonic offsets)
                       |- OSC 7501 / OSC 9 -> status, notify
                       |- mode tracking at the ring's start -> replay prefix
  state.json, WebSocket on 127.0.0.1 + token -> endpoint.json (0600)
        ^ one WebSocket: JSON control, binary data, acks
vaquita.app (Tauri)
  sidebar; one xterm.js Terminal per session, only the shown one opened
```

## A Go daemon with no VT emulator

The daemon's work is I/O plumbing (read the PTY, buffer, relay over a WebSocket) and a thin layer of terminal state (mode tracking, status reports). Both need an escape-sequence scanner, not an emulator. Go suits that, and `creack/pty` is mature.

Rust would win if the daemon had to produce a full screen snapshot (cells, colours, scroll regions, resize history), which needs an emulator: `alacritty_terminal` or `libghostty-vt` on the Rust side, and less proven options in Go (`charmbracelet/x/vt`, or `libghostty-vt` through cgo). The decision is revisited if broken replays (colours, scroll regions, widths) become a nuisance in daily use; the choice would then be Go with `libghostty-vt`, or Rust.

## Restoring a screen

A replay is a mode prefix, the ring's bytes, and a resize nudge.

- Both agents draw on the alternate screen with mouse tracking on, so replaying old output alone does not rebuild their screen. After a replay the app resizes to one column less and back, 0.4 s apart (sent together, the app can merge the two SIGWINCHs and see no change). Claude Code then clears and redraws everything; Codex redrew 28 to 38 of 40 rows in the recordings.
- That is why the ring is only 1 MB per session: an alternate-screen app keeps its own scrollback.
- The prefix sets the modes in force where the ring starts (DECSET modes such as alternate screen, mouse, bracketed paste, synchronized output, and the kitty keyboard stack), not the current ones; the bytes in the ring replay every later change.
- Known limits: colours, scroll regions and the saved cursor from before the ring's start, and the resize history, are not restored. The first frame can be off until the agent redraws.

## Who answers terminal queries

Agents probe the terminal as they start (Codex within 36 ms, Claude Code within 0.3 s, both ending with DA1) and adapt to the answers. Answering twice, or answering a query replayed from the past, puts garbage such as `^[[?1;2c` into an agent's input. So each byte has at most one responder, fixed under the session lock when the byte is appended ([daemon rules](daemon.md#rules-the-daemon-keeps)):

- bytes that arrive with a client attached are answered by the one writable client, normally the app's xterm.js;
- bytes that arrive with no client, and every replay, are answered by nobody.

The client that sends `create` is subscribed before the process starts, so an agent's startup probe always reaches the app.

The daemon itself does not answer the stateless queries (OSC 7501 `?`, DA1, DA2, colour queries) for bytes that arrive with no client attached. Time without an app is short and rare (the stable app restarts only to update), and sessions are started from the app, so this was deferred. It would be the first thing to add if the app came to be closed for long stretches.

In the app, every session keeps an xterm.js `Terminal`, but only the shown one is opened and gets a WebGL renderer, as WebGL contexts are limited. An unopened xterm.js 6.0 answers DA1, DA2, CPR, DSR and DECRQM but not colour queries, so the app answers OSC 4/10/11/12 and the OSC 7501 probe itself, through `term.input` so they share the one output path and the replay suppression.

## One WebSocket

The app and the daemon talk over one loopback WebSocket: JSON text frames for control, binary frames (`type u8, sid u32, generation u32`, at most 64 KB of payload) for output and input.

- **Flow control.** The daemon never stops reading a PTY, so an agent is never blocked. A client acknowledges what xterm.js has written; with more than 1 MB unacknowledged the daemon stops sending to it, since a WebView queue would otherwise grow without bound (xterm.js throws past 50 MB, and Orca was seen at 1.38 GB without back-pressure). A client that falls off the ring gets a new generation and a replay.
- **Security.** Loopback only, a token from a 0600 endpoint file, and only the app's origin allowed; a dev daemon also allows the dev server's origin, by flag.
- **Versions.** The stable daemon is replaced only when no session runs, so a new app often meets an old daemon. `hello` carries a protocol version, and the daemon reports its build so the app can tell whether a restart is needed at all ([Release build](app.md#release-build)).
- **Read-only attach.** `hello` names the client kind, so `vaquitad attach` turns read-only while the app is attached and there are never two responders.

## Agent state without hooks

Claude Code and Codex report their state with [OSC 7501](https://mitchellh.com/writing/program-status-osc7501) program-status sequences. vaquita reads those and installs nothing: no hooks, no edits to global settings, no local HTTP server. Hooks would be reconsidered only if prompt contents were needed.

What the recordings showed (Claude Code 2.1.304 to 2.1.309, Codex 0.163):

- **Claude Code** reports only if its OSC 7501 probe is answered; unanswered, it sends nothing and puts glyphs in the window title instead. It sends `idle`, `working`, `done` at the end of a turn, `idle` after Esc, `clear` on exit, and `blocked` with `kind=permission` or `kind=question` and the request in `msg` just before a permission or question dialog appears. Newer versions send `done` twice, the second about 2.5 s later with a summary, so the daemon waits up to 3 s for it before notifying.
- Claude Code's own notification channel (OSC 777) is not used: it arrives 6 s after `blocked` and says the same thing for a permission and a question.
- **Codex** reports without a probe but only `idle`, `working`, `blocked` and `clear`. It goes `working` then `idle` by itself right after starting, and Esc ends in `idle` too, so OSC 7501 cannot tell a finished turn from a cancelled one.
- So a Codex the daemon starts gets per-session `-c` options that turn on its own notifications as OSC 9 ([Codex notifications](daemon.md#codex-notifications)). An OSC 9 followed by `idle` is a finished turn, its text the last reply; followed by `blocked`, it is the request. Cancelling, rejecting and starting send no OSC 9. One exception was found: "Implement this plan?" comes as `Plan mode prompt: …` followed by `idle`, so that prefix is treated as waiting for input.
- A Codex typed into a shell runs without those options, so its finished turns are not shown. Setting them in Codex's global config would fix that, but OSC 9 shows as a real notification in other terminals too.
- The PTY's child is a wrapper shell, so an agent that dies is noticed through the terminal's foreground process group: when the group that reported goes away, its `working` or `blocked` is cleared.
- A `done` notification waits for 1.5 s of quiet, as a turn often flickers back to `working`. Notifications missed while the app was away are summed up once when it reconnects.

The projection table is re-checked with `tools/probe` ([probe.md](probe.md)) when either agent changes how it reports.

## Titles and ids

- **Titles.** Claude Code sets the terminal title (OSC 0/2) to the conversation's topic, and Codex can be told to set it to its thread name (`tui.terminal_title=["thread-name"]`, per session), so both arrive the same way. Codex's default title, its folder name, is ignored; it rewrote the title 134 times in 35 s in one recording. Orca reads transcripts on a timer for titles; vaquita reads nothing.
- **Session id.** The daemon's `sid` is a small sequential number per terminal, used in frame headers and typed on the command line; a random incarnation value per session tells a reused number apart. It is not a UUID, which would change the frame format and the protocol, restart the stable daemon (ending its sessions) and be awkward to type. The sidebar does not show it.
- **Conversation id.** The agent's own session id is not used as the `sid`: the terminal exists before the agent does (Codex has no id until its first message), `/clear` changes it, and several agents can pass through one terminal.

## Reopening after a restart

Reopen resumes the session's own conversation by id (`claude --resume <id>`, `codex resume <id>`), falling back to `--continue` and `resume --last` when no id was noted ([daemon.md](daemon.md#reopening-sessions-after-a-restart)).

At first no id was to be kept, since Claude Code's changes on `/clear`. That changed on 2026-10-23, after seeing Orca keep an id per terminal: with ids, two agents of the same kind in one folder each come back to their own conversation. Without hooks the ids come from the agents' files. Claude Code keeps one per process under `~/.claude/sessions`, written at start and replaced on `/clear`, but it is not a documented format. Codex has no such file and does not keep its conversation file open, so the daemon guesses by folder and start time, accepting that it can now and then pick another conversation.

Reopening is a button, never automatic, and a session that left processes behind must be cleaned up first.

## Killing a session

A kill reaches every process in the PTY's session, not just the shell's process group.

- zsh runs the `-c` command (the agent) in a process group of its own. A child that ignores SIGHUP survived a SIGKILL to the shell's group and the closing of the master, and was reparented to launchd.
- macOS has neither `KERN_PROC_SESSION` nor `pgrep -s`, so the daemon walks all processes and keeps those whose `getsid()` is the session's. Looking processes up by tty does not work: when the leader exits, macOS revokes the terminal, while `getsid()` still answers with the original session.
- The order is SIGHUP to each group, 3 s, a fresh scan, SIGKILL. Survivors are recorded as orphans and never signalled again, as their pid may be reused. The `caffeinate` Claude Code leaves running for up to five minutes is not counted as an orphan.
- Since macOS revokes the slave when the leader exits, the master sees EOF within milliseconds even if a descendant holds the tty; the 2 s drain limit is only a safety net.

## Starting a shell

- The shell is an absolute path from `state.json` (default `/bin/zsh`), run as `shell -l -i -c "<cmd>; exec shell -l -i"`. `-i` is what reads `.zshrc`, where PATH is usually set. Agents run in raw mode, so Ctrl-C reaches them as a byte and they fall back to the shell.
- The environment is an allowlist: `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `PATH` and `SSH_AUTH_SOCK` (launchd provides the system ssh-agent socket, and without it `git push` over ssh fails), plus `TERM`, `COLORTERM`, `TERM_PROGRAM`, the session id and `LANG`, which launchd lacks and without which Korean breaks. A denylist would not do: a daemon started from inside another tool inherits its variables, such as Orca's hook endpoints, a changed `CODEX_HOME`, or `CLAUDECODE`, which makes Claude Code refuse to start nested.
- Running tmux inside a session is not supported; OSC 7501 is unlikely to get through it.

## launchd and macOS privacy

- **LaunchAgent.** The daemon runs under launchd, never as a child of the app (a Tauri sidecar dies with the app). The plist sets `ProcessType=Interactive`, without which launchd throttles CPU and I/O; a `go test` run took about as long in a session as in a normal shell. It sits in `$VAQUITA_HOME`, not `~/Library/LaunchAgents`, so nothing starts at login; the app loads it when it finds no daemon, as Orca does.
- **Instances.** `VAQUITA_HOME` separates data, lock, endpoint and launchd label, so a dev daemon can be rebuilt and restarted without ending the sessions of the stable one.
- **Stable signature.** macOS asks for folder access (Downloads, Documents, Desktop) on behalf of the process that spawned the shell. The Go linker signs ad hoc with a hash that changes every build, so every rebuild lost the permission; a fixed self-signed code-signing identity keeps it. There is no Developer ID, so releases are not notarized.
- **One entry in Privacy & Security.** The daemon ships as a helper app inside the bundle, with the app's bundle id and signed with its identifier, so macOS lists one "vaquita" rather than a second "vaquitad" ([Release build](app.md#release-build)). Orca wraps its daemon in a helper app too.

## The app: Tauri on WKWebView

- **Tauri v2** uses the system WebKit, so no Chromium is bundled; the Rust side stays small. The front end is Svelte 5 with xterm.js; weight is decided by the number of xterm instances more than by the framework.
- **`backgroundThrottling: "disabled"` is required.** With the default, a minimized window stopped answering terminal queries within seconds, and the stalled answers went out about six minutes late when it was restored, landing as input. Disabled, a window minimized for six minutes answered every query, with a median of about 8 ms.
- **Korean input needs a fix.** The macOS Korean input method does not send composition events in WebKit; it replaces the previous character (`insertReplacementText`), which Apple describes as intended ([WebKit bug 274700](https://bugs.webkit.org/show_bug.cgi?id=274700)). xterm.js 6.0 drops those, so a typed word arrives as loose first letters with only its last syllable whole, in Safari too. The app intercepts them, shows the syllable being composed as an overlay, and sends it when the next one starts or on any key, blur or click. It goes once xterm.js handles this itself ([xterm.js PR 5704](https://github.com/xtermjs/xterm.js/pull/5704)).
- **Fallback.** If the WebKit route broke, the same front end would move to a single Electron window, where Chromium sends composition events; the daemon and the protocol would stay.
- **Notifications** use `UNUserNotificationCenter` directly from Rust. The notification plugin's older macOS path showed the notification and then dropped the click, and its newer backend missed clicks while the main thread was busy.
- **Daily use.** The agents turn on mouse tracking, so Option-drag forces a selection; Shift+Enter sends `ESC CR`; links go through the opener plugin, as `window.open` does nothing in WKWebView; a dropped file's path is typed into the PTY.

## Grouped by repo

A session belongs to the registered repo whose path is the longest prefix of its folder, compared by path component (so `example-feature` does not land under `example`); the rest go under "other". The sidebar runs no git, watches nothing and polls nothing.

Worktrees were dropped from the plan on 2026-10-23 because they were rarely used: no worktree level in the sidebar, no discovery, no git status, no PR state. The design kept for later:

- run `git worktree list --porcelain` at start, on a watch event, on window focus, on selection and when a session finishes, never on a timer;
- watch the common git dir and its `worktrees/`, one directory at a time (fsnotify is not recursive), and rescan once after registering;
- do not watch `HEAD`: kqueue watches an inode, and git replaces `HEAD` by renaming `HEAD.lock`, so the watch dies after the first checkout;
- dirty and ahead state only for the selected worktree; PR state with one `gh pr list` per repo every five minutes.

## Releases and updates

- A `v*` tag builds, signs and publishes in CI ([Release build](app.md#release-build)).
- The daemon's build carries a fingerprint of its committed code, so a release that leaves the daemon alone restarts no daemon, and the sessions keep running.
- Updates use `tauri-plugin-updater`, called only from two Rust commands: the webview gets no updater permission and never names a URL. Only the release configuration has a feed, so dev and local builds never check, and the signature must name the feed's version.
- After installing, the app quits and is opened again with `open` once it is gone. `open -n`, which starts it while the old one still runs, left a second tile in the Dock.

## Opening paths from the terminal

- Terminal output is untrusted: whatever could run something is only revealed in Finder ([app rules](app.md#rules-the-app-keeps)).
- The daemon sets `FORCE_HYPERLINK=1`, so Claude Code emits file links whose target has the full path even when the visible text is shortened.
- A path in plain text is bounded by colour, since agents colour the paths they print. Language-specific trimming (such as Korean particles stuck to a path in the default colour) was tried and dropped as too fiddly.
- Paths are not checked against the disk before they are underlined (Orca checks each candidate on hover, with a cache); a path that does not exist is reported when it is clicked.
- A path an agent wraps onto the next line itself is joined back by one rule ([app.md](app.md#what-it-does-so-far)).

## The files panel

- **Tabs, not splits.** The terminal is always the first tab. Tabs are kept per repo, as the sidebar groups sessions, and restored after a relaunch.
- **Monaco**, the editor Orca uses, for light edits rather than full coding. It is loaded the first time a text file or a diff opens: it adds about 1.3 MB to the download and about 100 MB of memory once loaded, and an app run that opens no text file never pays for it. A save checks that an agent did not change the file in the meantime.
- **All file access is in app Rust commands, on demand.** The daemon is not involved.
- **PDFs open in their default app.** In WebKit a sandboxed frame showed PDFs blank, and an unsandboxed one needed a scheme of its own that checked every request. After trying it, that was removed on 2026-10-29 in favour of Preview or whatever app owns PDFs. Images, audio and video do open in a tab.
- **The tree reads a folder when it is expanded and watches only expanded folders** with FSEvents. A change to a file's contents alone does nothing, a hidden panel reads and watches nothing, and nothing polls (Orca polls git every 2 to 3 s). A folder lists at most 2000 entries, and a symlink is a row, not a branch.
- **The Markdown preview is sanitized** and shows no images; that limit was accepted to keep untrusted content inert.
- **Changes are against HEAD only**: staged, unstaged and untracked together, with no branch base, so work a branch already committed does not show.
- **Git runs no command a repository configures.** The tree asks git only what it ignores; the Changes list and the diff ask for the status, the line counts and HEAD's copy of a file. Every call has `core.fsmonitor` off; the list and the diff also turn off external diff, textconv and lazy fetches (`--no-lazy-fetch`, hence git 2.46 or later), and HEAD's side is read as the raw blob. Two things a plain `git status` runs were turned off rather than allowed, and what that costs was accepted on 2026-10-29. Filter drivers the repository's own config defines are emptied, while a user's global ones, such as Git LFS's, keep running, as the user set them up; so a touched file whose filter only the repo's config sets, as git-crypt's is, can show as changed with its content the same. And git does not enter submodule working trees (`--ignore-submodules=dirty`), where it would follow each submodule's own config; so edits inside a submodule are not listed, only its commit moving.
- **One recursive watch of the repo, only while the Changes view shows**, beside the tree's per-folder ones. Inside `.git` only the index, HEAD and branches count, so a fetch refreshes nothing, and ignored paths are dropped with one `check-ignore` per 300 ms batch, so a build writing into `dist` costs a git run per batch and no refresh. Optional locks and diff's index refresh are off: a status or a diff would otherwise rewrite a stat-dirty index, which the watch would see as a change and answer with another status, forever. Beyond that, the list is read on a turn's end, a save or a click, never on a timer.
- **A diff tab is a tab key, not a path** (`diff:` and the file's path; paths start with `/`, so none collides), so preview tabs, pinning, order, grouping by repo and restoring needed no change. It has no document, so it is never dirty and closing it asks nothing.
- **Read-only: no staging, committing or discarding.** The agents and the terminal do that.
- **Next, if anything:** staging or a branch base, when tabs and the list prove not enough.

## Phase 0 findings

Before any code, the risky parts were measured with the tools in `tools/probe` ([probe.md](probe.md)): the agents run in a 120 × 40 PTY that answers queries as vaquita would.

| | Claude Code 2.1.304 | Codex 0.163 |
|---|---|---|
| First query | 0.3 s | 0.036 s |
| Startup queries | OSC 11, DA1, XTVERSION, kitty keyboard, OSC 7501 probe, DA1 | CPR, OSC 10, OSC 11, kitty keyboard, DA1 |
| OSC 7501 | only after its probe is answered | without a probe |
| End of turn | `working` → `done` | `working` → `idle` |
| Waiting for input | `blocked` with kind and message | `blocked`, no kind |
| Right after start | `idle` | `idle` → `working` → `idle` by itself |
| Screen | alternate screen, mouse 1000/1002/1003/1006, bracketed paste, focus events | the same, plus synchronized output on every frame and a kitty keyboard push |
| Resize nudge | clears and redraws all | redraws most rows |

Other findings:

- xterm.js 6.0 answers neither XTVERSION, the kitty keyboard query nor `CSI ?996n`, and vaquita leaves them unanswered too. Answers sent from an OSC handler with `term.input` go out before the DA1 answer of the same write. The unicode11 widths need both `allowProposedApi` and `activeVersion = '11'`.
- An early recording showed Claude Code sending no `blocked`. That was a bug in the recorder, which dropped every report that had a `kind`. Fixed, Claude Code sent `blocked` every time, which made its own notification channel unnecessary.
- The daemon stayed under 30 MB resident through `yes`, newline-less floods and unterminated OSC strings.
