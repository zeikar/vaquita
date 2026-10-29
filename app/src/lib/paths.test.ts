import { describe, expect, it } from 'vitest';
import { barPath, shortPath } from './paths';

describe('shortPath', () => {
	const home = '/Users/me';
	it('starts with ~ under the home directory and abbreviates the middle', () => {
		expect(shortPath('/Users/me/Developer/Projects/iki', home)).toBe('~/D/P/iki');
		expect(shortPath('/Users/me', home)).toBe('~');
		expect(shortPath('/Users/me/.config/x/y', home)).toBe('~/.c/x/y');
		expect(shortPath('/Users/me/src/example', home)).toBe('~/src/example');
	});
	it('compares whole components for home', () => {
		expect(shortPath('/Users/Shared/a/b', home)).toBe('/U/S/a/b');
		expect(shortPath('/Users/meow/a', home)).toBe('/U/m/a');
	});
	it('stays absolute without a home', () => {
		expect(shortPath('/Users/me/Developer/Projects/iki')).toBe('/U/m/D/P/iki');
		expect(shortPath('/tmp/repo')).toBe('/tmp/repo');
	});
	it('treats an empty cwd as home', () => {
		expect(shortPath('', home)).toBe('~');
		expect(shortPath('')).toBe('~');
	});
	it('shows the filesystem root as /', () => {
		expect(shortPath('/', home)).toBe('/');
		expect(shortPath('/')).toBe('/');
	});
});

describe('barPath', () => {
	const home = '/Users/me';
	it('goes from the repo folder for a file in the repo', () => {
		expect(barPath('/tmp/repo/src/lib/a.ts', '/tmp/repo', home)).toEqual({ dir: 'src/lib/', name: 'a.ts' });
		expect(barPath('/tmp/repo/README.md', '/tmp/repo', home)).toEqual({ dir: '', name: 'README.md' });
	});
	it('goes from ~ under the home folder, outside any repo', () => {
		expect(barPath('/Users/me/notes/todo.md', undefined, home)).toEqual({ dir: '~/notes/', name: 'todo.md' });
		expect(barPath('/Users/me/src/other/x.txt', '/Users/me/src/example', home)).toEqual({ dir: '~/src/other/', name: 'x.txt' });
		expect(barPath('/Users/me/x.txt', undefined, home)).toEqual({ dir: '~/', name: 'x.txt' });
	});
	it('compares whole components', () => {
		expect(barPath('/tmp/repo-feature/a.ts', '/tmp/repo', home)).toEqual({ dir: '/tmp/repo-feature/', name: 'a.ts' });
		expect(barPath('/Users/meow/a.ts', undefined, home)).toEqual({ dir: '/Users/meow/', name: 'a.ts' });
	});
	it('stays absolute without a home', () => {
		expect(barPath('/Users/me/notes/todo.md')).toEqual({ dir: '/Users/me/notes/', name: 'todo.md' });
		expect(barPath('/etc/hosts', '/tmp/repo')).toEqual({ dir: '/etc/', name: 'hosts' });
	});
});
