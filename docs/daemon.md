# Daemon

`vaquitad` holds the sessions: each is a shell in its own PTY, so shells and agents keep running when the app restarts.

## Build and run

Build it and run a dev instance, which keeps its own home so a stable instance is untouched:

```sh
export VAQUITA_HOME=~/.vaquita-dev PATH=~/.vaquita-dev/bin:$PATH
make -C daemon            # builds $VAQUITA_HOME/bin/vaquitad
vaquitad serve
```

A daemon run by launchd should be signed with a stable identity, or macOS asks again for access to folders such as `~/Downloads` after every rebuild. A self-signed certificate is enough (Keychain Access → Certificate Assistant → Create a Certificate, type Code Signing): `make -C daemon SIGN="<certificate name>"`.

## Commands

From another terminal, after the same `export`:

- `vaquitad ls` lists sessions.
- `vaquitad attach --new` starts a shell session and attaches to it; `attach --new -- <cmd>` runs a command such as an agent instead. `Ctrl-\` detaches and leaves the session running.
- `vaquitad repos add <dir>`, `repos rm <dir>` and `repos ls` manage the repos the app groups sessions by. The list lives in the daemon's `state.json`, and an open app follows it at once.
- `vaquitad version` (or `--version`) prints its build: for a release its version, a `+` and a fingerprint of the daemon's committed code other than tests (`0.1.6+3b9cdd54fa29`), else `dev`. `make -C daemon VERSION=<version>` sets it; the app compares fingerprints to tell whether a running daemon is the one it ships.
- `vaquitad install` writes a LaunchAgent plist into `$VAQUITA_HOME` and prints the `launchctl` commands that load and unload it. Nothing goes into `~/Library/LaunchAgents`, so nothing starts at login. The plist also names the app (`AssociatedBundleIdentifiers`), which is how macOS ties the launchd job to it. `--bootstrap` also loads it into launchd; `--print` only prints the plist.

## Codex notifications

A session whose command starts with `codex`, from the app or from `attach --new -- codex`, runs it with `-c` options that turn on Codex's OSC 9 notifications for that session only: the daemon tells a finished Codex turn from a cancelled one by them. The options also make the terminal title the thread's name, which the app shows as the session's title. Codex typed into a shell, in a plain shell session or after the session's own Codex has exited, runs without them, so its finished turns are not shown and the session gets no title from it.

## Reopening sessions after a restart

Sessions survive a daemon restart as records. While a Claude Code or Codex runs in a session, the daemon notes its conversation id (the agent's own session id, which `--resume` takes) and keeps it in `state.json`: for Claude Code it reads the file Claude Code keeps per process under `~/.claude/sessions`, for Codex it takes the newest conversation file under `~/.codex/sessions` for that session's folder, so it can occasionally pick another conversation. It also keeps the title the agent sets as the terminal title (Claude Code's topic, Codex's thread name), which the app shows as the session's title.

After the daemon restarts (a crash or a reboot), the app lists every earlier session with Reopen and Dismiss. Reopen starts `claude --resume <id>` or `codex resume <id>` in the session's folder; when no id was noted it falls back to `claude --continue` or `codex resume --last`, and a session that was not running an agent gets a plain shell. A session that left processes behind has to be cleaned up first (Kill shows their pids); the `caffeinate` Claude Code keeps running for up to five minutes to stop the Mac sleeping does not count. Right after a crash those are often agents still shutting down, so the daemon checks such sessions again over the first 15 seconds and makes them reopenable once their processes are gone.

The ids are only read from `$HOME/.claude` and `$HOME/.codex`, so with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` set the fallback is used. No hooks are installed and nothing is written into the agents' directories.

The conversation id is not the daemon's session id: that one is a small number per terminal (`vaquitad ls` shows it), while a conversation id belongs to the agent and changes inside one terminal on `/clear` or a new agent. A reopened session gets a new session id and keeps the old conversation id.

## Rules the daemon keeps

Most of these come from bugs seen in other terminal multiplexers and from reviews; a change to the daemon keeps all of them.

- **At most one answer per byte of output.** Bytes that arrived while a client was attached are answered (terminal queries such as DA1, colour queries, Claude Code's OSC 7501 query) by one writable client only; bytes that arrived with no client, and every replay (also after a generation reset), are answered by nobody. The OSC 7501 answer goes before the DA1 one.
- **A replay starts from the modes in force where the ring starts**, not the current ones.
- **Reading a PTY never stops.** Only sending to a client waits, and a client acknowledges what it got, so a slow client cannot make its queue grow without bound.
- **Buffers are copied, not shared.** Nothing passes a slice of the ring or of a read buffer to a channel or a send, and a small tail kept for long is copied too, so it does not hold the whole array.
- **Every buffer and snapshot has a cap.**
- **Late answers are checked against what they belong to**: a session's incarnation and a subscription's generation, as a reply can arrive after its session or subscription is gone.
- **A close that arrives while a session is still starting is remembered**, and the session is killed once it has started, so no orphan shell is left.
- **The exit event goes out after the PTY is drained.**
- **A kill reaches every process group in the PTY session**, as an agent runs in a group other than its shell's; processes are found by their session id (`getsid`).
- **Under launchd**: `ProcessType=Interactive`, an explicit list of environment variables to keep (`SSH_AUTH_SOCK` among them), `LANG` set, the shell by absolute path. The daemon is never a child the app would take down with it.
- **The daemon removes only the socket, port and lock files it created**, so a daemon on its way out never deletes a newer one's.
- **A daemon is replaced only when no session runs**, or when the user chooses to; the app compares the build fingerprint (`vaquitad version`) to tell whether a restart is needed at all. Development uses its own `VAQUITA_HOME`.
- **No hooks and no writes into the agents' settings.** State comes from what Claude Code and Codex write to the terminal; per-session `-c` options for Codex are the only thing added, and only to a Codex the daemon starts.
