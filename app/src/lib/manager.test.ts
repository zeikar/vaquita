import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionHandlers } from './connection';
import { NotRunningError, type Endpoint } from './endpoint';
import { SessionManager, type ConnectionLike, type ManagerState } from './manager';
import type { Notice } from './notify';
import { FRAME_LIVE, FRAME_REPLAY, type Live, type Replay, type SessionInfo, type Status, type StatusInfo } from './protocol';
import type { SessionCore, Size } from './session-core';

class FakeConnection implements ConnectionLike {
	closed = false;
	// subscribe, create and kill, in the order sent.
	requests: (string | number)[][] = [];
	constructor(
		readonly endpoint: Endpoint,
		readonly emit: ConnectionHandlers,
	) {}
	close(): void {
		this.closed = true;
	}
	create(cwd: string, cmd: string, name: string, cols: number, rows: number): void {
		this.requests.push(['create', cwd, cmd, name, cols, rows]);
	}
	subscribe(sid: number): void {
		this.requests.push(['subscribe', sid]);
	}
	kill(sid: number): void {
		this.requests.push(['kill', sid]);
	}
	repoAdds: string[] = [];
	repoRemoves: string[] = [];
	dismisses: number[] = [];
	reposAdd(path: string): void {
		this.repoAdds.push(path);
	}
	reposRemove(path: string): void {
		this.repoRemoves.push(path);
	}
	reopen(sid: number, cols: number, rows: number): void {
		this.requests.push(['reopen', sid, cols, rows]);
	}
	dismiss(sid: number): void {
		this.dismisses.push(sid);
	}
	shutdowns: boolean[] = [];
	shutdown(idle: boolean): void {
		this.shutdowns.push(idle);
	}
	// Kept apart from requests: a seen is no request the daemon answers in turn.
	seens: number[] = [];
	seen(sid: number): void {
		this.seens.push(sid);
	}
	ack(): void {}
	input(): void {}
	resize(): void {}
	get subscribes(): number[] {
		return this.requests.filter((r) => r[0] === 'subscribe').map((r) => r[1] as number);
	}
}

class FakeView {
	size: Size | undefined;
	disposed = false;
	constructor(
		readonly term: Terminal,
		readonly core: SessionCore,
	) {}
	proposed(): Size | undefined {
		return this.size;
	}
	dispose(): void {
		this.disposed = true;
	}
}

const ep: Endpoint = { url: 'ws://127.0.0.1:1/ws', token: 't', pid: 1 };
const info = (sid: number, inc = 'i', state = 'running', restorable?: boolean): SessionInfo => ({
	sid, inc, cwd: '/tmp/repo', cmd: 'sh', name: '', cols: 80, rows: 24, state, pid: 2, code: 0,
	...(restorable ? { restorable } : {}),
});
const record = (sid: number): SessionInfo => ({ ...info(sid, 'old', 'exited', true), cmd: 'claude', name: 'w' });
const replay = (sid: number, gen = 1): Replay => ({ t: 'replay', sid, gen, from: 0, to: 0, cols: 80, rows: 24 });
const live = (sid: number, ro = false): Live => ({ t: 'live', sid, gen: 1, off: 0, ro });
const status = (sid: number, s: StatusInfo | null, unread = false): Status => ({ t: 'status', sid, status: s, unread });
const encoder = new TextEncoder();

// The daemon's answer to a subscribe of an idle session.
function answer(c: FakeConnection, sid: number, ro = false) {
	c.emit.replay(replay(sid));
	c.emit.frame({ type: FRAME_REPLAY, sid, gen: 1, payload: new Uint8Array() });
	c.emit.live(live(sid, ro));
}

const rejectStart = async () => {
	throw new Error('hint');
};

function setup(
	readEndpoint: () => Promise<Endpoint> = async () => ep,
	connectHook: () => void = () => {},
	startDaemon: () => Promise<void> = rejectStart,
	{
		appBuild = async (): Promise<string | null> => null,
		checkRestart = async () => {},
		restartDaemon = async (_endpoint: Endpoint, _signal: boolean) => {},
	} = {},
) {
	const conns: FakeConnection[] = [];
	const notes: Notice[] = [];
	const read = vi.fn(readEndpoint);
	const start = vi.fn(startDaemon);
	const check = vi.fn(checkRestart);
	const restart = vi.fn(restartDaemon);
	const m = new SessionManager({
		readEndpoint: read,
		startDaemon: start,
		appBuild,
		checkRestart: check,
		restartDaemon: restart,
		connect: (endpoint, handlers) => {
			connectHook();
			const c = new FakeConnection(endpoint, handlers);
			conns.push(c);
			return c;
		},
		createTerminal: (cols, rows) => new Terminal({ cols, rows, allowProposedApi: true }),
		createView: (term, core) => new FakeView(term, core),
		notifier: { show: (n) => notes.push(n) },
	});
	let state!: ManagerState<FakeView>;
	let emits = 0;
	m.subscribe((s) => {
		state = s;
		emits++;
	});
	const row = (sid: number) => state.sessions.find((r) => r.info.sid === sid);
	return { m, conns, notes, read, start, check, restart, state: () => state, row, emits: () => emits };
}

// Started, with the first connection past its handshake.
async function connected(list: SessionInfo[], selected?: number) {
	if (selected !== undefined) localStorage.setItem('vaquita.selected', String(selected));
	const t = setup();
	t.m.start();
	await vi.advanceTimersByTimeAsync(0);
	t.conns[0].emit.ready(list);
	return { ...t, c: t.conns[0] };
}

