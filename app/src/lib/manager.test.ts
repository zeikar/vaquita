import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionHandlers } from './connection';
import { NotRunningError, type Endpoint } from './endpoint';
import { SessionManager, type ManagerState } from './manager';
import type { SessionInfo } from './protocol';

class FakeConnection {
	closed = false;
	constructor(
		readonly endpoint: Endpoint,
		readonly emit: ConnectionHandlers,
	) {}
	close(): void {
		this.closed = true;
	}
}

const ep: Endpoint = { url: 'ws://127.0.0.1:1/ws', token: 't', pid: 1 };
const info = (sid: number): SessionInfo => ({
	sid, inc: 'i', cwd: '/tmp/repo', cmd: 'sh', name: '', cols: 80, rows: 24, state: 'running', pid: 2, code: 0,
});

function setup(readEndpoint: () => Promise<Endpoint> = async () => ep, connectHook: () => void = () => {}) {
	const conns: FakeConnection[] = [];
	const read = vi.fn(readEndpoint);
	const m = new SessionManager({
		readEndpoint: read,
		connect: (endpoint, handlers) => {
			connectHook();
			const c = new FakeConnection(endpoint, handlers);
			conns.push(c);
			return c;
		},
		createTerminal: () => {
			throw new Error('unused');
		},
	});
	let state!: ManagerState;
	m.subscribe((s) => (state = s));
	return { m, conns, read, state: () => state };
}

describe('SessionManager', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('is connected with the list after ready', async () => {
		const t = setup();
		expect(t.state().status).toBe('connecting');
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.conns[0].emit.ready([info(1)]);
		expect(t.state().status).toBe('connected');
		expect(t.state().sessions).toEqual([info(1)]);
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
		expect(t.state().message).toBeUndefined();
		running = true;
		await vi.advanceTimersByTimeAsync(1000);
		expect(t.conns).toHaveLength(1);
		t.conns[0].emit.ready([]);
		expect(t.state().status).toBe('connected');
		t.m.stop();
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
