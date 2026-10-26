import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonConnection, type CloseReason } from './connection';
import type { ConnectionLike } from './daemon-link';
import type { Endpoint } from './endpoint';
import { SessionManager, type ManagerState } from './manager';
import type { Notice } from './notify';
import { FRAME_LIVE, type Frame, type Live, type Replay, type SessionInfo, type Sessions } from './protocol';
import type { SessionCore } from './session-core';

// End-to-end checks against the dev daemon, which must be running:
//   VAQUITA_HOME=~/.vaquita-dev vaquitad serve --allow-origin http://localhost:1420
// Run with `npm run test:live`.

const ENDPOINT = join(homedir(), '.vaquita-dev', 'endpoint.json');
const DA1_REPLY = '\x1b[?1;2c';
const DA1_ECHO = '^[[?1;2c';
const LINES = 400_000;
// The login shell runs its startup files and then becomes dash, which has no
// line editor: the terminal driver echoes what is typed (control characters
// as ^X) and nothing redraws the command line, so the byte stream is exactly
// the echo and the programs' output.
const SHELL = "exec env ENV= PS1='$ ' /bin/dash -i";
const PROMPT = '$ ';

type Logged = ({ t: 'frame' } & Frame) | Replay | Live | Sessions;

interface HeadlessView {
	term: Terminal;
	core: SessionCore;
	proposed(): undefined;
	dispose(): void;
}

// A manager with headless terminals whose connection also logs every frame
// and every replay, live and sessions message, and the input it sends. Its
// notifications are collected in notes.
function client() {
	const log: Logged[] = [];
	const inputs: string[] = [];
	const notes: Notice[] = [];
	const texts = new Map<number, string>();
	const decoders = new Map<number, TextDecoder>();
	let state!: ManagerState<HeadlessView>;
	const m = new SessionManager({
		readEndpoint: async () => JSON.parse(readFileSync(ENDPOINT, 'utf8')) as Endpoint,
		startDaemon: async () => {},
		// As a dev run, which leaves the dev daemon alone.
		appBuild: async () => null,
		checkRestart: async () => {},
		restartDaemon: async () => {},
		connect: (endpoint, h) => {
			const conn = new DaemonConnection(endpoint, {
				...h,
				sessions: (list) => {
					log.push({ t: 'sessions', list });
					h.sessions(list);
				},
				replay: (msg) => {
					log.push(msg);
					h.replay(msg);
				},
				live: (msg) => {
					log.push(msg);
					h.live(msg);
				},
				frame: (f) => {
					log.push({ t: 'frame', ...f });
					let d = decoders.get(f.sid);
					if (!d) decoders.set(f.sid, (d = new TextDecoder()));
					texts.set(f.sid, (texts.get(f.sid) ?? '') + d.decode(f.payload, { stream: true }));
					h.frame(f);
				},
			});
			const logged: ConnectionLike = {
				close: () => conn.close(),
				create: (cwd, cmd, name, cols, rows) => conn.create(cwd, cmd, name, cols, rows),
				subscribe: (sid) => conn.subscribe(sid),
				kill: (sid) => conn.kill(sid),
				seen: (sid) => conn.seen(sid),
				reposAdd: (path) => conn.reposAdd(path),
				reposRemove: (path) => conn.reposRemove(path),
				reopen: (sid, cols, rows) => conn.reopen(sid, cols, rows),
				dismiss: (sid) => conn.dismiss(sid),
				rename: (sid, name) => conn.rename(sid, name),
				shutdown: (idle) => conn.shutdown(idle),
				ack: (sid, gen, off) => conn.ack(sid, gen, off),
				resize: (sid, cols, rows) => conn.resize(sid, cols, rows),
				input: (sid, gen, bytes) => {
					inputs.push(new TextDecoder().decode(bytes));
					conn.input(sid, gen, bytes);
				},
			};
			return logged;
		},
		createTerminal: (cols, rows) => new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 }),
		createView: (term, core) => ({ term, core, proposed: () => undefined, dispose: () => {} }),
		notifier: { show: (n) => notes.push(n) },
	});
	m.subscribe((s) => (state = s));
	const row = (sid: number) => state.sessions.find((r) => r.info.sid === sid);
	return {
		m,
		log,
		inputs,
		notes,
		state: () => state,
		row,
		view: (sid: number) => row(sid)!.view!,
		text: (sid: number) => texts.get(sid) ?? '',
	};
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

