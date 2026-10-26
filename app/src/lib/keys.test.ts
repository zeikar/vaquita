import { describe, expect, it } from 'vitest';
import { isNewSessionShortcut, isSidebarShortcut, keyHandler, swallowsKeypress, translateKey } from './keys';

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
