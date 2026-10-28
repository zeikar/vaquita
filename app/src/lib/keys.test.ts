import { describe, expect, it } from 'vitest';
import { isNewSessionShortcut, isNextTabShortcut, isPrevTabShortcut, isSaveShortcut, isSidebarShortcut, keyHandler, swallowsKeypress, translateKey } from './keys';

function key(type: string, init: Partial<KeyboardEvent>): KeyboardEvent {
	return { type, key: 'Enter', keyCode: 13, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...init } as KeyboardEvent;
}

describe('translateKey', () => {
	it('maps Shift+Enter keydown to ESC CR', () => {
		expect(translateKey(key('keydown', { shiftKey: true }))).toBe('\x1b\r');
	});

	it('leaves other keys to xterm', () => {
		expect(translateKey(key('keydown', {}))).toBeNull();
		expect(translateKey(key('keydown', { metaKey: true }))).toBeNull();
		expect(translateKey(key('keydown', { shiftKey: true, metaKey: true }))).toBeNull();
		expect(translateKey(key('keyup', { shiftKey: true }))).toBeNull();
		expect(translateKey(key('keydown', { shiftKey: true, isComposing: true }))).toBeNull();
		expect(translateKey(key('keydown', { shiftKey: true, keyCode: 229 }))).toBeNull();
		expect(translateKey(key('keydown', { key: 'a', shiftKey: true }))).toBeNull();
	});
});

describe('swallowsKeypress', () => {
	it('swallows only the Shift+Enter keypress', () => {
		expect(swallowsKeypress(key('keypress', { shiftKey: true }))).toBe(true);
		expect(swallowsKeypress(key('keypress', {}))).toBe(false);
		expect(swallowsKeypress(key('keypress', { shiftKey: true, isComposing: true }))).toBe(false);
		expect(swallowsKeypress(key('keydown', { shiftKey: true }))).toBe(false);
	});
});

describe('keyHandler', () => {
	it('sends ESC CR once for Shift+Enter and leaves xterm no event that yields CR', () => {
		const sent: string[] = [];
		const handle = keyHandler((t) => void sent.push(t));
		const results = [
			handle(key('keydown', { shiftKey: true })),
			handle(key('keypress', { shiftKey: true })),
			handle(key('keyup', { shiftKey: true })),
		];
		expect(sent).toEqual(['\x1b\r']);
		// keydown and keypress are rejected, so xterm sends nothing; keyup is ignored by xterm.
		expect(results.slice(0, 2)).toEqual([false, false]);
	});

	it('leaves Ctrl+Tab and Ctrl+Shift+Tab to the menu, uncancelled', () => {
		const sent: string[] = [];
		const handle = keyHandler((t) => void sent.push(t));
		for (const shiftKey of [false, true]) {
			let prevented = false;
			const ev = key('keydown', { key: 'Tab', keyCode: 9, ctrlKey: true, shiftKey, preventDefault: () => void (prevented = true) });
			expect(handle(ev)).toBe(false);
			expect(prevented).toBe(false);
		}
		expect(sent).toEqual([]);
		// A plain Tab and Shift+Tab are the terminal's.
		expect(handle(key('keydown', { key: 'Tab', keyCode: 9 }))).toBe(true);
		expect(handle(key('keydown', { key: 'Tab', keyCode: 9, shiftKey: true }))).toBe(true);
	});

	it('passes plain Enter through', () => {
		const sent: string[] = [];
		const handle = keyHandler((t) => void sent.push(t));
		expect(handle(key('keydown', {}))).toBe(true);
		expect(handle(key('keypress', {}))).toBe(true);
		expect(sent).toEqual([]);
	});
});

