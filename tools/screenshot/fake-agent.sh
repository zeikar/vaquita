#!/bin/sh
# fake-agent.sh <state> [message]: reports a state the way Claude Code or
# Codex does (OSC 7501, and Codex's OSC 9 notification before it), then idles
# in the foreground so the state holds. States: claude-working,
# claude-permission, claude-question, claude-done, codex-approval, codex-done.
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
case $1 in
codex-*) app=codex ;;
*) app=claude-code ;;
esac
printf 'demo agent: %s\r\n' "$1"
printf '\033]7501;state=working:app=%s\033\\' "$app"
sleep 0.5
case $1 in
claude-permission) printf '\033]7501;state=blocked:kind=permission:msg=%s:app=claude-code\033\\' "$(b64 "$2")" ;;
claude-question) printf '\033]7501;state=blocked:kind=question:msg=%s:app=claude-code\033\\' "$(b64 "$2")" ;;
claude-done)
	# Claude's first done has no message; the summary comes in a second one.
	printf '\033]7501;state=done:app=claude-code\033\\'
	sleep 0.5
	printf '\033]7501;state=done:msg=%s:app=claude-code\033\\' "$(b64 "$2")" ;;
codex-approval) printf '\033]9;%s\007\033]7501;state=blocked:app=codex\033\\' "$2" ;;
codex-done) printf '\033]9;%s\007\033]7501;state=idle:app=codex\033\\' "$2" ;;
esac
exec sleep 86400
