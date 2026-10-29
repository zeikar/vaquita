import { afterEach, describe, expect, it, vi } from 'vitest';
import { OTHER, closeTabs, fallback, fileName, groupKey, neighbour, openTab, parseStored, prune, touch } from './tabs';

afterEach(() => vi.restoreAllMocks());

describe('openTab / closeTabs', () => {
	it('appends, does not duplicate, and returns a new object', () => {
		const a = { '/tmp/repo': ['/tmp/repo/a.md'] };
		const b = openTab(a, '/tmp/repo', '/tmp/repo/b.md');
		expect(b).toEqual({ '/tmp/repo': ['/tmp/repo/a.md', '/tmp/repo/b.md'] });
		expect(a).toEqual({ '/tmp/repo': ['/tmp/repo/a.md'] });
		const c = openTab(b, '/tmp/repo', '/tmp/repo/a.md');
		expect(c).toEqual(b);
		expect(c).not.toBe(b);
	});

	it('creates a group on first open', () => {
		expect(openTab({}, OTHER, '/tmp/x.txt')).toEqual({ [OTHER]: ['/tmp/x.txt'] });
	});

	it('drops a group that closing emptied', () => {
		const g = { '/tmp/repo': ['/tmp/repo/a.md'], [OTHER]: ['/tmp/x.txt'] };
		expect(closeTabs(g, '/tmp/repo', ['/tmp/repo/a.md'])).toEqual({ [OTHER]: ['/tmp/x.txt'] });
		expect(g['/tmp/repo']).toEqual(['/tmp/repo/a.md']);
	});

	it('keeps the other tabs and ignores an unknown path or group', () => {
		const g = { '/tmp/repo': ['/a', '/b'] };
		expect(closeTabs(g, '/tmp/repo', ['/a'])).toEqual({ '/tmp/repo': ['/b'] });
		expect(closeTabs(g, '/tmp/repo', ['/zzz'])).toEqual(g);
		expect(closeTabs(g, '/tmp/none', ['/a'])).toEqual(g);
	});

	it('closes several at once, in the order the group has them', () => {
		const g = { '/tmp/repo': ['/a', '/b', '/c'] };
		expect(closeTabs(g, '/tmp/repo', ['/c', '/a'])).toEqual({ '/tmp/repo': ['/b'] });
		expect(closeTabs(g, '/tmp/repo', ['/a', '/b', '/c'])).toEqual({});
	});

	it('closes the known paths when an unknown one is among them', () => {
		const g = { '/tmp/repo': ['/a', '/b', '/c'] };
		expect(closeTabs(g, '/tmp/repo', ['/b', '/zzz'])).toEqual({ '/tmp/repo': ['/a', '/c'] });
	});
});

describe('neighbour', () => {
	const tabs = ['/a', '/b'];
	it('walks terminal, tabs, and wraps forward', () => {
		expect(neighbour(tabs, undefined, 1)).toBe('/a');
		expect(neighbour(tabs, '/a', 1)).toBe('/b');
		expect(neighbour(tabs, '/b', 1)).toBeUndefined();
	});
	it('wraps backward through the terminal', () => {
		expect(neighbour(tabs, '/a', -1)).toBeUndefined();
		expect(neighbour(tabs, undefined, -1)).toBe('/b');
		expect(neighbour(tabs, '/b', -1)).toBe('/a');
	});
	it('stays on the terminal with no tabs', () => {
		expect(neighbour([], undefined, 1)).toBeUndefined();
		expect(neighbour([], undefined, -1)).toBeUndefined();
	});
});

describe('touch / fallback', () => {
	it('puts a new path first and returns a new array', () => {
		const r = ['/a', undefined];
		expect(touch(r, '/b')).toEqual(['/b', '/a', undefined]);
		expect(r).toEqual(['/a', undefined]);
	});
	it('moves a known path or the terminal to the front without duplicating it', () => {
		expect(touch(['/a', '/b', undefined], '/b')).toEqual(['/b', '/a', undefined]);
		expect(touch(['/a', undefined, '/b'], undefined)).toEqual([undefined, '/a', '/b']);
		expect(touch([], undefined)).toEqual([undefined]);
	});
	it('skips a closed path and finds the terminal', () => {
		expect(fallback(['/gone', undefined, '/a'], ['/a'])).toBeUndefined();
	});
	it('finds the most recent open tab over an older one', () => {
		expect(fallback(['/gone', '/b', '/a', undefined], ['/a', '/b'])).toBe('/b');
	});
	it('gives the terminal for an empty list or one with only closed paths', () => {
		expect(fallback([], ['/a'])).toBeUndefined();
		expect(fallback(['/gone', '/also'], ['/a'])).toBeUndefined();
	});
});

describe('prune', () => {
	it('moves the tabs of an unregistered repo to other', () => {
		const g = { '/tmp/gone': ['/x', '/z'], '/tmp/repo': ['/y'], [OTHER]: ['/z'] };
		expect(prune(g, ['/tmp/repo'])).toEqual({ '/tmp/repo': ['/y'], [OTHER]: ['/z', '/x'] });
		expect(prune({ '/tmp/gone': ['/x'] }, [])).toEqual({ [OTHER]: ['/x'] });
	});

	it('moves the tabs to a registered parent repo when there is one', () => {
		const g = { '/tmp/repo/nested': ['/x'], '/tmp/repo': ['/y'] };
		expect(prune(g, ['/tmp/repo'])).toEqual({ '/tmp/repo': ['/y', '/x'] });
	});

	it('returns the same object when no repo went', () => {
		const g = { '/tmp/repo': ['/y'] };
		expect(prune(g, ['/tmp/repo'])).toBe(g);
	});
});

describe('parseStored', () => {
	it('reads an object of string arrays', () => {
		expect(parseStored('{"/tmp/repo":["/a","/b"]}')).toEqual({ '/tmp/repo': ['/a', '/b'] });
	});
	it('gives {} for null without warning', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(parseStored(null)).toEqual({});
		expect(warn).not.toHaveBeenCalled();
	});
	it('warns and gives {} for bad JSON, an array, or a scalar', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(parseStored('{nope')).toEqual({});
		expect(parseStored('["/a"]')).toEqual({});
		expect(parseStored('3')).toEqual({});
		expect(parseStored('null')).toEqual({});
		expect(warn).toHaveBeenCalledTimes(4);
	});
	it('drops non-array groups and non-string entries', () => {
		expect(parseStored('{"a":["/x",1,null,"/x"],"b":"/y","c":[2],"d":[]}')).toEqual({ a: ['/x'] });
	});
});

describe('groupKey / fileName', () => {
	it('uses the repo, else other', () => {
		expect(groupKey('/tmp/repo/src', ['/tmp/repo'])).toBe('/tmp/repo');
		expect(groupKey('/tmp/elsewhere', ['/tmp/repo'])).toBe(OTHER);
		expect(groupKey('', ['/tmp/repo'])).toBe(OTHER);
	});
	it('names a file by its last component', () => {
		expect(fileName('/tmp/repo/docs/a.md')).toBe('a.md');
		expect(fileName('a.md')).toBe('a.md');
	});
});
