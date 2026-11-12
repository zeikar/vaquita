import { describe, expect, it, vi } from 'vitest';
import { isNewSessionShortcut, isNextTabShortcut, isPrevTabShortcut, isSaveShortcut, isSidebarShortcut, keyHandler, swallowsKeypress, tabNumber, translateKey } from './keys';

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
		const handle = keyHandler((t) => void sent.push(t), () => {});
		const results = [
			handle(key('keydown', { shiftKey: true })),
			handle(key('keypress', { shiftKey: true })),
			handle(key('keyup', { shiftKey: true })),
		];
		expect(sent).toEqual(['\x1b\r']);
		// keydown and keypress are rejected, so xterm sends nothing; keyup is ignored by xterm.
		expect(results.slice(0, 2)).toEqual([false, false]);
	});

	it('leaves Tab and Shift+Tab to the terminal, and Ctrl+Tab too, which the page takes first', () => {
		const handle = keyHandler(() => {}, () => {});
		expect(handle(key('keydown', { key: 'Tab', keyCode: 9 }))).toBe(true);
		expect(handle(key('keydown', { key: 'Tab', keyCode: 9, shiftKey: true }))).toBe(true);
	});

	it('passes plain Enter through', () => {
		const sent: string[] = [];
		const handle = keyHandler((t) => void sent.push(t), () => {});
		expect(handle(key('keydown', {}))).toBe(true);
		expect(handle(key('keypress', {}))).toBe(true);
		expect(sent).toEqual([]);
	});
});

describe('keyHandler, Cmd and an arrow', () => {
	const KEY_CODES: Record<string, number> = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

	function setup() {
		const done: string[] = [];
		const handle = keyHandler(
			(t) => void done.push(`send ${JSON.stringify(t)}`),
			() => void done.push('commit'),
		);
		// Whether xterm goes on with the key, and whether WebKit does.
		const press = (name: string, init: Partial<KeyboardEvent> = {}) => {
			const preventDefault = vi.fn();
			const xterm = handle(key('keydown', { key: name, keyCode: KEY_CODES[name], metaKey: true, preventDefault, ...init }));
			return { xterm, webkit: preventDefault.mock.calls.length === 0 };
		};
		return { done, press };
	}

	it('sends Ctrl+A for Cmd+Left and Ctrl+E for Cmd+Right, after ending the syllable being composed', () => {
		const { done, press } = setup();
		expect(press('ArrowLeft')).toEqual({ xterm: false, webkit: false });
		expect(press('ArrowRight')).toEqual({ xterm: false, webkit: false });
		expect(done).toEqual(['commit', 'send "\\u0001"', 'commit', 'send "\\u0005"']);
	});

	it('keeps every other Cmd and arrow from the hidden textarea, and sends nothing', () => {
		const { done, press } = setup();
		for (const [name, init] of [
			['ArrowUp', {}],
			['ArrowDown', {}],
			['ArrowLeft', { shiftKey: true }],
			['ArrowRight', { shiftKey: true }],
			['ArrowUp', { altKey: true }],
		] as const) {
			expect(press(name, init), name).toEqual({ xterm: false, webkit: false });
		}
		expect(done).toEqual([]);
	});

	it('leaves an arrow without Cmd, one with Ctrl too, and one that belongs to an IME to xterm', () => {
		const { done, press } = setup();
		expect(press('ArrowLeft', { metaKey: false })).toEqual({ xterm: true, webkit: true });
		expect(press('ArrowLeft', { metaKey: false, altKey: true })).toEqual({ xterm: true, webkit: true });
		expect(press('ArrowLeft', { ctrlKey: true })).toEqual({ xterm: true, webkit: true });
		expect(press('ArrowLeft', { keyCode: 229 })).toEqual({ xterm: true, webkit: true });
		expect(press('ArrowLeft', { isComposing: true })).toEqual({ xterm: true, webkit: true });
		expect(done).toEqual([]);
	});

	it('acts on the keydown only', () => {
		const { done } = setup();
		const handle = keyHandler((t) => void done.push(t), () => void done.push('commit'));
		expect(handle(key('keyup', { key: 'ArrowLeft', keyCode: 37, metaKey: true }))).toBe(true);
		expect(done).toEqual([]);
	});
});

