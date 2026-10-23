import { describe, expect, it } from 'vitest';
import { groupRows, repoName, repoOf } from './groups';

describe('repoOf', () => {
	it('does not treat a sibling with a longer name as inside the repo', () => {
		expect(repoOf('/tmp/repo-feature', ['/tmp/repo'])).toBeUndefined();
	});

	it('picks the repo with the most components', () => {
		const repos = ['/tmp/repo', '/tmp/repo/a'];
		expect(repoOf('/tmp/repo/a/b', repos)).toBe('/tmp/repo/a');
		expect(repoOf('/tmp/repo/c', repos)).toBe('/tmp/repo');
		expect(repoOf('/tmp/repo/a/b', [...repos].reverse())).toBe('/tmp/repo/a');
	});

	it('ignores trailing slashes and matches the repo itself', () => {
		expect(repoOf('/tmp/repo/', ['/tmp/repo'])).toBe('/tmp/repo');
		expect(repoOf('/tmp/repo', ['/tmp/repo'])).toBe('/tmp/repo');
		expect(repoOf('/tmp/repo', ['/tmp/repo/'])).toBe('/tmp/repo/');
	});

	it('matches nothing for an empty cwd and compares case-sensitively', () => {
		expect(repoOf('', ['/tmp/repo'])).toBeUndefined();
		expect(repoOf('/tmp/Repo', ['/tmp/repo'])).toBeUndefined();
	});

	it('lets / be the repo of everything under it, and a longer repo win', () => {
		expect(repoOf('/tmp/x', ['/'])).toBe('/');
		expect(repoOf('/tmp/x', ['/', '/tmp'])).toBe('/tmp');
		expect(repoOf('', ['/'])).toBeUndefined();
	});
});

describe('groupRows', () => {
	const row = (cwd: string) => ({ info: { cwd } });

	it('keeps repo order, lists an empty repo and puts other last', () => {
		const a = row('/tmp/b/x');
		const b = row('/tmp/elsewhere');
		const c = row('/tmp/b');
		const groups = groupRows([a, b, c], ['/tmp/b', '/tmp/a']);
		expect(groups).toEqual([
			{ repo: '/tmp/b', rows: [a, c] },
			{ repo: '/tmp/a', rows: [] },
			{ rows: [b] },
		]);
	});

	it('omits an empty other', () => {
		expect(groupRows([row('/tmp/a')], ['/tmp/a'])).toEqual([{ repo: '/tmp/a', rows: [row('/tmp/a')] }]);
		expect(groupRows([], [])).toEqual([]);
	});
});

describe('repoName', () => {
	it('is the last component, or the path when there is none', () => {
		expect(repoName('/tmp/repo')).toBe('repo');
		expect(repoName('/tmp/repo/')).toBe('repo');
		expect(repoName('/')).toBe('/');
	});
});