describe('isNewSessionShortcut', () => {
	const t = (init: Partial<KeyboardEvent>) => key('keydown', { key: 't', keyCode: 84, ...init });

	it('is Cmd+T alone', () => {
		expect(isNewSessionShortcut(t({ metaKey: true }))).toBe(true);
		// Caps Lock.
		expect(isNewSessionShortcut(t({ metaKey: true, key: 'T' }))).toBe(true);
		expect(isNewSessionShortcut(t({}))).toBe(false);
		expect(isNewSessionShortcut(t({ ctrlKey: true }))).toBe(false);
		expect(isNewSessionShortcut(t({ metaKey: true, shiftKey: true, key: 'T' }))).toBe(false);
		expect(isNewSessionShortcut(t({ metaKey: true, altKey: true, key: '†' }))).toBe(false);
		expect(isNewSessionShortcut(t({ metaKey: true, ctrlKey: true }))).toBe(false);
		expect(isNewSessionShortcut(t({ metaKey: true, key: 'n' }))).toBe(false);
	});

	it('leaves a key that belongs to an IME alone', () => {
		expect(isNewSessionShortcut(t({ metaKey: true, isComposing: true }))).toBe(false);
		expect(isNewSessionShortcut(t({ metaKey: true, keyCode: 229 }))).toBe(false);
	});
});

describe('isSidebarShortcut', () => {
	const b = (init: Partial<KeyboardEvent>) => key('keydown', { key: 'b', keyCode: 66, ...init });

	it('is Cmd+B alone', () => {
		expect(isSidebarShortcut(b({ metaKey: true }))).toBe(true);
		expect(isSidebarShortcut(b({ metaKey: true, key: 'B' }))).toBe(true);
		expect(isSidebarShortcut(b({}))).toBe(false);
		expect(isSidebarShortcut(b({ metaKey: true, shiftKey: true, key: 'B' }))).toBe(false);
		expect(isSidebarShortcut(b({ metaKey: true, key: 't' }))).toBe(false);
		expect(isSidebarShortcut(b({ metaKey: true, keyCode: 229 }))).toBe(false);
	});
});

describe('isSaveShortcut', () => {
	const s = (init: Partial<KeyboardEvent>) => key('keydown', { key: 's', keyCode: 83, ...init });

	it('is Cmd+S alone', () => {
		expect(isSaveShortcut(s({ metaKey: true }))).toBe(true);
		expect(isSaveShortcut(s({ metaKey: true, key: 'S' }))).toBe(true);
		expect(isSaveShortcut(s({}))).toBe(false);
		expect(isSaveShortcut(s({ metaKey: true, shiftKey: true, key: 'S' }))).toBe(false);
		expect(isSaveShortcut(s({ metaKey: true, ctrlKey: true }))).toBe(false);
		expect(isSaveShortcut(s({ metaKey: true, altKey: true, key: 'ß' }))).toBe(false);
		expect(isSaveShortcut(s({ metaKey: true, keyCode: 229 }))).toBe(false);
	});
});

describe('isPrevTabShortcut and isNextTabShortcut', () => {
	const bracket = (code: string, init: Partial<KeyboardEvent>) =>
		key('keydown', { code, key: code === 'BracketLeft' ? '{' : '}', keyCode: code === 'BracketLeft' ? 219 : 221, ...init });

	it('are Cmd+Shift+[ and Cmd+Shift+], by code', () => {
		expect(isPrevTabShortcut(bracket('BracketLeft', { metaKey: true, shiftKey: true }))).toBe(true);
		expect(isNextTabShortcut(bracket('BracketRight', { metaKey: true, shiftKey: true }))).toBe(true);
		expect(isPrevTabShortcut(bracket('BracketRight', { metaKey: true, shiftKey: true }))).toBe(false);
		expect(isNextTabShortcut(bracket('BracketLeft', { metaKey: true, shiftKey: true }))).toBe(false);
	});

	it('are not their variants', () => {
		expect(isPrevTabShortcut(bracket('BracketLeft', { metaKey: true, key: '[' }))).toBe(false);
		expect(isPrevTabShortcut(bracket('BracketLeft', { shiftKey: true }))).toBe(false);
		expect(isPrevTabShortcut(bracket('BracketLeft', { metaKey: true, shiftKey: true, ctrlKey: true }))).toBe(false);
		expect(isNextTabShortcut(bracket('BracketRight', { metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
		expect(isNextTabShortcut(bracket('BracketRight', { metaKey: true, shiftKey: true, keyCode: 229 }))).toBe(false);
	});
});
