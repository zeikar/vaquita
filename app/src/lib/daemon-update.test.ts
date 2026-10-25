import { describe, expect, it } from 'vitest';
import { DEV_BUILD, runningCount, shownBuild, updateAction } from './daemon-update';
import type { SessionInfo } from './protocol';

const info = (sid: number, state: string, restorable?: boolean): SessionInfo => ({
	sid, inc: 'i', cwd: '/tmp/repo', cmd: 'sh', name: '', cols: 80, rows: 24, state, pid: 2, code: 0,
	...(restorable ? { restorable } : {}),
});

describe('updateAction', () => {
	it.each([
		// app, daemon, running, auto tried, action
		['0.2.0', '0.2.0', 0, false, 'none'],
		['0.2.0', '0.2.0', 3, true, 'none'],
		// A dev run never manages the daemon.
		[null, '0.1.0', 0, false, 'none'],
		[null, undefined, 0, false, 'none'],
		// A developer's daemon is left alone.
		['0.2.0', DEV_BUILD, 0, false, 'none'],
		// A daemon older than builds sends none, and is restarted only on a click.
		['0.2.0', undefined, 0, false, 'offer'],
		['0.2.0', '0.1.0', 0, false, 'restart-now'],
		// A newer one is not the app's either.
		['0.2.0', '0.3.0', 0, false, 'restart-now'],
		['0.2.0', '0.1.0', 1, false, 'offer'],
		['0.2.0', '0.1.0', 0, true, 'offer'],
		['0.2.0', undefined, 2, true, 'offer'],
		// Releases are compared by the daemon code their builds name.
		['0.2.1+3b9cdd54fa29', '0.2.0+3b9cdd54fa29', 0, false, 'none'],
		['0.2.1+3b9cdd54fa29', '0.2.0+3b9cdd54fa29', 2, false, 'none'],
		['0.2.1+e9b8d6406e0f', '0.2.0+3b9cdd54fa29', 0, false, 'restart-now'],
		['0.2.1+e9b8d6406e0f', '0.2.0+3b9cdd54fa29', 2, false, 'offer'],
		// One from before fingerprints is not the app's.
		['0.2.1+3b9cdd54fa29', '0.2.0', 0, false, 'restart-now'],
		// A local build ships a dev daemon, which replaces none.
		[DEV_BUILD, '0.2.0+3b9cdd54fa29', 0, false, 'none'],
	] as const)('app %s, daemon %s, %i running, tried %s: %s', (app, daemon, running, tried, want) => {
		expect(updateAction(app, daemon, running, tried)).toBe(want);
	});
});

describe('shownBuild', () => {
	it('drops the fingerprint', () => {
		expect(shownBuild('0.2.0+3b9cdd54fa29')).toBe('0.2.0');
		expect(shownBuild('0.2.0')).toBe('0.2.0');
	});
});

describe('runningCount', () => {
	it('counts running sessions only', () => {
		expect(runningCount([])).toBe(0);
		expect(runningCount([info(1, 'running'), info(2, 'exited'), info(3, 'exited', true), info(4, 'running')])).toBe(2);
	});
});
