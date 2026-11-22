import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHORTCUTS, accelerator, chordLabel, chordsBy } from './shortcut-list';

describe('chordLabel', () => {
	it('writes modifiers in the order of docs/app.md, then the key', () => {
		expect(chordLabel({ key: 'ArrowUp', alt: true, meta: true })).toBe('⌥⌘↑');
		expect(chordLabel({ key: 'c', meta: true, shift: true })).toBe('⌘⇧C');
		expect(chordLabel({ key: 'Tab', ctrl: true, shift: true })).toBe('⌃⇧Tab');
		expect(chordLabel({ key: '[', meta: true, shift: true })).toBe('⌘⇧[');
		expect(chordLabel({ key: 'Enter', shift: true })).toBe('⇧Enter');
		expect(chordLabel({ key: '1', meta: true })).toBe('⌘1');
	});
});

describe('SHORTCUTS', () => {
	const entries = SHORTCUTS.flatMap((s) => s.entries);

	it('gives every entry a description and a key', () => {
		for (const e of entries) {
			expect(e.does).not.toBe('');
			expect(e.keys.length).toBeGreaterThan(0);
		}
	});

	it('has no chord twice', () => {
		const labels = [...chordsBy('window'), ...chordsBy('menu'), ...chordsBy('terminal')].map(chordLabel);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("has exactly the accelerators menu.rs has", () => {
		const src = readFileSync(new URL('../../src-tauri/src/menu.rs', import.meta.url), 'utf8');
		const inMenu = [...src.matchAll(/"(CmdOrCtrl\+[^"]*)"/g)].map((m) => m[1]).sort();
		expect(inMenu.length).toBeGreaterThan(0);
		expect(chordsBy('menu').map(accelerator).sort()).toEqual(inMenu);
	});
});
