import { describe, expect, it, vi } from 'vitest';
import { answer, connected, fakeTimersAndStorage, info, reconnect, record, replay, setup } from './manager-harness';

fakeTimersAndStorage();

describe('SessionManager repos and records', () => {
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

	it('tells a repo list the daemon sent from the empty one it starts with', async () => {
		const t = await connected([]);
		expect(t.state().reposListed).toBe(false);
		t.c.emit.repos([]);
		expect(t.state().reposListed).toBe(true);
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
			return t.state().report?.text;
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
		expect(t.state().report?.text).toBe('repo path must be an absolute path to an existing folder');
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
		expect(t.state().report?.text).toBe('create failed (bad-request)');
		expect(t.state().creating).toBe(false);
		t.m.stop();
	});
});
