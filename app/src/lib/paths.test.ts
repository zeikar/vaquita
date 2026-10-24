import { describe, expect, it } from 'vitest';
import { shortPath } from './paths';

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
});
