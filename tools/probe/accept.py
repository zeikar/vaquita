#!/usr/bin/env python3
"""Phase 1 acceptance checks through `vaquitad attach`. A PTY stands in for the
user's terminal: it answers DA1/CPR/colour queries and wraps pastes in
bracketed-paste markers while the app has mode 2004 on, as a terminal does.

usage: accept.py <claude|paste|launchd> <outdir>

Uses the dev instance: $VAQUITA_HOME (default ~/.vaquita-dev) and its binary
$VAQUITA_HOME/bin/vaquitad, with a daemon already running for that home.
For `launchd`, run the daemon as the dev LaunchAgent first:

    vaquitad install && launchctl bootstrap gui/$(id -u) $VAQUITA_HOME/<label>.plist
    ... accept.py launchd <outdir> ...
    launchctl bootout gui/$(id -u)/<label>

`launchd` runs `ls ~/Downloads` in the session; macOS may show a permission
prompt for it, which has to be answered by hand.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # python -I leaves the script's directory off sys.path
import probe as P  # noqa: E402

DAEMON_SRC = os.path.normpath(os.path.join(HERE, '..', '..', 'daemon'))
HOME_DEV = os.path.abspath(os.path.expanduser(os.environ.get('VAQUITA_HOME', '~/.vaquita-dev')))
VQ = os.path.join(HOME_DEV, 'bin', 'vaquitad')
DETACH = b'\x1c'
REPLY = r'⏺[^A-Za-z]{0,40}'  # Claude marks its replies with ⏺; a spinner glyph may sit in between


def env():
    e = P.child_env()
    e['VAQUITA_HOME'] = HOME_DEV
    return e


def attach(name, args, outdir):
    p = P.Probe(name, [VQ, 'attach', *args], os.getcwd(), env(), outdir)
    p.start()
    return p


def newest_session(name):
    out = subprocess.run([VQ, 'ls'], env=env(), capture_output=True, text=True, check=True).stdout
    rows = [l.split() for l in out.splitlines()[1:] if name in l.split()]
    return max(rows, key=lambda r: int(r[0]))[0]


def bracketed_on(p):
    on = False
    for e in p.events:
        if e['k'] == 'mode' and e['v'] in ('+?2004', '-?2004'):
            on = e['v'] == '+?2004'
    return on


def paste(p, text):
    wrapped = bracketed_on(p)
    p.ev('paste', wrapped=wrapped)
    body = text.encode()
    p.write(b'\x1b[200~' + body + b'\x1b[201~' if wrapped else body)
    return wrapped


def detach(p):
    p.key(DETACH, 'Ctrl-\\')
    return p.finish(10)


def save(p, outdir):
    with open(os.path.join(outdir, p.name + '.events.json'), 'w') as f:
        json.dump(p.events, f, ensure_ascii=False, indent=1)


def check_claude(outdir):
    res = {}
    cwd = tempfile.mkdtemp(prefix='vq-accept-claude-')
    a1 = attach('claude-1', ['--new', '--cwd', cwd, '--name', 'accept-claude', '--',
                             'claude', '--model', 'haiku', '--permission-mode', 'default',
                             '--settings', '{"disableAllHooks":true}'], outdir)
    if a1.wait_text(r'(?i)trust this folder', 40):
        time.sleep(1)
        a1.key(b'\x1b[B', 'Down')
        time.sleep(0.5)
        a1.key(b'\r', 'Enter(trust)')
    a1.wait_text(r'(?i)for shortcuts|\? for', 40)
    time.sleep(2)
    a1.type('Reply with exactly one word: pong')
    res['turn1_done'] = a1.wait_states([('working',), ('done', 'idle', 'error')], 90)
    res['turn1_reply'] = a1.wait_text(REPLY + 'pong', 5)
    time.sleep(1)
    res['detach1_exit'] = detach(a1)
    save(a1, outdir)

    sid = newest_session('accept-claude')
    res['sid'] = sid
    a2 = attach('claude-2', [sid], outdir)
    # The replay plus the resize nudge make Claude redraw the conversation.
    res['reattach_shows_turn1'] = a2.wait_text(REPLY + 'pong', 20)
    time.sleep(2)
    a2.type('Reply with exactly one word: second')
    res['turn2_done'] = a2.wait_states([('working',), ('done', 'idle', 'error')], 90)
    res['turn2_reply'] = a2.wait_text(REPLY + 'second', 5)
    time.sleep(1)
    res['detach2_exit'] = detach(a2)
    save(a2, outdir)

    # /exit typed straight after re-attaching, without clearing the input box:
    # had a reply to a replayed query reached Claude's input, "/exit" would not
    # be a command and Claude would keep running.
    a3 = attach('claude-3', [sid], outdir)
    a3.wait_text(REPLY + 'second', 20)
    time.sleep(2)
    a3.type('/exit')
    res['exit_without_clearing_input'] = a3.wait_states([('clear',)], 15)
    time.sleep(2)
    a3.type('exit')  # the login shell the session falls back to
    res['session_exited'] = a3.wait_text(r'session exited', 15)
    res['attach3_exit'] = a3.finish(10)
    save(a3, outdir)
    return res


def check_paste(outdir):
    res = {}
    work = tempfile.mkdtemp(prefix='vq-accept-paste-')
    out = os.path.join(work, 'paste.txt')
    a1 = attach('paste-1', ['--new', '--cwd', work, '--name', 'accept-paste'], outdir)
    time.sleep(2)
    a1.type('echo RE""ADY')
    res['shell_ready'] = a1.wait_text(r'READY', 30)
    time.sleep(1)
    a1.type(f"printf '\\033[?2004h'; yes | head -c 2000000; printf 'BIG''DONE\\n'; cat -v > {out}")
    res['big_output_done'] = a1.wait_text(r'BIGDONE', 60)
    time.sleep(1)
    res['detach_exit'] = detach(a1)
    save(a1, outdir)

    a2 = attach('paste-2', [newest_session('accept-paste')], outdir)
    time.sleep(3)  # replay (~1MB), fence, nudge
    res['bracketed_after_reattach'] = paste(a2, 'line one\rline two\rline three\r')
    time.sleep(0.5)
    a2.key(b'\r', 'Enter')  # the end marker is still on the current line
    time.sleep(0.3)
    a2.key(b'\x04', 'Ctrl-D')
    time.sleep(1)
    with open(out, encoding='utf-8', errors='replace') as f:
        res['file'] = f.read()
    res['file_has_markers'] = '^[[200~' in res['file'] and '^[[201~' in res['file']
    a2.type('exit')
    res['session_exited'] = a2.wait_text(r'session exited', 15)
    res['attach_exit'] = a2.finish(10)
    save(a2, outdir)
    return res


def under_launchd():
    with open(os.path.join(HOME_DEV, 'endpoint.json')) as f:
        pid = str(json.load(f)['pid'])
    listed = subprocess.run(['launchctl', 'list'], capture_output=True, text=True).stdout
    return any(line.split('\t')[0] == pid for line in listed.splitlines())


def go_test_times(cwd):
    out = []
    for _ in range(2):
        t = time.monotonic()
        subprocess.run(['go', 'test', '-count=1', './...'], cwd=cwd, capture_output=True, check=True)
        out.append(round(time.monotonic() - t, 2))
    return out


def check_launchd(outdir):
    res = {'daemon_under_launchd': under_launchd()}
    work = tempfile.mkdtemp(prefix='vq-accept-launchd-')
    a = attach('launchd', ['--new', '--cwd', DAEMON_SRC, '--name', 'accept-launchd'], outdir)
    time.sleep(2)
    a.type('echo RE""ADY')
    res['shell_ready'] = a.wait_text(r'READY', 30)
    downloads = os.path.expanduser('~/Downloads')
    steps = [
        ('env', f'{{ echo SSH_AUTH_SOCK=${{SSH_AUTH_SOCK:-unset}}; echo LANG=$LANG; echo TERM_PROGRAM=$TERM_PROGRAM; }} > {work}/env.txt 2>&1', 30),
        # Only exit codes and counts: key comments and folder contents stay out of the results.
        # ssh-add -l: rc 0 = keys listed, 1 = agent reachable but empty, 2 = no agent.
        ('ssh', f'ssh-add -l >/dev/null 2>&1; r=$?; n=0; [ $r -eq 0 ] && n=$(ssh-add -l | wc -l | tr -d " "); echo "rc=$r keys=$n" > {work}/ssh.txt', 30),
        ('tcc', f"perl -e 'alarm 90; exec @ARGV' ls {downloads} >/dev/null 2>{work}/tcc.txt; echo rc=$? >> {work}/tcc.txt", 120),
        ('gotest', f"for i in 1 2; do /usr/bin/time -p go test -count=1 ./... 2>&1 | grep -E '^(real|FAIL)'; done > {work}/gotest.txt 2>&1", 600),
    ]
    for label, cmd, timeout in steps:
        if label == 'tcc':
            print('[accept] running ls ~/Downloads in the session; answer the permission prompt if one appears', flush=True)
        a.type(cmd + '; echo ST""EP-' + label)
        res[label + '_done'] = a.wait_text(r'STEP-' + label, timeout)
        with open(os.path.join(work, label + '.txt'), encoding='utf-8', errors='replace') as f:
            res[label] = f.read()
    res['shell_ssh_auth_sock'] = os.environ.get('SSH_AUTH_SOCK', 'unset')
    res['gotest_here_seconds'] = go_test_times(DAEMON_SRC)
    a.type('exit')
    res['session_exited'] = a.wait_text(r'session exited', 15)
    res['attach_exit'] = a.finish(10)
    save(a, outdir)
    return res


if __name__ == '__main__':
    which, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    res = {'claude': check_claude, 'paste': check_paste, 'launchd': check_launchd}[which](outdir)
    with open(os.path.join(outdir, which + '.result.json'), 'w') as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(json.dumps(res, ensure_ascii=False, indent=1))
