import { describe, expect, it } from 'vitest';
import { fileIcon, joinPath, visibleExpanded } from './tree';

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

describe('fileIcon', () => {
	const icon = (name: string) => fileIcon(name, false, false);

	it('draws a folder closed or open in the accent colour', () => {
		expect(fileIcon('src', true, false)).toEqual({ icon: 'folder', tint: 'var(--accent)' });
		expect(fileIcon('src', true, true)).toEqual({ icon: 'folder-open', tint: 'var(--accent)' });
		// A folder's name never picks a file kind.
		expect(fileIcon('lib.rs', true, false).icon).toBe('folder');
	});

	it('draws code blue, and markup orange', () => {
		for (const n of ['a.ts', 'b.tsx', 'main.go', 'lib.rs', 'x.py', 'y.css', 'z.cpp']) expect(icon(n)).toEqual({ icon: 'code-bracket', tint: '#6aa9e0' });
		for (const n of ['App.svelte', 'C.vue', 'index.html']) expect(icon(n)).toEqual({ icon: 'code-bracket', tint: '#e0805a' });
	});

	it('draws prose amber, and plain text grey', () => {
		expect(icon('README.md')).toEqual({ icon: 'document-text', tint: '#c9a96a' });
		expect(icon('notes.rst').tint).toBe('#c9a96a');
		expect(icon('a.txt')).toEqual({ icon: 'document-text', tint: '#999' });
	});

	it('draws images, video and audio', () => {
		expect(icon('logo.png')).toEqual({ icon: 'photo', tint: '#7cc47c' });
		expect(icon('clip.mp4').icon).toBe('film');
		expect(icon('song.mp3').icon).toBe('musical-note');
	});

	it('draws config by extension and by name', () => {
		for (const n of ['package.json', 'Cargo.toml', 'a.yml', 'Info.plist', 'Makefile', 'Dockerfile', '.gitignore', '.editorconfig'])
			expect(icon(n)).toEqual({ icon: 'cog-6-tooth', tint: '#999' });
	});

	it('draws env and lock files as locked', () => {
		for (const n of ['.env', '.env.local', 'Cargo.lock', 'package-lock.json'])
			expect(icon(n)).toEqual({ icon: 'lock-closed', tint: '#999' });
	});

	it('draws shell scripts as a command line', () => {
		for (const n of ['run.sh', 'a.zsh', 'go.command']) expect(icon(n)).toEqual({ icon: 'command-line-outline', tint: '#999' });
	});

	it('reads extensions without regard to case', () => {
		expect(icon('MAIN.GO').icon).toBe('code-bracket');
		expect(icon('Photo.JPG').icon).toBe('photo');
		expect(icon('CARGO.LOCK').icon).toBe('lock-closed');
	});

	it('draws anything else as a plain grey document', () => {
		for (const n of ['LICENSE', '.zshrc', 'a.bin', 'noext', '.environment', 'x.'])
			expect(icon(n)).toEqual({ icon: 'document', tint: '#999' });
	});
});
