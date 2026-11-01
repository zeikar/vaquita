import { describe, expect, it } from 'vitest';
import type { SessionInfo } from './protocol';
import { changesText, newRepos, repoSessions, sessionsText } from './welcome';

describe('changesText', () => {
	it('says nothing before a count', () => {
		expect(changesText(undefined)).toBeUndefined();
	});
	it('counts the changed files', () => {
		expect(changesText(0)).toBe('no changes');
		expect(changesText(1)).toBe('1 changed file');
		expect(changesText(3)).toBe('3 changed files');
	});
});

describe('sessionsText', () => {
	it('counts the sessions', () => {
		expect(sessionsText(0)).toBe('no sessions');
		expect(sessionsText(1)).toBe('1 session');
		expect(sessionsText(2)).toBe('2 sessions');
	});
});

describe('repoSessions', () => {
	const s = (cwd: string, state = 'running') => ({ cwd, state }) as SessionInfo;
	const repos = ['/tmp/repo', '/tmp/repo/sub', '/tmp/other'];
	it('counts the running sessions whose repo is this one', () => {
		const sessions = [
			s('/tmp/repo'),
			s('/tmp/repo/src'),
			s('/tmp/repo', 'exited'),
			s('/tmp/repo/sub'),
			s('/tmp/repo-feature'),
			s('/tmp/other'),
			s(''),
		];
		expect(repoSessions(sessions, repos, '/tmp/repo')).toBe(2);
		expect(repoSessions(sessions, repos, '/tmp/repo/sub')).toBe(1);
		expect(repoSessions([], repos, '/tmp/repo')).toBe(0);
	});
});

describe('newRepos', () => {
	it('gives the entries of next not in prev, in next order', () => {
		expect(newRepos(['/tmp/a'], ['/tmp/c', '/tmp/a', '/tmp/b'])).toEqual(['/tmp/c', '/tmp/b']);
		expect(newRepos([], ['/tmp/a'])).toEqual(['/tmp/a']);
		expect(newRepos(['/tmp/a', '/tmp/b'], ['/tmp/a'])).toEqual([]);
	});
});
