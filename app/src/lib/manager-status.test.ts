import { describe, expect, it, vi } from 'vitest';
import { connected, fakeTimersAndStorage, info, reconnect, setup } from './manager-harness';
import type { SessionInfo, Status, StatusInfo } from './protocol';

const status = (sid: number, s: StatusInfo | null, unread = false): Status => ({ t: 'status', sid, status: s, unread });

fakeTimersAndStorage();

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
});
