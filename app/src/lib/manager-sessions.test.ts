import { describe, expect, it, vi } from 'vitest';
import { answer, connected, fakeTimersAndStorage, info, live, reconnect, replay, setup } from './manager-harness';
import { FRAME_LIVE } from './protocol';

const encoder = new TextEncoder();

fakeTimersAndStorage();

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

	it('resolves create with whether the session came to be', async () => {
		const t = await connected([]);
		const ok = t.m.create('/tmp/repo', '', '');
		t.c.emit.replay(replay(4));
		expect(await ok).toBe(true);

		const failed = t.m.create('/nope', '', '');
		t.c.emit.error({ t: 'error', code: 'bad-request' });
		expect(await failed).toBe(false);

		const lost = t.m.create('/tmp/repo', '', '');
		t.c.emit.closed({ kind: 'closed', detail: 'code 1006' });
		expect(await lost).toBe(false);
		t.m.stop();
	});

	it('resolves create false for a failure even when another session was selected meanwhile', async () => {
		const t = await connected([info(1), info(2)]);
		answer(t.c, 1);
		answer(t.c, 2);
		const failed = t.m.create('/nope', '', '');
		t.m.select(1);
		t.c.emit.error({ t: 'error', code: 'bad-request' });
		expect(await failed).toBe(false);
		t.m.stop();
	});

	it('resolves create false when it is refused, and when it waits behind a subscribe and the connection is lost', async () => {
		const t = await connected([info(1)]);
		const first = t.m.create('/tmp/repo', '', '');
		expect(await t.m.create('/tmp/other', '', '')).toBe(false);
		t.c.emit.closed({ kind: 'closed', detail: 'code 1006' });
		expect(await first).toBe(false);
		// Not connected now.
		expect(await t.m.create('/tmp/repo', '', '')).toBe(false);
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

	it('sends a rename only with a ready connection', async () => {
		const t = setup();
		t.m.rename(1, 'x');
		t.m.start();
		await vi.advanceTimersByTimeAsync(0);
		t.m.rename(1, 'x');
		t.conns[0].emit.ready([info(1)]);
		expect(t.conns[0].renames).toEqual([]);
		t.m.rename(1, 'fix login');
		t.m.rename(1, '');
		expect(t.conns[0].renames).toEqual([[1, 'fix login'], [1, '']]);
		t.m.stop();
	});
});