// A subscriber becomes the writer ahead of attach clients, so before any
// manager connects, a handshake alone (which subscribes to nothing) checks
// that the dev daemon has no running session of someone else's.
async function requireIdleDaemon(): Promise<void> {
	const endpoint = JSON.parse(readFileSync(ENDPOINT, 'utf8')) as Endpoint;
	const list = await new Promise<SessionInfo[]>((resolve, reject) => {
		const conn: DaemonConnection = new DaemonConnection(endpoint, {
			ready: (l) => {
				// Resolved first: close() reports through closed, whose reject is then ignored.
				resolve(l);
				conn.close();
			},
			sessions: () => {},
			replay: () => {},
			live: () => {},
			exit: () => {},
			error: () => {},
			status: () => {},
			notify: () => {},
			repos: () => {},
			frame: () => {},
			closed: (r: CloseReason) => reject(new Error(`daemon check failed: ${JSON.stringify(r)}`)),
		});
	});
	const running = list.filter((i) => i.state === 'running');
	if (running.length > 0) {
		throw new Error(`the dev daemon has ${running.length} running session(s); stop them before running the live test`);
	}
}

function screen(term: Terminal): string[] {
	const b = term.buffer.active;
	const lines: string[] = [];
	for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? '');
	return lines;
}

const count = (s: string, sub: string) => s.split(sub).length - 1;

// Within a generation the daemon sends every ring byte in order, so this
// client skips output only across a replay after its first live: the bytes
// from the live offset reached so far up to the new replay's start.
function skipped(log: Logged[], sid: number): string[] {
	const ranges: string[] = [];
	let gen: number | null = null;
	let reached = 0;
	for (const e of log) {
		if (e.t === 'live' && e.sid === sid) {
			gen = e.gen;
			reached = e.off;
		} else if (e.t === 'frame' && e.sid === sid && e.type === FRAME_LIVE && e.gen === gen) {
			reached += e.payload.length;
		} else if (e.t === 'replay' && e.sid === sid && gen !== null) {
			ranges.push(`replay gen ${e.gen} after live: skipped [${reached}, ${e.from})`);
		}
	}
	return ranges;
}

function firstDifference(got: string, want: string): string | undefined {
	if (got === want) return undefined;
	let i = 0;
	while (i < got.length && got[i] === want[i]) i++;
	const at = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 20));
	return `differs at ${i} (got ${got.length} chars, want ${want.length}): got ${at(got)}, want ${at(want)}`;
}

