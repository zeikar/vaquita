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
- `vaquitad install` writes a LaunchAgent plist into `$VAQUITA_HOME` and prints the `launchctl` commands that load and unload it. Nothing goes into `~/Library/LaunchAgents`, so nothing starts at login. `--bootstrap` also loads it into launchd; `--print` only prints the plist.

## Codex notifications

A session whose command starts with `codex`, from the app or from `attach --new -- codex`, runs it with `-c` options that turn on Codex's OSC 9 notifications for that session only: the daemon tells a finished Codex turn from a cancelled one by them. Codex typed into a plain shell session runs without them, so its finished turns are not shown.

## Reopening sessions after a restart

Sessions survive a daemon restart as records. While a Claude Code or Codex runs in a session, the daemon notes its conversation id (the agent's own session id, which `--resume` takes) and keeps it in `state.json`: for Claude Code it reads the file Claude Code keeps per process under `~/.claude/sessions`, for Codex it takes the newest conversation file under `~/.codex/sessions` for that session's folder, so it can occasionally pick another conversation. It also keeps the topic Claude Code sets as the terminal title, which the app shows as the session's title.

After the daemon restarts (a crash or a reboot), the app lists every earlier session with Reopen and Dismiss. Reopen starts `claude --resume <id>` or `codex resume <id>` in the session's folder; when no id was noted it falls back to `claude --continue` or `codex resume --last`, and a session that was not running an agent gets a plain shell. A session that left processes behind has to be cleaned up first (Kill shows their pids).

The ids are only read from `$HOME/.claude` and `$HOME/.codex`, so with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` set the fallback is used. No hooks are installed and nothing is written into the agents' directories.

The conversation id is not the daemon's session id: that one is a small number per terminal (`vaquitad ls` shows it), while a conversation id belongs to the agent and changes inside one terminal on `/clear` or a new agent. A reopened session gets a new session id and keeps the old conversation id.