describe('keyHandler, Cmd while an IME composes', () => {
	const meta = (init: Partial<KeyboardEvent>) => key('keydown', { key: 'Meta', keyCode: 91, metaKey: true, ...init });

	it('keeps the Cmd press from xterm, which would send the composition and send it again at its end', () => {
		const sent: string[] = [];
		const handle = keyHandler((t) => void sent.push(t), () => void sent.push('commit'));
		expect(handle(meta({ isComposing: true }))).toBe(false);
		expect(sent).toEqual([]);
	});

	it('leaves a Cmd press outside a composition, and the other keys of one, to xterm', () => {
		const handle = keyHandler(() => {}, () => {});
		expect(handle(meta({}))).toBe(true);
		expect(handle(key('keyup', { key: 'Meta', keyCode: 91, isComposing: true }))).toBe(true);
		expect(handle(key('keydown', { key: 'Shift', keyCode: 16, shiftKey: true, isComposing: true }))).toBe(true);
		expect(handle(key('keydown', { key: 'ㅣ', keyCode: 229, isComposing: true }))).toBe(true);
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
	const tab = (init: Partial<KeyboardEvent>) => key('keydown', { key: 'Tab', keyCode: 9, ctrlKey: true, ...init });

	it('are Ctrl+Shift+Tab and Ctrl+Tab', () => {
		expect(isPrevTabShortcut(tab({ shiftKey: true }))).toBe(true);
		expect(isNextTabShortcut(tab({}))).toBe(true);
		expect(isPrevTabShortcut(tab({}))).toBe(false);
		expect(isNextTabShortcut(tab({ shiftKey: true }))).toBe(false);
	});

	it('are Option+Cmd+Left and Option+Cmd+Right too, as in Chrome', () => {
		const arrow = (name: string, init: Partial<KeyboardEvent> = {}) => key('keydown', { key: name, keyCode: 0, metaKey: true, altKey: true, ...init });
		expect(isPrevTabShortcut(arrow('ArrowLeft'))).toBe(true);
		expect(isNextTabShortcut(arrow('ArrowRight'))).toBe(true);
		expect(isNextTabShortcut(arrow('ArrowLeft'))).toBe(false);
		expect(isPrevTabShortcut(arrow('ArrowRight'))).toBe(false);
		for (const init of [{ altKey: false }, { metaKey: false }, { shiftKey: true }, { ctrlKey: true }, { keyCode: 229 }]) {
			expect(isNextTabShortcut(arrow('ArrowRight', init)), JSON.stringify(init)).toBe(false);
		}
		expect(isNextTabShortcut(arrow('ArrowDown'))).toBe(false);
	});

	it('are not their variants', () => {
		expect(isNextTabShortcut(key('keydown', { key: 'Tab', keyCode: 9 }))).toBe(false);
		expect(isNextTabShortcut(tab({ metaKey: true }))).toBe(false);
		expect(isNextTabShortcut(tab({ altKey: true }))).toBe(false);
		expect(isNextTabShortcut(tab({ keyCode: 229 }))).toBe(false);
	});
});

describe('tabNumber', () => {
	const d = (init: Partial<KeyboardEvent>) => key('keydown', { key: '3', keyCode: 51, metaKey: true, ...init });

	it('is the digit with Cmd alone', () => {
		expect(tabNumber(d({}))).toBe(3);
	});
	it('ignores 0, other keys and a missing Cmd', () => {
		expect(tabNumber(d({ key: '0' }))).toBeUndefined();
		expect(tabNumber(d({ key: 't' }))).toBeUndefined();
		expect(tabNumber(d({ metaKey: false }))).toBeUndefined();
	});
	it('ignores Shift, Ctrl and Option', () => {
		expect(tabNumber(d({ key: '1', shiftKey: true }))).toBeUndefined();
		expect(tabNumber(d({ ctrlKey: true }))).toBeUndefined();
		expect(tabNumber(d({ altKey: true }))).toBeUndefined();
	});
	it('ignores a key that belongs to an IME', () => {
		expect(tabNumber(d({ keyCode: 229 }))).toBeUndefined();
	});
});