// The connection that replaces the current one after it closes.
async function reconnect(t: Awaited<ReturnType<typeof connected>>, list: SessionInfo[], build?: string) {
	t.conns.at(-1)!.emit.closed({ kind: 'closed', detail: 'code 1006' });
	await vi.advanceTimersByTimeAsync(1000);
	const c = t.conns.at(-1)!;
	c.emit.ready(list, build);
	return c;
}

beforeEach(() => {
	vi.useFakeTimers();
	const store = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('SessionManager', () => {
	it('is connected with the list after ready', async () => {
		const t = setup();
		expect(t.state().status).toBe('connecting');
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.ready([info(1)]);
		expect(t.state().status).toBe('connected');
		expect(t.state().sessions.map((r) => r.info)).toEqual([info(1)]);
		t.conns[0].emit.sessions([info(1), info(2)]);
		expect(t.state().sessions).toHaveLength(2);
		t.m.stop();
	});

	it('retries after 1s, 2s, 4s, then every 5s, re-reading the endpoint', async () => {
		const t = setup();
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		for (const delay of [1000, 2000, 4000, 5000, 5000]) {
			const n = t.conns.length;
			t.conns[n - 1].emit.closed({ kind: 'closed', detail: 'code 1006' });
			expect(t.state().status).toBe('disconnected');
			expect(t.state().message).toBe('code 1006');
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(t.conns).toHaveLength(n);
			await vi.advanceTimersByTimeAsync(1);
			expect(t.conns).toHaveLength(n + 1);
		}
		expect(t.read).toHaveBeenCalledTimes(6);
		t.m.stop();
	});

	it('resets the schedule after a successful ready', async () => {
		const t = setup();
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.closed({ kind: 'failed', detail: 'x' });
		await vi.advanceTimersByTimeAsync(1000);
		t.conns[1].emit.closed({ kind: 'failed', detail: 'x' });
		await vi.advanceTimersByTimeAsync(2000);
		t.conns[2].emit.ready([]);
		t.conns[2].emit.closed({ kind: 'closed', detail: 'x' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.conns).toHaveLength(4);
		t.m.stop();
	});

	it('stops retrying on a version mismatch', async () => {
		const t = setup();
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.closed({ kind: 'version', daemonV: 3 });
		expect(t.state().status).toBe('version-mismatch');
		expect(t.state().daemonV).toBe(3);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(t.conns).toHaveLength(1);
		expect(t.read).toHaveBeenCalledTimes(1);
	});

	it('reports not-running and retries at +1s', async () => {
		let running = false;
		const t = setup(async () => {
			if (!running) throw new NotRunningError();
			return ep;
		});
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(t.state().status).toBe('not-running');
		expect(t.state().message).toBe('hint');
		running = true;
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.conns).toHaveLength(1);
		t.conns[0].emit.ready([]);
		expect(t.state().status).toBe('connected');
		t.m.stop();
	});

	describe('daemon start', () => {
		it('starts once on NotRunningError, then re-reads the endpoint at once', async () => {
			let running = false;
			let release!: () => void;
			const t = setup(
				async () => {
					if (!running) throw new NotRunningError();
					return ep;
				},
				() => {},
				() => new Promise<void>((r) => (release = r)),
			);
			t.m.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(t.state().status).toBe('starting');
			expect(t.start).toHaveBeenCalledTimes(1);
			expect(t.conns).toHaveLength(0);
			running = true;
			release();
			await vi.advanceTimersByTimeAsync(0);
			expect(t.read).toHaveBeenCalledTimes(2);
			expect(t.conns).toHaveLength(1);
			t.m.stop();
		});

		it('a rejected start shows its message, is not repeated by the retry, and is re-armed by ready', async () => {
			let running = false;
			const t = setup(async () => {
				if (!running) throw new NotRunningError();
				return ep;
			});
			t.m.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(t.state().status).toBe('not-running');
			expect(t.state().message).toBe('hint');
			await vi.advanceTimersByTimeAsync(1000);
			expect(t.read).toHaveBeenCalledTimes(2);
			expect(t.start).toHaveBeenCalledTimes(1);
			expect(t.state().status).toBe('not-running');
			expect(t.state().message).toBe('hint');
			running = true;
			await vi.advanceTimersByTimeAsync(2000);
			t.conns[0].emit.ready([]);
			running = false;
			t.conns[0].emit.closed({ kind: 'closed', detail: 'x' });
			await vi.advanceTimersByTimeAsync(1000);
			expect(t.start).toHaveBeenCalledTimes(2);
			t.m.stop();
		});

		it('stop during the awaited start leaves no connection', async () => {
			let release!: () => void;
			const t = setup(
				async () => {
					throw new NotRunningError();
				},
				() => {},
				() => new Promise<void>((r) => (release = r)),
			);
			t.m.start();
			await vi.advanceTimersByTimeAsync(0);
			t.m.stop();
			release();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(t.read).toHaveBeenCalledTimes(1);
			expect(t.conns).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('a rejected start after a failure before ready keeps its message and retries', async () => {
			const t = setup();
			t.m.start();
			await vi.advanceTimersByTimeAsync(0);
			t.conns[0].emit.closed({ kind: 'failed', detail: 'x' });
			await vi.advanceTimersByTimeAsync(0);
			expect(t.state().status).toBe('not-running');
			expect(t.state().message).toBe('hint');
			await vi.advanceTimersByTimeAsync(1000);
			expect(t.conns).toHaveLength(2);
			expect(t.start).toHaveBeenCalledTimes(1);
			t.conns[1].emit.closed({ kind: 'failed', detail: 'code 1006' });
			expect(t.state().status).toBe('not-running');
			expect(t.state().message).toBe('hint');
			t.m.stop();
		});

		it('also starts when the connection fails before ready, then reconnects at once', async () => {
			const t = setup(async () => ep, () => {}, async () => {});
			t.m.start();
			await vi.advanceTimersByTimeAsync(0);
			t.conns[0].emit.closed({ kind: 'failed', detail: 'x' });
			expect(t.state().status).toBe('starting');
			await vi.advanceTimersByTimeAsync(0);
			expect(t.start).toHaveBeenCalledTimes(1);
			expect(t.conns).toHaveLength(2);
			t.conns[1].emit.closed({ kind: 'failed', detail: 'y' });
			expect(t.state().status).toBe('disconnected');
			expect(t.start).toHaveBeenCalledTimes(1);
			t.m.stop();
		});
	});

	it('treats a hello that never completes as a failed attempt', async () => {
		const t = setup();
		t.m.start();
		await vi.advanceTimersByTimeAsync(4999);
		expect(t.state().status).toBe('connecting');
		await vi.advanceTimersByTimeAsync(1);
		expect(t.conns[0].closed).toBe(true);
		expect(t.state().status).toBe('disconnected');
		expect(t.state().message).toBe('no answer to hello');
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.conns).toHaveLength(2);
		t.m.stop();
	});

	it('retries when connect throws synchronously', async () => {
		let throwOnce = true;
		const t = setup(async () => ep, () => {
			if (throwOnce) {
				throwOnce = false;
				throw new Error('bad url');
			}
		});
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(t.state().status).toBe('disconnected');
		expect(t.state().message).toBe('bad url');
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.conns).toHaveLength(1);
		t.m.stop();
	});

	it('ready cancels the hello timer', async () => {
		const t = setup();
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.ready([]);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(t.conns).toHaveLength(1);
		expect(t.conns[0].closed).toBe(false);
		expect(t.state().status).toBe('connected');
		t.m.stop();
	});

	it('stop during an in-flight readEndpoint leaves no connection or timers', async () => {
		let resolve!: (e: Endpoint) => void;
		const t = setup(() => new Promise<Endpoint>((r) => (resolve = r)));
		t.m.start();
		// The app build is asked first.
		await vi.advanceTimersByTimeAsync(0);
		expect(t.read).toHaveBeenCalledTimes(1);
		t.m.stop();
		resolve(ep);
		await vi.advanceTimersByTimeAsync(0);
		expect(t.conns).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('stop cancels a pending retry', async () => {
		const t = setup();
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.closed({ kind: 'closed', detail: 'x' });
		t.m.stop();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(t.conns).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('stop closes the open connection, and a second start does not orphan it', async () => {
		const t = setup();
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.ready([]);
		t.m.start();
		expect(t.conns[0].closed).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(t.conns).toHaveLength(2);
		t.m.stop();
		expect(t.conns[1].closed).toBe(true);
	});

	it('ignores a late close from an abandoned attempt', async () => {
		const t = setup();
		t.m.start();
		await vi.advanceTimersByTimeAsync(5000);
		t.conns[0].emit.closed({ kind: 'closed', detail: 'closed locally' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.conns).toHaveLength(2);
		t.m.stop();
	});
});

describe('SessionManager sessions', () => {
	it('subscribes the selected session first, then the running ones by sid, one at a time', async () => {
		const t = await connected([info(1), info(2), info(3), info(4, 'i', 'exited')], 3);
		expect(t.state().selected).toBe(3);
		expect(t.c.subscribes).toEqual([3]);
		t.c.emit.replay(replay(3));
		expect(t.c.subscribes).toEqual([3]);
		t.c.emit.live(live(3));
		expect(t.c.subscribes).toEqual([3, 1]);
		answer(t.c, 1);
		expect(t.c.subscribes).toEqual([3, 1, 2]);
		answer(t.c, 2);
		expect(t.c.requests).toHaveLength(3);
		expect(t.row(4)?.view).toBeUndefined();
		t.m.select(1);
		expect(t.state().selected).toBe(1);
		expect(localStorage.getItem('vaquita.selected')).toBe('1');
		t.m.stop();
	});

	it('sends a create asked for during a subscribe before the next subscribe, and resolves it by its replay', async () => {
		const t = await connected([info(1), info(2)]);
		t.m.create('/tmp/repo', '', 'w');
		t.m.create('/tmp/other', '', '');
		expect(t.state().creating).toBe(true);
		expect(t.c.requests).toEqual([['subscribe', 1]]);
		t.c.emit.replay(replay(1));
		expect(t.c.requests).toEqual([['subscribe', 1]]);
		t.c.emit.live(live(1));
		expect(t.c.requests).toEqual([['subscribe', 1], ['create', '/tmp/repo', '', 'w', 120, 40]]);

		t.c.emit.sessions([info(1), info(2), info(4)]);
		expect(t.c.requests).toHaveLength(2);
		t.c.emit.replay(replay(4));
		expect(t.row(4)?.view).toBeDefined();
		expect(t.state().selected).toBe(4);
		expect(localStorage.getItem('vaquita.selected')).toBe('4');
		expect(t.state().creating).toBe(false);
		expect(t.c.requests.at(-1)).toEqual(['subscribe', 2]);

		// The created session's own live does not answer subscribe(2).
		t.c.emit.live(live(4));
		expect(t.c.requests).toHaveLength(3);
		answer(t.c, 2);
		expect(t.c.subscribes).toEqual([1, 2]);
		expect(t.c.requests).toHaveLength(3);
		t.m.stop();
	});

	it('resolves a create whose replay comes before the list showing the session', async () => {
		const t = await connected([]);
		t.m.create('/tmp/repo', 'make', '');
		t.c.emit.replay(replay(5));
		expect(t.state().creating).toBe(false);
		expect(t.state().selected).toBe(5);
		expect(t.row(5)?.info.cmd).toBe('make');
		expect(t.row(5)?.view).toBeDefined();
		// A list sent before the create was handled.
		t.c.emit.sessions([]);
		expect(t.row(5)).toBeDefined();
		t.c.emit.sessions([info(5)]);
		expect(t.row(5)?.info).toEqual(info(5));
		expect(t.c.subscribes).toEqual([]);
		t.c.emit.sessions([]);
		expect(t.row(5)).toBeUndefined();
		t.m.stop();
	});

	it('creates at the selected view\'s proposed size', async () => {
		const t = await connected([info(1)], 1);
		answer(t.c, 1);
		t.row(1)!.view!.size = { cols: 100, rows: 30 };
		t.m.create('', '', '');
		expect(t.c.requests.at(-1)).toEqual(['create', '', '', '', 100, 30]);
		t.m.stop();
	});

	it('enables the form again when a create fails, and sends the next create', async () => {
		const t = await connected([]);
		t.m.create('/nope', '', '');
		expect(t.c.requests).toEqual([['create', '/nope', '', '', 120, 40]]);
		t.c.emit.error({ t: 'error', code: 'bad-request' });
		expect(t.state().message).toBe('create failed (bad-request)');
		expect(t.state().creating).toBe(false);
		t.m.create('/tmp/repo', '', '');
		expect(t.c.requests).toEqual([
			['create', '/nope', '', '', 120, 40],
			['create', '/tmp/repo', '', '', 120, 40],
		]);
		t.m.stop();
	});

	it('frees the slot on an error for the outstanding subscribe only', async () => {
		const t = await connected([info(2), info(3)]);
		t.c.emit.error({ t: 'error', code: 'no-session', sid: 9 });
		expect(t.c.subscribes).toEqual([2]);
		t.c.emit.error({ t: 'error', code: 'bad-request', sid: 2 });
		expect(t.state().message).toBe('subscribe to session "sh" failed (bad-request)');
		expect(t.c.subscribes).toEqual([2, 3]);
		t.m.stop();
	});

	it('keeps quiet when a record from an earlier daemon run has no session to subscribe', async () => {
		const t = await connected([info(1), info(3, 'i', 'exited')], 3);
		expect(t.c.subscribes).toEqual([3]);
		t.c.emit.error({ t: 'error', code: 'no-session', sid: 3 });
		expect(t.state().message).toBeUndefined();
		expect(t.c.subscribes).toEqual([3, 1]);
		t.m.stop();
	});

	it('subscribes an exited session of this run when it is selected', async () => {
		const t = await connected([info(1), info(4, 'i', 'exited')], 1);
		answer(t.c, 1);
		expect(t.c.subscribes).toEqual([1]);
		t.m.select(4);
		expect(t.c.subscribes).toEqual([1, 4]);
		expect(t.row(4)?.view).toBeDefined();
		t.m.stop();
	});

	it('enables the form again when the connection is lost during a create', async () => {
		const t = await connected([]);
		t.m.create('/tmp/repo', '', '');
		expect(t.state().creating).toBe(true);
		t.c.emit.closed({ kind: 'closed', detail: 'code 1006' });
		expect(t.state().creating).toBe(false);
		t.m.stop();
	});

	it('drops a create waiting behind a subscribe with the connection', async () => {
		const t = await connected([info(1)]);
		t.m.create('/tmp/repo', '', '');
		t.c.emit.closed({ kind: 'closed', detail: 'code 1006' });
		expect(t.state().creating).toBe(false);
		await vi.advanceTimersByTimeAsync(1000);
		const c = t.conns[1];
		c.emit.ready([info(1)]);
		expect(c.requests).toEqual([['subscribe', 1]]);
		answer(c, 1);
		expect(c.requests).toEqual([['subscribe', 1]]);
		t.m.stop();
	});

	it('keeps a terminal across a reconnect to the same session and replaces it for a new inc', async () => {
		const t = await connected([info(2)]);
		answer(t.c, 2);
		const view = t.row(2)!.view!;
		const attach = vi.spyOn(view.core, 'attach');

		const c2 = await reconnect(t, [info(2)]);
		expect(attach).toHaveBeenCalledWith(c2);
		expect(t.row(2)?.view).toBe(view);
		expect(c2.subscribes).toEqual([2]);
		answer(c2, 2);
		expect(t.row(2)?.resets).toBe(1);

		const c3 = await reconnect(t, [info(2, 'j')]);
		expect(view.disposed).toBe(true);
		expect(t.row(2)?.view).toBeDefined();
		expect(t.row(2)?.view).not.toBe(view);
		expect(c3.subscribes).toEqual([2]);
		t.m.stop();
	});

	it('ignores messages from a connection that has been replaced', async () => {
		const t = await connected([info(1)]);
		const c2 = await reconnect(t, [info(1)]);
		t.c.emit.sessions([]);
		t.c.emit.live(live(1));
		expect(t.row(1)).toBeDefined();
		expect(c2.subscribes).toEqual([1]);
		t.m.stop();
	});

	it('disposes a session missing from a list', async () => {
		const t = await connected([info(1), info(2)]);
		answer(t.c, 1);
		const view = t.row(1)!.view!;
		const dispose = vi.spyOn(view.term, 'dispose');
		t.c.emit.sessions([info(2)]);
		expect(t.row(1)).toBeUndefined();
		expect(view.disposed).toBe(true);
		expect(dispose).toHaveBeenCalled();
		t.m.stop();
	});

	it('shows read-only, status reports and resets in the list', async () => {
		const t = await connected([info(1)]);
		answer(t.c, 1, true);
		expect(t.row(1)).toMatchObject({ ro: true, reports: 0, resets: 0 });
		t.c.emit.frame({ type: FRAME_LIVE, sid: 1, gen: 1, payload: encoder.encode('\x1b]7501;idle\x1b\\') });
		// Counted while xterm parses, after the frame handler has returned.
		expect(t.row(1)?.reports).toBe(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(t.row(1)?.reports).toBe(1);
		t.c.emit.replay(replay(1, 2));
		expect(t.row(1)?.resets).toBe(1);
		t.m.stop();
	});

	it('publishes nothing for parsed output that has no status report', async () => {
		const t = await connected([info(1)]);
		answer(t.c, 1);
		await vi.advanceTimersByTimeAsync(0);
		const before = t.emits();
		t.c.emit.frame({ type: FRAME_LIVE, sid: 1, gen: 1, payload: encoder.encode('hello\r\n') });
		await vi.advanceTimersByTimeAsync(0);
		expect(t.row(1)!.view!.term.buffer.active.getLine(0)?.translateToString(true)).toBe('hello');
		expect(t.emits()).toBe(before);
		t.m.stop();
	});

	it('reports a kill that left processes behind', async () => {
		const t = await connected([info(1)]);
		t.m.kill(1);
		expect(t.c.requests.at(-1)).toEqual(['kill', 1]);
		t.c.emit.error({ t: 'error', code: 'orphans', sid: 1, pids: [9] });
		expect(t.state().message).toBe('session "sh" left processes behind: 9');
		t.m.stop();
	});
});

describe('SessionManager status', () => {
	const done: StatusInfo = { state: 'done', msg: 'ok' };
	const unread = (sid: number): SessionInfo => ({ ...info(sid), status: done, unread: true });

	it('patches a status into its row and clears it with a null', async () => {
		const t = await connected([info(1)]);
		t.c.emit.status(status(1, { state: 'input', kind: 'permission', msg: 'Run make?' }));
		expect(t.row(1)?.info).toMatchObject({ status: { state: 'input', kind: 'permission', msg: 'Run make?' }, unread: false });
		t.c.emit.status(status(1, done, true));
		expect(t.row(1)?.info).toMatchObject({ status: done, unread: true });
		t.c.emit.status(status(1, null));
		expect(t.row(1)?.info.status).toBeUndefined();
		expect(t.row(1)?.info.unread).toBe(false);
		t.c.emit.status(status(9, done, true));
		expect(t.row(9)).toBeUndefined();
		t.m.stop();
	});

	it('replaces status and unread with those of a list', async () => {
		const t = await connected([info(1), unread(2)], 1);
		expect(t.row(2)?.info).toMatchObject({ status: done, unread: true });
		expect(t.c.seens).toEqual([]);
		t.c.emit.sessions([info(1), info(2)]);
		expect(t.row(2)?.info.status).toBeUndefined();
		expect(t.row(2)?.info.unread).toBeUndefined();
		expect(t.c.seens).toEqual([]);
		t.c.emit.status(status(2, done, true));
		const c2 = await reconnect(t, [info(1), info(2)]);
		expect(t.row(2)?.info.status).toBeUndefined();
		expect(t.row(2)?.info.unread).toBeUndefined();
		expect(c2.seens).toEqual([]);
		t.m.stop();
	});

	it('sees the selected row on connect when it is unread, while focused', async () => {
		const t = await connected([unread(1)], 1);
		expect(t.c.seens).toEqual([1]);
		const c2 = await reconnect(t, [info(1)]);
		expect(c2.seens).toEqual([]);
		t.m.setFocused(false);
		const c3 = await reconnect(t, [unread(1)]);
		expect(c3.seens).toEqual([]);
		t.m.setFocused(true);
		expect(c3.seens).toEqual([1]);
		t.m.stop();
	});

	it('sends seen when a row with unread or a status is selected, and never for a row with neither', async () => {
		const working: SessionInfo = { ...info(3), status: { state: 'working' } };
		const t = await connected([info(1), unread(2), working]);
		t.m.select(1);
		expect(t.c.seens).toEqual([]);
		t.m.select(2);
		t.m.select(3);
		expect(t.c.seens).toEqual([2, 3]);
		t.m.stop();
	});

	it('sends no seen while unfocused, and one when focus comes back to such a row', async () => {
		const t = await connected([info(1), unread(2)], 1);
		expect(t.state().focused).toBe(true);
		t.m.setFocused(false);
		expect(t.state().focused).toBe(false);
		t.m.select(2);
		t.c.emit.status(status(2, done, true));
		expect(t.c.seens).toEqual([]);
		t.m.setFocused(true);
		expect(t.c.seens).toEqual([2]);
		t.m.setFocused(true);
		expect(t.c.seens).toEqual([2]);
		t.m.select(1);
		t.m.setFocused(false);
		t.m.setFocused(true);
		expect(t.c.seens).toEqual([2]);
		t.m.stop();
	});

	it('sees an unread status of the selected session while focused, but not the status answering the seen', async () => {
		const t = await connected([info(1), info(2)], 1);
		t.c.emit.status(status(1, { state: 'working' }));
		t.c.emit.status(status(1, done));
		expect(t.c.seens).toEqual([]);
		t.c.emit.status(status(1, done, true));
		expect(t.c.seens).toEqual([1]);
		t.c.emit.status(status(1, done));
		t.c.emit.status(status(2, { state: 'error' }, true));
		expect(t.c.seens).toEqual([1]);
		t.m.stop();
	});

	it('sees an input view arriving on the selected session once, which releases a plan prompt', async () => {
		const plan: StatusInfo = { state: 'input', msg: 'Implement this plan?' };
		const t = await connected([info(1)], 1);
		t.c.emit.status(status(1, plan));
		expect(t.c.seens).toEqual([1]);
		t.c.emit.status(status(1, null));
		expect(t.c.seens).toEqual([1]);
		t.m.stop();
	});

	it('sees a status that a list showed first', async () => {
		const t = await connected([info(1)], 1);
		// The list reads the view the status event then reports.
		t.c.emit.sessions([unread(1)]);
		expect(t.c.seens).toEqual([]);
		t.c.emit.status(status(1, done, true));
		expect(t.c.seens).toEqual([1]);
		t.c.emit.status(status(1, done));
		expect(t.c.seens).toEqual([1]);
		t.m.stop();
	});

	it('notifies unless the session is selected and the window focused', async () => {
		const t = await connected([info(1), info(2)], 1);
		t.c.emit.notify({ t: 'notify', sid: 1, kind: 'done', msg: 'ok' });
		expect(t.notes).toEqual([]);
		t.c.emit.notify({ t: 'notify', sid: 2, kind: 'error', msg: 'exit 1' });
		expect(t.notes).toEqual([{ title: 'sh failed', body: 'exit 1', target: { sid: 2, inc: 'i' } }]);
		t.m.setFocused(false);
		t.c.emit.notify({ t: 'notify', sid: 1, kind: 'input', msg: 'Run make?' });
		expect(t.notes.at(-1)).toEqual({ title: 'sh needs input', body: 'Run make?', target: { sid: 1, inc: 'i' } });
		t.m.stop();
	});

	it('always shows the missed summary', async () => {
		const t = await connected([info(1)], 1);
		t.c.emit.notify({ t: 'notify', kind: 'missed', count: 2 });
		const t2 = await connected([]);
		t2.c.emit.notify({ t: 'notify', kind: 'missed', count: 3 });
		expect(t.notes).toEqual([{ title: 'vaquita', body: '2 notifications while you were away' }]);
		expect(t2.notes).toEqual([{ title: 'vaquita', body: '3 notifications while you were away' }]);
		t.m.stop();
		t2.m.stop();
	});

	it('selects the target of a clicked notification only while a row has its sid and inc', async () => {
		const t = await connected([info(1), info(3, 'A')], 1);
		t.m.setFocused(false);
		t.c.emit.notify({ t: 'notify', sid: 3, kind: 'done' });
		const target = t.notes[0].target;
		t.m.openNotified(target);
		expect(t.state().selected).toBe(3);

		t.m.select(1);
		await reconnect(t, [info(1), info(3, 'B')]);
		t.m.openNotified(target);
		expect(t.state().selected).toBe(1);
		t.m.openNotified(undefined);
		expect(t.state().selected).toBe(1);
		t.m.openNotified({ sid: 9, inc: 'A' });
		expect(t.state().selected).toBe(1);
		t.m.stop();
	});

	it('applies a click that came before the first list once it has been applied, only once', async () => {
		const t = setup();
		t.m.openNotified({ sid: 3, inc: 'i' });
		t.m.openNotified({ sid: 3, inc: 'i' });
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.ready([info(1), info(3)]);
		expect(t.state().selected).toBe(3);
		t.m.select(1);
		const c = { ...t, c: t.conns[0] };
		await reconnect(c, [info(1), info(3)]);
		expect(t.state().selected).toBe(1);
		t.m.stop();
	});

	it('ignores a click from before the first list whose session is not there', async () => {
		const t = setup();
		t.m.openNotified({ sid: 3, inc: 'old' });
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.ready([info(1), info(3)]);
		expect(t.state().selected).not.toBe(3);
		t.m.stop();
	});

	it('keeps the repo list across a reconnect until the next one', async () => {
		const t = await connected([]);
		expect(t.state().repos).toEqual([]);
		t.c.emit.repos(['/tmp/repo']);
		expect(t.state().repos).toEqual(['/tmp/repo']);
		const c = await reconnect(t, []);
		expect(t.state().repos).toEqual(['/tmp/repo']);
		c.emit.repos(['/tmp/a', '/tmp/b']);
		expect(t.state().repos).toEqual(['/tmp/a', '/tmp/b']);
		t.m.stop();
	});

	it('sends repo adds and removes only with a ready connection', async () => {
		const t = setup();
		t.m.addRepo('/tmp/x');
		t.m.removeRepo('/tmp/x');
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.m.addRepo('/tmp/x');
		t.m.removeRepo('/tmp/x');
		t.conns[0].emit.ready([]);
		expect(t.conns[0].repoAdds).toEqual([]);
		expect(t.conns[0].repoRemoves).toEqual([]);
		t.m.addRepo('/tmp/repo');
		t.m.removeRepo('/tmp/repo');
		expect(t.conns[0].repoAdds).toEqual(['/tmp/repo']);
		expect(t.conns[0].repoRemoves).toEqual(['/tmp/repo']);
		t.m.stop();
	});

	it('reopens a restorable row at the selected view\'s size and swaps the row for the new session', async () => {
		const t = await connected([info(1), record(7)], 1);
		answer(t.c, 1);
		t.row(1)!.view!.size = { cols: 100, rows: 30 };
		t.m.reopen(7);
		expect(t.c.requests.at(-1)).toEqual(['reopen', 7, 100, 30]);
		expect(t.state().creating).toBe(true);
		t.c.emit.replay(replay(9));
		expect(t.state().creating).toBe(false);
		expect(t.state().selected).toBe(9);
		expect(t.row(9)?.info).toMatchObject({ cwd: '/tmp/repo', cmd: 'claude', name: 'w' });
		expect(t.row(9)?.view).toBeDefined();
		t.c.emit.sessions([info(1), info(9)]);
		expect(t.row(7)).toBeUndefined();
		expect(t.row(9)).toBeDefined();
		t.m.stop();
	});

	it('does not reopen a row that is not restorable, or without a connection', async () => {
		const t = await connected([info(1), record(7)]);
		const before = t.c.requests.length;
		t.m.reopen(1);
		t.m.reopen(99);
		expect(t.c.requests).toHaveLength(before);
		expect(t.state().creating).toBe(false);
		t.c.emit.closed({ kind: 'closed', detail: 'x' });
		t.m.reopen(7);
		expect(t.state().creating).toBe(false);
		t.m.stop();
	});

	it('frees the slot when the reopen fails, with a message per code', async () => {
		const t = await connected([record(7)]);
		const fail = (code: string, pids?: number[]) => {
			t.m.reopen(7);
			expect(t.state().creating).toBe(true);
			t.c.emit.error({ t: 'error', code, sid: 7, ...(pids ? { pids } : {}) });
			expect(t.state().creating).toBe(false);
			return t.state().message;
		};
		expect(fail('orphans', [11, 12])).toBe('session "w" left processes behind: 11, 12');
		expect(fail('bad-request')).toBe('reopen of session "w" failed (bad-request)');
		expect(fail('conversation-live')).toBe('session "w": its conversation is already open in another session');
		t.m.stop();
	});

	it('sends a dismiss', async () => {
		const t = await connected([record(7)]);
		t.m.dismiss(7);
		expect(t.c.dismisses).toEqual([7]);
		t.m.stop();
	});

	it('shows a bad-path message without touching a create in flight', async () => {
		const t = await connected([]);
		t.m.create('/tmp/repo', '', '');
		t.c.emit.error({ t: 'error', code: 'bad-path' });
		expect(t.state().message).toBe('repo path must be an absolute path to an existing folder');
		expect(t.state().creating).toBe(true);
		t.c.emit.replay(replay(3));
		expect(t.state().creating).toBe(false);
		expect(t.state().selected).toBe(3);
		t.m.stop();
	});

	it('takes a sid-less bad-request as a failed create while no reopen is outstanding', async () => {
		const t = await connected([record(7)]);
		t.m.create('/tmp/repo', '', '');
		t.c.emit.error({ t: 'error', code: 'bad-request' });
		expect(t.state().message).toBe('create failed (bad-request)');
		expect(t.state().creating).toBe(false);
		t.m.stop();
	});
});

describe('SessionManager daemon update', () => {
	type Options = NonNullable<Parameters<typeof setup>[3]>;

	// Started as the app of build 0.2.0, with the first connection past its
	// handshake with a daemon of build daemon.
	async function app(list: SessionInfo[], daemon: string | undefined, options: Options = {}) {
		const t = setup(undefined, undefined, undefined, { appBuild: async () => '0.2.0', ...options });
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.ready(list, daemon);
		await vi.advanceTimersByTimeAsync(0);
		return t;
	}

	// The daemon agreeing to the shutdown: it closes every connection.
	const agree = (c: FakeConnection) => c.emit.closed({ kind: 'closed', detail: 'code 1001: daemon stopping' });

	it('leaves the daemon alone in a dev run', async () => {
		const t = setup();
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.ready([], '0.1.0');
		await vi.advanceTimersByTimeAsync(0);
		expect(t.check).not.toHaveBeenCalled();
		expect(t.conns[0].shutdowns).toEqual([]);
		expect(t.state().update).toBeUndefined();
		t.m.stop();
	});

	it('leaves a daemon of its own build alone', async () => {
		const t = await app([], '0.2.0');
		expect(t.conns[0].shutdowns).toEqual([]);
		expect(t.state().status).toBe('connected');
		expect(t.state().update).toBeUndefined();
		t.m.stop();
	});

	it('asks an outdated daemon to stop if idle when no session runs, then starts its own, once', async () => {
		let release!: () => void;
		const t = await app([info(1, 'i', 'exited'), record(7)], '0.1.0', {
			restartDaemon: () => new Promise<void>((r) => (release = r)),
		});
		expect(t.check).toHaveBeenCalledTimes(1);
		expect(t.conns[0].shutdowns).toEqual([true]);
		expect(t.state().status).toBe('restarting');
		// The daemon is only waited for once it has agreed.
		expect(t.restart).not.toHaveBeenCalled();
		agree(t.conns[0]);
		expect(t.restart).toHaveBeenCalledWith(ep, false);
		// Nothing reconnects while the new daemon starts.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(t.conns).toHaveLength(1);
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(t.conns).toHaveLength(2);
		t.conns[1].emit.ready([record(7)], '0.2.0');
		expect(t.state()).toMatchObject({ status: 'connected' });
		expect(t.state().update).toBeUndefined();
		await reconnect({ ...t, c: t.conns[1] }, [], '0.2.0');
		expect(t.check).toHaveBeenCalledTimes(1);
		expect(t.restart).toHaveBeenCalledTimes(1);
		t.m.stop();
	});

	it('offers the restart when the daemon refuses an idle shutdown, and never asks by itself again', async () => {
		const t = await app([], '0.1.0');
		expect(t.conns[0].shutdowns).toEqual([true]);
		// A session was created meanwhile.
		t.conns[0].emit.sessions([info(3)]);
		t.conns[0].emit.error({ t: 'error', code: 'busy' });
		expect(t.state()).toMatchObject({ status: 'connected', update: { daemon: '0.1.0', app: '0.2.0' } });
		expect(t.state().update?.note).toBeUndefined();
		expect(t.state().message).toBeUndefined();
		expect(t.restart).not.toHaveBeenCalled();
		const c = await reconnect({ ...t, c: t.conns[0] }, [], '0.1.0');
		expect(c.shutdowns).toEqual([]);
		expect(t.state().update).toMatchObject({ daemon: '0.1.0' });
		t.m.stop();
	});

	it('offers the restart while sessions run, and asks for a shutdown on request', async () => {
		const t = await app([info(1), info(2, 'i', 'exited')], '0.1.0');
		expect(t.check).not.toHaveBeenCalled();
		expect(t.state()).toMatchObject({ status: 'connected', update: { daemon: '0.1.0', app: '0.2.0' } });
		t.m.restartDaemon();
		await vi.advanceTimersByTimeAsync(0);
		expect(t.conns[0].shutdowns).toEqual([false]);
		expect(t.state().status).toBe('restarting');
		expect(t.state().update).toBeUndefined();
		agree(t.conns[0]);
		await vi.advanceTimersByTimeAsync(0);
		expect(t.restart).toHaveBeenCalledWith(ep, false);
		t.conns[1].emit.ready([], '0.2.0');
		expect(t.state().status).toBe('connected');
		expect(t.state().update).toBeUndefined();
		t.m.stop();
	});

	it('never restarts a daemon without a build by itself, and signals it on request', async () => {
		const t = await app([], undefined);
		expect(t.check).not.toHaveBeenCalled();
		expect(t.state().update).toEqual({ app: '0.2.0' });
		t.m.restartDaemon();
		await vi.advanceTimersByTimeAsync(0);
		// It knows no shutdown request.
		expect(t.conns[0].shutdowns).toEqual([]);
		expect(t.conns[0].closed).toBe(true);
		expect(t.restart).toHaveBeenCalledWith(ep, true);
		t.m.stop();
	});

	it('gives up on a shutdown request that gets neither an answer nor a close', async () => {
		const t = await app([], '0.1.0');
		expect(t.conns[0].shutdowns).toEqual([true]);
		await vi.advanceTimersByTimeAsync(4999);
		expect(t.state().status).toBe('restarting');
		await vi.advanceTimersByTimeAsync(1);
		expect(t.state()).toMatchObject({
			status: 'connected',
			update: { daemon: '0.1.0', note: 'restart failed: no answer to the shutdown request' },
		});
		// The connection stays; nothing is signalled, and nothing is tried again.
		expect(t.conns[0].closed).toBe(false);
		expect(t.restart).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(t.conns).toHaveLength(1);
		expect(t.conns[0].shutdowns).toEqual([true]);
		// The button asks again.
		t.m.restartDaemon();
		await vi.advanceTimersByTimeAsync(0);
		expect(t.conns[0].shutdowns).toEqual([true, false]);
		t.m.stop();
	});

	it('stops the shutdown timer on an answer or a close', async () => {
		const busy = await app([], '0.1.0');
		busy.conns[0].emit.error({ t: 'error', code: 'busy' });
		expect(vi.getTimerCount()).toBe(0);
		busy.m.stop();
		const agreed = await app([], '0.1.0', { restartDaemon: () => new Promise<void>(() => {}) });
		agree(agreed.conns[0]);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(agreed.state().status).toBe('restarting');
		agreed.m.stop();
	});

	it('stops nothing when the app could not start its own daemon', async () => {
		const t = await app([], '0.1.0', {
			checkRestart: async () => {
				throw new Error('vaquita is running from a temporary location');
			},
		});
		expect(t.conns[0].shutdowns).toEqual([]);
		expect(t.conns[0].closed).toBe(false);
		expect(t.restart).not.toHaveBeenCalled();
		expect(t.state()).toMatchObject({
			status: 'connected',
			update: { daemon: '0.1.0', note: 'restart failed: vaquita is running from a temporary location' },
		});
		t.m.stop();
	});

	it('offers with a note when the restart left the same build', async () => {
		const t = await app([], '0.1.0');
		agree(t.conns[0]);
		await vi.advanceTimersByTimeAsync(0);
		t.conns[1].emit.ready([], '0.1.0');
		await vi.advanceTimersByTimeAsync(0);
		expect(t.conns[1].shutdowns).toEqual([]);
		expect(t.state().update).toEqual({ daemon: '0.1.0', app: '0.2.0', note: 'still running after a restart' });
		t.m.stop();
	});

	it('shows why starting its own daemon failed, and offers the restart again', async () => {
		const t = await app([], '0.1.0', {
			restartDaemon: async () => {
				throw new Error('vaquitad (pid 9) did not stop');
			},
		});
		agree(t.conns[0]);
		await vi.advanceTimersByTimeAsync(0);
		expect(t.state()).toMatchObject({ status: 'disconnected', message: 'daemon restart failed: vaquitad (pid 9) did not stop' });
		await vi.advanceTimersByTimeAsync(1000);
		t.conns[1].emit.ready([], '0.1.0');
		await vi.advanceTimersByTimeAsync(0);
		expect(t.conns[1].shutdowns).toEqual([]);
		expect(t.state().update).toEqual({ daemon: '0.1.0', app: '0.2.0', note: 'restart failed: vaquitad (pid 9) did not stop' });
		t.m.restartDaemon();
		await vi.advanceTimersByTimeAsync(0);
		expect(t.conns[1].shutdowns).toEqual([false]);
		t.m.stop();
	});

	it('asks for the app build once', async () => {
		const appBuild = vi.fn(async () => '0.2.0');
		const t = setup(undefined, undefined, undefined, { appBuild });
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.ready([info(1)], '0.2.0');
		await reconnect({ ...t, c: t.conns[0] }, [info(1)], '0.2.0');
		expect(appBuild).toHaveBeenCalledTimes(1);
		t.m.stop();
	});
});
