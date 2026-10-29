import { afterEach, describe, expect, it, vi } from 'vitest';
import { OTHER, closeInGroup, closeTabs, fallback, fileName, groupKey, moveTab, neighbour, openFileTab, openPreview, openTab, parseStored, prune, setOrder, touch, unpreview } from './tabs';

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

describe('openPreview / unpreview', () => {
	const repo = '/tmp/repo';

	it('appends the first and marks it as the preview', () => {
		expect(openPreview({ [repo]: ['/a'] }, {}, repo, '/b')).toEqual({ groups: { [repo]: ['/a', '/b'] }, previews: { [repo]: '/b' } });
	});

	it('replaces the preview in place and keeps the pinned tabs', () => {
		const groups = { [repo]: ['/a', '/p', '/c'] };
		const previews = { [repo]: '/p' };
		expect(openPreview(groups, previews, repo, '/n')).toEqual({ groups: { [repo]: ['/a', '/n', '/c'] }, previews: { [repo]: '/n' }, replaced: '/p' });
		expect(groups[repo]).toEqual(['/a', '/p', '/c']);
		expect(previews[repo]).toBe('/p');
	});

	it('leaves everything alone for a pinned tab and for the preview itself', () => {
		const groups = { [repo]: ['/a', '/p'] };
		const previews = { [repo]: '/p' };
		expect(openPreview(groups, previews, repo, '/a')).toEqual({ groups, previews });
		expect(openPreview(groups, previews, repo, '/p')).toEqual({ groups, previews });
	});

	it('appends when the stored preview is no longer a tab of the group', () => {
		expect(openPreview({ [repo]: ['/a'] }, { [repo]: '/gone' }, repo, '/n')).toEqual({ groups: { [repo]: ['/a', '/n'] }, previews: { [repo]: '/n' } });
	});

	it('unpreview removes the entries of its path only and returns a new object', () => {
		const previews = { [repo]: '/p', '/tmp/other': '/p', [OTHER]: '/q' };
		expect(unpreview(previews, '/p')).toEqual({ [OTHER]: '/q' });
		expect(previews).toEqual({ [repo]: '/p', '/tmp/other': '/p', [OTHER]: '/q' });
		expect(unpreview(previews, '/zzz')).not.toBe(previews);
	});
});

describe('openFileTab', () => {
	const a = '/tmp/a';
	const b = '/tmp/b';
	const notes = '/tmp/notes.md';

	it('pins: appends, and a preview opened again is no longer one', () => {
		expect(openFileTab({}, {}, a, '/x', true)).toEqual({ groups: { [a]: ['/x'] }, previews: {} });
		expect(openFileTab({ [a]: ['/x'] }, { [a]: '/x' }, a, '/x', true)).toEqual({ groups: { [a]: ['/x'] }, previews: {} });
	});

	it('drops the replaced preview when no group has it any more', () => {
		const one = openFileTab({}, {}, b, notes, false);
		expect(openFileTab(one.groups, one.previews, b, '/x', false)).toEqual({ groups: { [b]: ['/x'] }, previews: { [b]: '/x' }, drop: notes });
	});

	// Documents are shared by path across groups.
	it('keeps the replaced preview while another group has it as a tab', () => {
		let s = openFileTab({}, {}, a, notes, false);
		s = openFileTab(s.groups, s.previews, b, notes, false);
		expect(s.previews).toEqual({ [a]: notes, [b]: notes });
		const r = openFileTab(s.groups, s.previews, b, '/x', false);
		expect(r.groups).toEqual({ [a]: [notes], [b]: ['/x'] });
		expect(r.drop).toBeUndefined();
	});

	// The caller pins a path whose document is dirty, as after edits in A.
	it('a file edited in one group opens pinned in another and outlives the next file there', () => {
		let s = openFileTab({}, {}, a, notes, false);
		s = { ...s, previews: unpreview(s.previews, notes) };
		s = openFileTab(s.groups, s.previews, b, notes, true);
		expect(s.previews).toEqual({});
		const r = openFileTab(s.groups, s.previews, b, '/x', false);
		expect(r.groups).toEqual({ [a]: [notes], [b]: [notes, '/x'] });
		expect(r.drop).toBeUndefined();
	});
});

describe('closeInGroup', () => {
	const a = '/tmp/a';
	const b = '/tmp/b';
	const notes = '/tmp/notes.md';

	it('closes the known tabs of the group and drops what no group has any more', () => {
		const groups = { [b]: [notes, '/x', '/y'] };
		expect(closeInGroup(groups, {}, b, [notes, '/y', '/zzz'])).toEqual({ groups: { [b]: ['/x'] }, previews: {}, drop: [notes, '/y'] });
		expect(closeInGroup({}, {}, b, [notes])).toEqual({ groups: {}, previews: {}, drop: [] });
	});

	// Documents are shared by path across groups: edits made in A stay
	// reachable from A's tab, so nothing is dropped or asked about.
	it('keeps the document of a path another group still has', () => {
		const groups = { [a]: [notes], [b]: [notes, '/x'] };
		expect(closeInGroup(groups, {}, b, [notes, '/x'])).toEqual({ groups: { [a]: [notes] }, previews: {}, drop: ['/x'] });
	});

	it("unpins only the closing group's preview", () => {
		const groups = { [a]: [notes], [b]: [notes, '/x'] };
		const previews = { [a]: notes, [b]: notes, [OTHER]: '/q' };
		expect(closeInGroup(groups, previews, b, [notes]).previews).toEqual({ [a]: notes, [OTHER]: '/q' });
		expect(closeInGroup(groups, previews, b, ['/x']).previews).toEqual(previews);
		expect(previews).toEqual({ [a]: notes, [b]: notes, [OTHER]: '/q' });
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

describe('moveTab / setOrder', () => {
	const tabs = ['/a', '/b', '/c', '/d'];
	it('moves a path forward and backward among the rest, returning a new array', () => {
		expect(moveTab(tabs, '/a', 2)).toEqual(['/b', '/c', '/a', '/d']);
		expect(moveTab(tabs, '/d', 1)).toEqual(['/a', '/d', '/b', '/c']);
		expect(tabs).toEqual(['/a', '/b', '/c', '/d']);
	});
	it('moves a path to either end', () => {
		expect(moveTab(tabs, '/c', 0)).toEqual(['/c', '/a', '/b', '/d']);
		expect(moveTab(tabs, '/b', 3)).toEqual(['/a', '/c', '/d', '/b']);
	});
	it('leaves the array alone for an unknown path', () => {
		expect(moveTab(tabs, '/zzz', 1)).toBe(tabs);
	});
	it('keeps a reported order and the other groups', () => {
		const g = { '/tmp/repo': ['/a', '/b', '/c'], [OTHER]: ['/x'] };
		expect(setOrder(g, '/tmp/repo', ['/c', '/a', '/b'])).toEqual({ '/tmp/repo': ['/c', '/a', '/b'], [OTHER]: ['/x'] });
		expect(g['/tmp/repo']).toEqual(['/a', '/b', '/c']);
	});
	// A tab closed during a drag cannot come back, and one opened meanwhile
	// cannot vanish.
	it('drops a path that is no tab any more and appends a tab the report lacks', () => {
		const g = { '/tmp/repo': ['/a', '/c', '/d'] };
		expect(setOrder(g, '/tmp/repo', ['/c', '/b', '/a'])).toEqual({ '/tmp/repo': ['/c', '/a', '/d'] });
	});
	it('ignores an unknown group', () => {
		const g = { '/tmp/repo': ['/a'] };
		expect(setOrder(g, '/tmp/none', ['/a'])).toEqual(g);
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
