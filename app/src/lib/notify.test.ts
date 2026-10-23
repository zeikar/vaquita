import { describe, expect, it } from 'vitest';
import { isTarget, notificationFor, shouldShow } from './notify';
import type { Notify, SessionInfo } from './protocol';

const info = (name: string, cmd: string, title?: string): SessionInfo => ({
	sid: 3, inc: 'a', cwd: '/tmp/repo', cmd, name, title, cols: 80, rows: 24, state: 'running', pid: 2, code: 0,
});

describe('notificationFor', () => {
	it.each([
		['done', 'build done'],
		['error', 'build failed'],
		['input', 'build needs input'],
		['auth', 'build needs login'],
	] as const)('titles a %s after the row and targets its sid and inc', (kind, title) => {
		expect(notificationFor(info('build', 'make'), { t: 'notify', sid: 3, kind, msg: 'the msg' })).toEqual({
			title, body: 'the msg', target: { sid: 3, inc: 'a' },
		});
	});

	it("names a row by its name, else its agent's title, else its cmd, else shell", () => {
		const m: Notify = { t: 'notify', sid: 3, kind: 'done' };
		expect(notificationFor(info('build', 'claude', 'Fix tests'), m).title).toBe('build done');
		expect(notificationFor(info('', 'claude', 'Fix tests'), m).title).toBe('Fix tests done');
		expect(notificationFor(info('', 'make'), m).title).toBe('make done');
		expect(notificationFor(info('', ''), m).title).toBe('shell done');
		expect(notificationFor(info('', ''), m).body).toBe('');
	});

	it('summarizes the missed notifications without a target', () => {
		expect(notificationFor(undefined, { t: 'notify', kind: 'missed', count: 2 })).toEqual({
			title: 'vaquita', body: '2 notifications while you were away',
		});
		expect(notificationFor(undefined, { t: 'notify', kind: 'missed', count: 1 }).body).toBe(
			'1 notification while you were away',
		);
	});
});

describe('isTarget', () => {
	it('accepts a sid and an inc', () => {
		expect(isTarget({ sid: 3, inc: 'a' })).toBe(true);
	});

	it.each([undefined, null, 'x', {}, { sid: 3 }, { inc: 'a' }, { sid: '3', inc: 'a' }])('rejects %j', (v) => {
		expect(isTarget(v)).toBe(false);
	});
});

describe('shouldShow', () => {
	const m: Notify = { t: 'notify', sid: 3, kind: 'done' };

	it('hides only a notification about the selected session while the window is focused', () => {
		expect(shouldShow(m, 3, true)).toBe(false);
		expect(shouldShow(m, 3, false)).toBe(true);
		expect(shouldShow(m, 4, true)).toBe(true);
		expect(shouldShow(m, undefined, true)).toBe(true);
	});

	it('always shows the missed summary, even with nothing selected', () => {
		const missed: Notify = { t: 'notify', kind: 'missed', count: 2 };
		expect(shouldShow(missed, undefined, true)).toBe(true);
		expect(shouldShow(missed, 3, true)).toBe(true);
	});
});
