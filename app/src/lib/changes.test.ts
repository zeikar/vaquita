import { describe, expect, it } from 'vitest';
import { diffPath, diffTab, endedTurns, tabFile } from './changes';
import type { SessionInfo } from './protocol';

const session = (sid: number, cwd: string, state?: 'working' | 'done' | 'error'): SessionInfo =>
	({ sid, cwd, status: state && { state } }) as SessionInfo;
const inRepo = (cwd: string) => cwd.startsWith('/tmp/repo');

describe('diff tab keys', () => {
	it('round-trips a path', () => {
		expect(diffTab('/tmp/repo/a.ts')).toBe('diff:/tmp/repo/a.ts');
		expect(diffPath(diffTab('/tmp/repo/a.ts'))).toBe('/tmp/repo/a.ts');
		expect(tabFile(diffTab('/tmp/repo/a.ts'))).toBe('/tmp/repo/a.ts');
	});

	it('leaves a plain path alone', () => {
		expect(diffPath('/tmp/repo/a.ts')).toBeUndefined();
		expect(tabFile('/tmp/repo/a.ts')).toBe('/tmp/repo/a.ts');
	});
});

describe('endedTurns', () => {
	it('records a session first seen without firing', () => {
		const r = endedTurns(new Map(), [session(1, '/tmp/repo', 'done')], inRepo);
		expect(r.ended).toBe(false);
		expect(r.next.get(1)).toBe('done');
	});

	it('fires when working becomes done or error', () => {
		const prev = new Map([[1, 'working']]);
		expect(endedTurns(prev, [session(1, '/tmp/repo', 'done')], inRepo).ended).toBe(true);
		expect(endedTurns(prev, [session(1, '/tmp/repo', 'error')], inRepo).ended).toBe(true);
	});

	it('fires when input becomes done and when a working status is gone', () => {
		expect(endedTurns(new Map([[1, 'input']]), [session(1, '/tmp/repo', 'done')], inRepo).ended).toBe(true);
		expect(endedTurns(new Map([[1, 'working']]), [session(1, '/tmp/repo')], inRepo).ended).toBe(true);
	});

	it('does not fire when there was no status', () => {
		expect(endedTurns(new Map([[1, undefined]]), [session(1, '/tmp/repo', 'done')], inRepo).ended).toBe(false);
		expect(endedTurns(new Map([[1, undefined]]), [session(1, '/tmp/repo')], inRepo).ended).toBe(false);
	});

	it('does not fire when done stays done', () => {
		expect(endedTurns(new Map([[1, 'done']]), [session(1, '/tmp/repo', 'done')], inRepo).ended).toBe(false);
	});

	it('does not fire for a session outside the root', () => {
		expect(endedTurns(new Map([[1, 'working']]), [session(1, '/tmp/other', 'done')], inRepo).ended).toBe(false);
	});

	it('drops a sid gone from the list', () => {
		const r = endedTurns(new Map([[1, 'working'], [2, 'done']]), [session(2, '/tmp/repo', 'done')], inRepo);
		expect([...r.next.keys()]).toEqual([2]);
	});
});
