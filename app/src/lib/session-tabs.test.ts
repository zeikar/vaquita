import { describe, expect, it } from 'vitest';
import type { SessionInfo } from './protocol';
import { WELCOME } from './tabs';
import { arrangeGroup, isSessionTab, needsAsk, placement, reconcile, sessionTab, tabSid } from './session-tabs';

describe('session tab keys', () => {
	it('round-trips a sid', () => {
		expect(sessionTab(7)).toBe('session:7');
		expect(tabSid('session:7')).toBe(7);
		expect(isSessionTab('session:7')).toBe(true);
	});
	it('gives nothing for files, diffs and the welcome', () => {
		for (const key of ['/tmp/repo/a.ts', 'diff:/tmp/repo/a.ts', WELCOME, 'session:', 'session:x']) {
			expect(tabSid(key)).toBeUndefined();
			expect(isSessionTab(key)).toBe(false);
		}
	});
});

describe('placement', () => {
	const s = (sid: number, cwd: string, restorable?: boolean) => ({ sid, cwd, restorable }) as SessionInfo;
	it('maps live sessions to their group and skips restorable records', () => {
		const placed = placement([s(1, '/tmp/repo/src'), s(2, '/tmp/else'), s(3, '/tmp/repo', true)], ['/tmp/repo']);
		expect([...placed]).toEqual([
			[1, '/tmp/repo'],
			[2, 'other'],
		]);
	});
});

describe('arrangeGroup', () => {
	it('keeps file keys and order, and drops a session that is not here', () => {
		expect(arrangeGroup(['/a', 'session:2', '/b', 'session:3'], [3])).toEqual(['/a', '/b', 'session:3']);
	});
	it('appends new sessions by number', () => {
		expect(arrangeGroup(['session:5', '/a'], [9, 5, 6])).toEqual(['session:5', '/a', 'session:6', 'session:9']);
	});
	it('returns the same array when nothing changes', () => {
		const order = ['/a', 'session:1'];
		expect(arrangeGroup(order, [1])).toBe(order);
	});
});

describe('reconcile', () => {
	it('moves a session key to the group it is in now, appended', () => {
		const groups = { '/tmp/a': ['session:1', '/tmp/a/x.ts'], '/tmp/b': ['/tmp/b/y.ts'] };
		expect(reconcile(groups, new Map([[1, '/tmp/b']]))).toEqual({ '/tmp/b': ['/tmp/b/y.ts', 'session:1'], '/tmp/a': ['/tmp/a/x.ts'] });
	});
	it('creates a group for a new session and drops one left empty', () => {
		expect(reconcile({ '/tmp/a': ['session:1'] }, new Map([[2, '/tmp/b']]))).toEqual({ '/tmp/b': ['session:2'] });
	});
	it('ignores restorable rows', () => {
		const placed = placement([{ sid: 4, cwd: '/tmp/a', restorable: true } as SessionInfo], ['/tmp/a']);
		expect(reconcile({}, placed)).toEqual({});
	});
	it('returns the same object when nothing changes', () => {
		const groups = { '/tmp/a': ['/tmp/a/x.ts', 'session:1'] };
		expect(reconcile(groups, new Map([[1, '/tmp/a']]))).toBe(groups);
	});
});

describe('needsAsk', () => {
	const s = (state: string, status?: string) => ({ state, status: status ? { state: status } : undefined }) as SessionInfo;
	it('is true for a running session that is working or waiting for input', () => {
		expect(needsAsk(s('running', 'working'))).toBe(true);
		expect(needsAsk(s('running', 'input'))).toBe(true);
	});
	it('is false otherwise', () => {
		expect(needsAsk(s('running'))).toBe(false);
		expect(needsAsk(s('running', 'done'))).toBe(false);
		expect(needsAsk(s('running', 'auth'))).toBe(false);
		expect(needsAsk(s('exited', 'working'))).toBe(false);
	});
});
