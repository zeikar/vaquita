#!/usr/bin/env python3
"""Run an agent CLI in a PTY, answer terminal queries the way vaquita plans to,
and record queries, mode changes, titles, OSC 7501 reports and OSC 9/777 notifications.

usage: probe.py claude|claude-noanswer|claude-perm|claude-perm-ghostty|claude-perm-ghostty-blur|codex|codex-notify <outdir>
"""
import base64
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

REPLY_7501 = b'\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'
DA1_REPLY = b'\x1b[?1;2c'
DA2_REPLY = b'\x1b[>0;276;0c'
COLORS = {b'10': b'rgb:e6e6/e6e6/e6e6', b'11': b'rgb:1e1e/1e1e/1e1e', b'12': b'rgb:e6e6/e6e6/e6e6'}

OSC_RE = re.compile(rb'\x1b\]([^\x07\x1b]*)(\x07|\x1b\\)')
CSI_RE = re.compile(rb'\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])')
STR_RE = re.compile(rb'\x1b([P_^X])(.*?)\x1b\\', re.S)
CSI_TAIL_RE = re.compile(rb'[\x20-\x3f]*')


class Span:
    def __init__(self, start, end):
        self._end = end

    def end(self):
        return self._end


class Probe:
    def __init__(self, name, argv, cwd, env, outdir, answer_7501=True, cols=120, rows=40):
        self.name, self.argv, self.cwd, self.env = name, argv, cwd, env
        self.answer_7501 = answer_7501
        self.cols, self.rows = cols, rows
        self.t0 = time.monotonic()
        self.events = []
        self.text = ''
        self.mark = 0
        self.states = []  # root 7501 states in order
        self.carry = b''
        self.lock = threading.Lock()
        self.raw = open(os.path.join(outdir, f'{name}.raw'), 'wb')
        self.rawbuf = bytearray()
        self.last_title = None
        self.eof = False

    def now(self):
        return round(time.monotonic() - self.t0, 3)

    def ev(self, kind, **kw):
        self.events.append({'t': self.now(), 'k': kind, **kw})

    def start(self):
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', self.rows, self.cols, 0, 0))
            os.chdir(self.cwd)
            os.execve(self.argv[0], self.argv, self.env)
        self.pid, self.fd = pid, fd
        self.ev('spawn', argv=self.argv[1:])
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            try:
                r, _, _ = select.select([self.fd], [], [], 0.2)
                if not r:
                    continue
                data = os.read(self.fd, 65536)
            except OSError:
                break
            if not data:
                break
            self.raw.write(data)
            with self.lock:
                self.rawbuf += data
                self._feed(data)
        self.eof = True
        self.ev('eof')

    def write(self, b):
        try:
            os.write(self.fd, b)
        except OSError as exc:
            self.ev('write_error', v=repr(exc)[:80])

    # --- scanner -------------------------------------------------------
    def _feed(self, data):
        buf = self.carry + data
        self.carry = b''
        i, n = 0, len(buf)
        texts = []
        while i < n:
            j = buf.find(b'\x1b', i)
            if j < 0:
                texts.append(buf[i:])
                break
            texts.append(buf[i:j])
            res = self._match(buf, j)
            if res == 'incomplete':
                if n - j <= 65536:
                    self.carry = buf[j:]
                    break
                i = j + 1
                continue
            if res is None:
                i = j + 2
                continue
            kind, m = res
            try:
                self._handle(kind, m, buf)
            except Exception as exc:
                self.ev('scan_error', v=repr(exc)[:120])
            i = m.end()
        self.text += b''.join(texts).decode('utf-8', 'replace')
        if len(self.text) > 400000:
            cut = len(self.text) - 200000
            self.text = self.text[cut:]
            self.mark = max(0, self.mark - cut)

    def _match(self, buf, j):
        if j + 1 >= len(buf):
            return 'incomplete'
        c = buf[j + 1:j + 2]
        if c == b']':
            m = OSC_RE.match(buf, j)
            if m:
                return ('osc', m)
            return 'incomplete' if re.search(rb'[\x07\x1b]', buf[j + 2:]) is None else None
        if c == b'[':
            m = CSI_RE.match(buf, j)
            if m:
                return ('csi', m)
            return 'incomplete' if CSI_TAIL_RE.fullmatch(buf[j + 2:]) else None
        if c in (b'P', b'_', b'^', b'X'):
            m = STR_RE.match(buf, j)
            return ('str', m) if m else 'incomplete'
        if c in (b'(', b')', b'*', b'+', b'#', b'%'):
            if j + 2 >= len(buf):
                return 'incomplete'
            return ('esc', Span(j, j + 3))
        if c == b'c':
            self.ev('RIS')
        return ('esc', Span(j, j + 2))

    def _query(self, name, reply=None):
        self.ev('query', q=name, answered=reply is not None)
        if reply is not None:
            self.write(reply)

    def _handle(self, kind, m, buf):
        if kind == 'osc':
            body, term = m.group(1), m.group(2)
            num, _, rest = body.partition(b';')
            if num == b'7501':
                if rest.strip() == b'?':
                    self._query('OSC7501?', REPLY_7501 if self.answer_7501 else None)
                else:
                    self._report(rest)
            elif num in (b'0', b'2'):
                title = rest.decode('utf-8', 'replace')
                if title != self.last_title:
                    self.last_title = title
                    self.ev('title', v=title[:80])
            elif num in COLORS and rest == b'?':
                self._query(f'OSC{num.decode()}?', b'\x1b]' + num + b';' + COLORS[num] + term)
            elif num == b'4' and rest.endswith(b';?'):
                idx = rest.split(b';')[0]
                self._query('OSC4?', b'\x1b]4;' + idx + b';rgb:8080/8080/8080' + term)
            elif num in (b'9', b'777'):
                self.ev('notify', n=num.decode(), v=rest[:160].decode('utf-8', 'replace'))
            else:
                self.ev('osc', n=num.decode('utf-8', 'replace'), v=rest[:60].decode('utf-8', 'replace'))
        elif kind == 'csi':
            params, inter, final = m.group(1), m.group(2), m.group(3)
            p = params.decode()
            f = final.decode()
            it = inter.decode()
            if f == 'c' and p in ('', '0') and not it:
                self._query('DA1', DA1_REPLY)
            elif f == 'c' and p.startswith('>'):
                self._query('DA2', DA2_REPLY)
            elif f == 'c' and p.startswith('='):
                self._query('DA3')
            elif f == 'n' and p == '6':
                self._query('CPR', b'\x1b[1;1R')
            elif f == 'n' and p == '5':
                self._query('DSR', b'\x1b[0n')
            elif f == 'n' and p == '?996':
                self._query('?996n', b'\x1b[?997;1n')
            elif f == 'n':
                self._query(f'CSI {p} n')
            elif f == 'p' and it == '$':
                self._query(f'DECRQM {p}')
            elif f == 'q' and p.startswith('>'):
                self._query('XTVERSION')
            elif f == 'u' and p == '?':
                self._query('kitty?')
            elif f == 'u' and p[:1] in ('>', '<', '='):
                self.ev('kitty', v=p)
            elif f == 't' and p in ('14', '16', '18', '19', '22;0', '22;1', '22;2', '23;0', '23;1', '23;2'):
                self.ev('winop', v=p) if p.startswith('2') else self._query(f'winop {p}t')
            elif f in ('h', 'l') and not it:
                self.ev('mode', v=('+' if f == 'h' else '-') + p)
        elif kind == 'str':
            typ, body = m.group(1), m.group(2)
            if typ == b'P':
                if body.startswith(b'+q'):
                    self._query('XTGETTCAP ' + bytes.fromhex(body[2:].split(b';')[0].decode() or '00').decode('latin1'))
                elif body.startswith(b'$q'):
                    self._query('DECRQSS ' + body[2:].decode('latin1'))
                else:
                    self.ev('dcs', v=body[:30].decode('latin1'))
            else:
                self.ev('apc', v=body[:30].decode('latin1'))

    def _report(self, rest):
        rec = {}
        for pair in rest.split(b':'):
            k, _, v = pair.partition(b'=')
            key = k.decode()
            if key in ('msg', 'title'):
                try:
                    rec[key] = base64.b64decode(v).decode('utf-8', 'replace')[:120]
                except Exception:
                    rec[key] = '<bad base64>'
            else:
                rec[key] = v.decode('utf-8', 'replace')
        self.ev('7501', **rec)
        if 'id' not in rec:
            self.states.append(rec.get('state'))

    # --- driving -------------------------------------------------------
    def wait(self, pred, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            with self.lock:
                if pred():
                    return True
            if self.eof:
                return False
            time.sleep(0.1)
        return False

    def wait_text(self, pattern, timeout):
        rx = re.compile(pattern.replace(' ', r'\s*'))

        def found():
            m = rx.search(self.text, self.mark)
            if m:
                self.mark = m.end()
                return True
            return False

        ok = self.wait(found, timeout)
        self.ev('wait_text', pattern=pattern, ok=ok)
        return ok

    def wait_states(self, seq, timeout):
        """Wait for states matching seq (each item a tuple of acceptable states) in order, after now."""
        start = len(self.states)

        def done():
            k = 0
            for s in self.states[start:]:
                if s in seq[k]:
                    k += 1
                    if k == len(seq):
                        return True
            return False

        ok = self.wait(done, timeout)
        self.ev('wait_states', seq=[list(x) for x in seq], ok=ok)
        return ok

    def nudge(self):
        """Resize cols-1 then back, and measure how much of the screen the app redraws."""
        with self.lock:
            start = len(self.rawbuf)
        for c in (self.cols - 1, self.cols):
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', self.rows, c, 0, 0))
            time.sleep(0.4)
        time.sleep(1.5)
        with self.lock:
            out = bytes(self.rawbuf[start:])
        rows = set(int(m.group(1)) for m in re.finditer(rb'\x1b\[(\d+);\d+H', out))
        rows |= set(int(m.group(1)) for m in re.finditer(rb'\x1b\[(\d+)H', out))
        self.ev('nudge', bytes=len(out), clear2J=b'\x1b[2J' in out, clear3J=b'\x1b[3J' in out,
                rows_addressed=len(rows), of=self.rows, sync=out.count(b'\x1b[?2026h'))

    def type(self, s):
        self.ev('type', v=s)
        self.write(s.encode())
        time.sleep(0.4)
        self.write(b'\r')

    def key(self, b, label):
        self.ev('key', v=label)
        self.write(b)

    def finish(self, timeout=15):
        end = time.monotonic() + timeout
        code = None
        while time.monotonic() < end:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                code = os.waitstatus_to_exitcode(status)
                break
            time.sleep(0.2)
        if code is None:
            self.ev('kill')
            os.kill(self.pid, signal.SIGTERM)
            time.sleep(1)
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _, status = os.waitpid(self.pid, 0)
            code = os.waitstatus_to_exitcode(status)
        self.ev('exit', code=code)
        time.sleep(0.3)
        self.raw.close()
        return code


def child_env():
    keep = ('HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR',
            'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
            'OPENAI_API_KEY')
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env['PATH'] = ':'.join(p for p in os.environ['PATH'].split(':') if 'orca' not in p.lower())
    env.update(TERM='xterm-256color', COLORTERM='truecolor', TERM_PROGRAM='vaquita',
               LANG='en_US.UTF-8', VAQUITA_SESSION_ID='probe')
    return env


def run_claude(outdir, answer):
    name = 'claude' if answer else 'claude-noanswer'
    cwd = tempfile.mkdtemp(prefix=f'vq-{name}-')
    argv = [shutil.which('claude'), '--model', 'haiku', '--permission-mode', 'default',
            '--settings', '{"disableAllHooks":true}']
    p = Probe(name, argv, cwd, child_env(), outdir, answer_7501=answer)
    p.start()
    if p.wait_text(r'(?i)trust this folder', 25):
        time.sleep(1)
        p.key(b'\x1b[B', 'Down')
        time.sleep(0.5)
        p.key(b'\r', 'Enter(trust)')
    p.wait_text(r'(?i)for shortcuts|\? for', 40)
    time.sleep(3)
    p.ev('scenario', v='turn')
    p.type('Reply with exactly one word: pong')
    if answer:
        p.wait_states([('working',), ('done', 'idle', 'error')], 120)
    else:
        p.wait_text(r'pong', 120)
    time.sleep(4)
    if answer:
        p.ev('scenario', v='permission')
        p.type('Use the Bash tool to run exactly this command: touch probe.txt')
        if p.wait_states([('blocked',)], 120):
            time.sleep(2)
            p.key(b'\x1b', 'Esc(deny)')
            p.wait_states([('working', 'idle', 'done', 'error')], 30)
        time.sleep(4)
        p.ev('scenario', v='esc-cancel')
        p.type('Write a detailed 1500-word essay about the history of whale research.')
        if p.wait_states([('working',)], 60):
            time.sleep(1.5)
            p.key(b'\x1b', 'Esc(cancel)')
            p.wait_states([('idle', 'done', 'error')], 30)
        time.sleep(3)
        p.ev('scenario', v='nudge')
        p.nudge()
    p.ev('scenario', v='exit')
    p.type('/exit')
    code = p.finish(20)
    return p, code, cwd


def run_claude_perm(outdir, channel=None, focus_out=False):
    name = 'claude-perm' + (f'-{channel}' if channel else '') + ('-blur' if focus_out else '')
    cwd = tempfile.mkdtemp(prefix=f'vq-{name}-')
    settings = {'disableAllHooks': True}
    if channel:
        settings['preferredNotifChannel'] = channel
    argv = [shutil.which('claude'), '--model', 'haiku', '--permission-mode', 'default',
            '--settings', json.dumps(settings)]
    p = Probe(name, argv, cwd, child_env(), outdir)
    p.start()
    if p.wait_text(r'(?i)trust this folder', 25):
        time.sleep(1)
        p.key(b'\x1b[B', 'Down')
        time.sleep(0.5)
        p.key(b'\r', 'Enter(trust)')
    p.wait_text(r'(?i)for shortcuts|\? for', 40)
    time.sleep(3)
    if focus_out:
        p.key(b'\x1b[O', 'FocusOut')
        time.sleep(0.5)
    for label, prompt, screen in (
            ('write', 'Use the Write tool to create a file named probe2.txt containing the word hi.', r'(?i)do you want'),
            ('question', 'Use the AskUserQuestion tool to ask me whether I prefer tea or coffee. Do nothing else.', r'(?i)tea')):
        p.ev('scenario', v=label)
        p.type(prompt)
        shown = p.wait_text(screen, 60)
        p.wait_states([('blocked',)], 20)
        time.sleep(1)
        p.key(b'\x1b', 'Esc')
        p.wait_states([('idle', 'done', 'error', 'working')], 20)
        time.sleep(3)
    p.ev('scenario', v='exit')
    p.type('/exit')
    code = p.finish(20)
    return p, code, cwd


def run_codex(outdir, notify=False):
    name = 'codex-notify' if notify else 'codex'
    cwd = tempfile.mkdtemp(prefix=f'vq-{name}-')
    subprocess.run(['git', 'init', '-q', cwd], check=True)
    argv = [shutil.which('codex'), '-a', 'on-request', '-s', 'read-only', '-c', 'model_reasoning_effort="low"']
    if notify:
        # Codex's own terminal notifications, as a per-session override like Claude's --settings.
        # "always" because vaquita, not Codex, decides whether to show the notification.
        argv += ['-c', 'tui.notifications=["agent-turn-complete","approval-requested","plan-mode-prompt","async-question"]',
                 '-c', 'tui.notification_method="osc9"',
                 '-c', 'tui.notification_condition="always"']
    p = Probe(name, argv, cwd, child_env(), outdir)
    p.start()
    if p.wait_text(r'(?i)trust|allow codex', 20):
        time.sleep(1)
        p.key(b'\r', 'Enter(trust)')
    p.wait_text(r'(?i)context left|esc to|send a message|ask codex|for shortcuts', 40)
    time.sleep(3)
    p.ev('scenario', v='turn')
    p.type('Reply with exactly one word: pong')
    p.wait_states([('working',), ('idle', 'done', 'error')], 180)
    time.sleep(4)
    p.ev('scenario', v='permission')
    p.type('Run this shell command: touch probe.txt')
    if p.wait_states([('blocked',)], 180):
        time.sleep(2)
        p.key(b'\x1b', 'Esc(deny)')
        p.wait_states([('working', 'idle', 'done', 'error')], 60)
    time.sleep(4)
    p.ev('scenario', v='esc-cancel')
    p.type('Count from 1 to 300, one number per line, no other text.')
    if p.wait_states([('working',)], 60):
        time.sleep(3)
        p.key(b'\x1b', 'Esc(cancel)')
        p.wait_states([('idle', 'done', 'error')], 30)
    time.sleep(3)
    p.ev('scenario', v='nudge')
    p.nudge()
    p.ev('scenario', v='exit')
    p.key(b'\x03', 'Ctrl-C')
    time.sleep(1.5)
    p.key(b'\x03', 'Ctrl-C')
    code = p.finish(20)
    return p, code, cwd


def summarize(p, code, cwd, outdir):
    with open(os.path.join(outdir, f'{p.name}.events.json'), 'w') as f:
        json.dump(p.events, f, ensure_ascii=False, indent=1)
    lines = [f'## {p.name}  exit={code}  cwd={cwd}']
    lines.append('### queries (in order)')
    for e in p.events:
        if e['k'] == 'query':
            lines.append(f"  {e['t']:>8}  {e['q']}  answered={e['answered']}")
    lines.append('### modes / kitty (in order, deduped consecutive)')
    prev = None
    for e in p.events:
        if e['k'] in ('mode', 'kitty', 'winop', 'RIS'):
            v = f"{e['k']} {e.get('v', '')}"
            if v != prev:
                lines.append(f"  {e['t']:>8}  {v}")
                prev = v
    lines.append('### timeline: scenario / input / 7501 / titles / other osc')
    for e in p.events:
        k = e['k']
        if k in ('scenario', 'type', 'key', 'wait_states', 'wait_text', '7501', 'notify', 'title', 'osc', 'exit', 'kill', 'eof', 'apc', 'dcs', 'nudge'):
            d = {x: y for x, y in e.items() if x not in ('t', 'k')}
            lines.append(f"  {e['t']:>8}  {k:<11} {json.dumps(d, ensure_ascii=False)[:160]}")
    out = '\n'.join(lines)
    with open(os.path.join(outdir, f'{p.name}.summary.txt'), 'w') as f:
        f.write(out + '\n')
    print(out)


if __name__ == '__main__':
    which, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    runner = {'claude': lambda: run_claude(outdir, True),
              'claude-noanswer': lambda: run_claude(outdir, False),
              'claude-perm': lambda: run_claude_perm(outdir),
              'claude-perm-ghostty': lambda: run_claude_perm(outdir, 'ghostty'),
              'claude-perm-ghostty-blur': lambda: run_claude_perm(outdir, 'ghostty', True),
              'codex': lambda: run_codex(outdir),
              'codex-notify': lambda: run_codex(outdir, notify=True)}[which]
    summarize(*runner(), outdir)
