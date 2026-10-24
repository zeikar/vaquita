import { describe, expect, it, vi } from 'vitest';
import { ep, fakeTimersAndStorage, info, reconnect, record, setup, type FakeConnection } from './manager-harness';
import type { SessionInfo } from './protocol';

fakeTimersAndStorage();

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
