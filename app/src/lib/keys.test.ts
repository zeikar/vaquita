import { describe, expect, it } from 'vitest';
import { keyHandler, swallowsKeypress, translateKey } from './keys';

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
