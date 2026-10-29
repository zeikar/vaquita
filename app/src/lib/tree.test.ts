import { describe, expect, it } from 'vitest';
import { joinPath, visibleExpanded } from './tree';

describe('joinPath', () => {
	it('adds one slash', () => {
		expect(joinPath('/tmp/repo', 'a.ts')).toBe('/tmp/repo/a.ts');
		expect(joinPath('/tmp/repo/', 'a.ts')).toBe('/tmp/repo/a.ts');
		expect(joinPath('/', 'tmp')).toBe('/tmp');
	});
});

describe('visibleExpanded', () => {
	const root = '/tmp/repo';

	it('starts with the root even when nothing is expanded', () => {
		expect(visibleExpanded(root, new Set())).toEqual([root]);
	});

	it('keeps a nested folder only while its parent is expanded', () => {
		const lib = '/tmp/repo/src/lib';
		expect(visibleExpanded(root, new Set([lib]))).toEqual([root]);
		expect(visibleExpanded(root, new Set([lib, '/tmp/repo/src']))).toEqual([root, '/tmp/repo/src', lib]);
	});

	it('ignores an expanded path outside the root', () => {
		expect(visibleExpanded(root, new Set(['/tmp/other', '/tmp/repository', root]))).toEqual([root]);
	});

	it('works for a root of /', () => {
		expect(visibleExpanded('/', new Set(['/tmp']))).toEqual(['/', '/tmp']);
	});
});