describe.skipIf(process.env.VAQUITA_LIVE !== '1')('live daemon', () => {
	beforeEach(() => {
		const store = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it('creates, shares, streams without loss and kills a session', { timeout: 120_000 }, async () => {
		await requireIdleDaemon();
		const a = client();
		const b = client();
		let sid: number | undefined;
		try {
			// (1) A creates the session and answers its terminal query once.
			a.m.start();
			await until(() => a.state().status === 'connected', 'A to connect');
			a.m.create('/tmp', SHELL, 'live-test');
			await until(() => !a.state().creating, 'the create to resolve');
			expect(a.state().report).toBeUndefined();
			sid = a.state().selected!;
			const s = sid;
			const core = a.view(s).core;
			await until(() => core.writable && a.text(s).endsWith(PROMPT), 'the dash prompt');

			core.sendInput("printf '\\033[c'; echo done\r");
			const lines = () => screen(a.view(s).term);
			await until(
				() => lines().some((l) => l.endsWith('done') && !l.includes('echo')) && count(lines().join('\n'), DA1_ECHO) >= 1,
				'done and the echoed DA1 reply',
			);
			// Room for a second reply, which must not come.
			await new Promise((r) => setTimeout(r, 300));
			expect(count(lines().join('\n'), DA1_ECHO)).toBe(1);
			expect(a.inputs.filter((i) => i.includes(DA1_REPLY))).toHaveLength(1);

			// (2) B subscribes too: read-only, and its replay's query goes unanswered.
			b.m.start();
			await until(() => b.row(s)?.ro === true, "B's read-only live");
			const bCore = b.view(s).core;
			await until(() => bCore.pendingReplay === 0, "B's replay to be parsed");
			expect(screen(b.view(s).term).some((l) => l.endsWith('done'))).toBe(true);
			expect(b.inputs.filter((i) => i.includes(DA1_REPLY))).toHaveLength(0);
			expect(core.writable).toBe(true);
			expect(a.row(s)?.ro).toBe(false);
			b.m.stop();

			// (3) About 2.7MB, past the daemon's 1MB ring and unacked cap.
			const mark = a.text(s).length;
			core.sendInput(`\x15seq 1 ${LINES}\r`);
			await until(
				() => a.text(s).endsWith(`${LINES}\r\n${PROMPT}`) || skipped(a.log, s).length > 0,
				`the prompt after ${LINES}`,
				90_000,
			);
			expect(skipped(a.log, s)).toEqual([]);
			const typed = a.text(s).slice(mark);
			const echo = `seq 1 ${LINES}\r\n`;
			const start = typed.indexOf(echo);
			expect(start).toBeGreaterThanOrEqual(0);
			const output = typed.slice(start + echo.length, -PROMPT.length).replaceAll('\r\n', '\n');
			const want = Array.from({ length: LINES }, (_, i) => `${i + 1}\n`).join('');
			expect(firstDifference(output, want)).toBeUndefined();

			// (4) A kills it; the next list no longer has it.
			const before = a.log.length;
			a.m.kill(s);
			const nextList = () => a.log.slice(before).find((e): e is Sessions => e.t === 'sessions');
			await until(() => nextList() !== undefined, 'a sessions list after the kill');
			expect(nextList()!.list.map((i) => i.sid)).not.toContain(s);
			sid = undefined;
		} finally {
			if (sid !== undefined) a.m.kill(sid);
			a.m.stop();
			b.m.stop();
		}
	});

	it('shows an error report as an unread row, notifies it and clears unread on seen', { timeout: 30_000 }, async () => {
		await requireIdleDaemon();
		const a = client();
		let sid: number | undefined;
		try {
			// Unfocused, the created session is selected but not looked at.
			a.m.setFocused(false);
			a.m.start();
			await until(() => a.state().status === 'connected', 'A to connect');
			// The shell runs the report, then turns interactive.
			a.m.create('/tmp', "printf '\\033]7501;state=error:app=x\\033\\\\'", 'status-test');
			await until(() => !a.state().creating, 'the create to resolve');
			expect(a.state().report).toBeUndefined();
			sid = a.state().selected!;
			const s = sid;
			await until(() => a.row(s)?.info.status?.state === 'error' && a.row(s)?.info.unread === true, 'the unread error row');
			await until(() => a.notes.length > 0, 'the notification');
			expect(a.notes).toEqual([{ title: 'status-test failed', body: '', target: { sid: s, inc: a.row(s)!.info.inc } }]);

			// Focus on the selected session sends a seen, which the daemon accepts.
			a.m.setFocused(true);
			await until(() => a.row(s)?.info.unread === false, 'unread to clear');
			expect(a.row(s)?.info.status?.state).toBe('error');
			expect(a.state().report).toBeUndefined();

			const before = a.log.length;
			a.m.kill(s);
			const nextList = () => a.log.slice(before).find((e): e is Sessions => e.t === 'sessions');
			await until(() => nextList() !== undefined, 'a sessions list after the kill');
			expect(nextList()!.list.map((i) => i.sid)).not.toContain(s);
			sid = undefined;
		} finally {
			if (sid !== undefined) a.m.kill(sid);
			a.m.stop();
		}
	});

	it('adds and removes a repo', async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vaquita-live-repo-')));
		const a = client();
		try {
			a.m.start();
			await until(() => a.state().status === 'connected', 'A to connect');
			a.m.addRepo(dir);
			await until(() => a.state().repos.includes(dir), 'the repo to be listed');
			a.m.removeRepo(dir);
			await until(() => !a.state().repos.includes(dir), 'the repo to be gone');
		} finally {
			a.m.removeRepo(dir);
			a.m.stop();
			rmSync(dir, { recursive: true });
		}
	});
});
