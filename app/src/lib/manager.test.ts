import { describe, expect, it, vi } from 'vitest';
import { NotRunningError, type Endpoint } from './endpoint';
import { connected, ep, fakeTimersAndStorage, info, setup } from './manager-harness';

fakeTimersAndStorage();

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

	describe('reports', () => {
		it('go after 8s, or a minute for a failure', async () => {
			const t = await connected([]);
			t.m.report('revealed', 'info');
			expect(t.state().report).toEqual({ text: 'revealed', tone: 'info' });
			await vi.advanceTimersByTimeAsync(7999);
			expect(t.state().report).toBeDefined();
			await vi.advanceTimersByTimeAsync(1);
			expect(t.state().report).toBeUndefined();
			t.m.report('open failed');
			await vi.advanceTimersByTimeAsync(59_999);
			expect(t.state().report).toEqual({ text: 'open failed', tone: 'error' });
			await vi.advanceTimersByTimeAsync(1);
			expect(t.state().report).toBeUndefined();
			t.m.stop();
		});

		it('replace an earlier one and its time, and go when clicked', async () => {
			const t = await connected([]);
			t.m.report('first', 'info');
			await vi.advanceTimersByTimeAsync(5000);
			t.m.report('second');
			await vi.advanceTimersByTimeAsync(5000);
			expect(t.state().report?.text).toBe('second');
			t.m.dismissReport();
			expect(t.state().report).toBeUndefined();
			t.m.stop();
		});

		it('leave the status message alone', async () => {
			const t = setup();
			t.m.start();
			await vi.advanceTimersByTimeAsync(0);
			t.conns[0].emit.closed({ kind: 'closed', detail: 'code 1006' });
			t.m.report('open failed');
			t.m.dismissReport();
			expect(t.state()).toMatchObject({ status: 'disconnected', message: 'code 1006' });
			t.m.stop();
		});
	});
});
