import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionHandlers } from './connection';
import { NotRunningError, type Endpoint } from './endpoint';
import { SessionManager, type ConnectionLike, type ManagerState } from './manager';
import { FRAME_LIVE, FRAME_REPLAY, type Live, type Replay, type SessionInfo } from './protocol';
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
const info = (sid: number, inc = 'i', state = 'running'): SessionInfo => ({
	sid, inc, cwd: '/tmp/repo', cmd: 'sh', name: '', cols: 80, rows: 24, state, pid: 2, code: 0,
});
const replay = (sid: number, gen = 1): Replay => ({ t: 'replay', sid, gen, from: 0, to: 0, cols: 80, rows: 24 });
const live = (sid: number, ro = false): Live => ({ t: 'live', sid, gen: 1, off: 0, ro });
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
) {
	const conns: FakeConnection[] = [];
	const read = vi.fn(readEndpoint);
	const start = vi.fn(startDaemon);
	const m = new SessionManager({
		readEndpoint: read,
		startDaemon: start,
		connect: (endpoint, handlers) => {
			connectHook();
			const c = new FakeConnection(endpoint, handlers);
			conns.push(c);
			return c;
		},
		createTerminal: (cols, rows) => new Terminal({ cols, rows, allowProposedApi: true }),
		createView: (term, core) => new FakeView(term, core),
	});
	let state!: ManagerState<FakeView>;
	let emits = 0;
	m.subscribe((s) => {
		state = s;
		emits++;
	});
	const row = (sid: number) => state.sessions.find((r) => r.info.sid === sid);
	return { m, conns, read, start, state: () => state, row, emits: () => emits };
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
async function reconnect(t: Awaited<ReturnType<typeof connected>>, list: SessionInfo[]) {
	t.conns.at(-1)!.emit.closed({ kind: 'closed', detail: 'code 1006' });
	await vi.advanceTimersByTimeAsync(1000);
	const c = t.conns.at(-1)!;
	c.emit.ready(list);
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
		expect(t.state().message).toBe('subscribe 2 failed (bad-request)');
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
		expect(t.state().message).toBe('session 1 left processes behind: 9');
		t.m.stop();
	});
});
