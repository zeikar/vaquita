// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { installHangulFix, type HangulFix, type HangulHost } from './hangul-fix';

// Its window listener would outlive the test.
const installed: HangulFix[] = [];

// A stand-in for an opened xterm: the fix listens on the element in the
// capture phase, xterm on the textarea itself.
function setup() {
	const element = document.createElement('div');
	const screen = document.createElement('div');
	screen.className = 'xterm-screen';
	// 10x20 cells, the screen 10px right of and 20px below the element.
	screen.getBoundingClientRect = () => ({ left: 10, top: 20, width: 800, height: 480 }) as DOMRect;
	const textarea = document.createElement('textarea');
	element.append(screen, textarea);
	document.body.append(element);
	const none = () => ({ dispose() {} });
	const host: HangulHost = {
		element,
		textarea,
		cols: 80,
		rows: 24,
		buffer: { active: { cursorX: 3, cursorY: 0 } },
		options: { fontFamily: 'Menlo', fontSize: 13, theme: { foreground: '#ffffff', background: '#000000' } },
		onCursorMove: none,
		onWriteParsed: none,
	};
	const seen: string[] = [];
	const reached: string[] = [];
	for (const type of ['beforeinput', 'input']) {
		element.addEventListener(type, (e) => void seen.push(`${type} ${(e as InputEvent).data}`), true);
		textarea.addEventListener(type, (e) => void reached.push(`${type} ${(e as InputEvent).data}`));
	}
	const emitted: string[] = [];
	const fix = installHangulFix(host, (text) => void emitted.push(text));
	installed.push(fix);
	const overlay = element.querySelector<HTMLElement>('.hangul-pending')!;
	// Both events of one edit; true unless one was cancelled.
	const type = (inputType: string, data: string | null = null) =>
		['beforeinput', 'input']
			.map((t) => textarea.dispatchEvent(new InputEvent(t, { inputType, data, bubbles: true, cancelable: true })))
			.every(Boolean);
	return { element, textarea, fix, overlay, seen, reached, emitted, type };
}

afterEach(() => {
	for (const fix of installed.splice(0)) fix.dispose();
	document.body.replaceChildren();
});

// Records the textarea's focus changes from now on.
function focusLog(textarea: HTMLTextAreaElement): string[] {
	const log: string[] = [];
	textarea.addEventListener('blur', () => void log.push('blur'));
	textarea.addEventListener('focus', () => void log.push('focus'));
	return log;
}

describe('installHangulFix', () => {
	it('keeps the syllable from xterm, shows it at the cursor and emits it when the next starts', () => {
		const { overlay, seen, reached, emitted, type } = setup();
		for (const [inputType, data] of [
			['insertText', 'ㅇ'],
			['insertReplacementText', '아'],
			['insertReplacementText', '안'],
			['insertReplacementText', '안'],
		]) {
			expect(type(inputType, data)).toBe(true);
		}
		expect(seen).toHaveLength(8);
		expect(reached).toEqual([]);
		expect(emitted).toEqual([]);
		expect(overlay.textContent).toBe('안');
		expect(overlay.style.display).toBe('block');
		expect([overlay.style.left, overlay.style.top, overlay.style.height]).toEqual(['40px', '20px', '20px']);

		type('insertText', 'ㄴ');
		expect(emitted).toEqual(['안']);
		expect(overlay.textContent).toBe('ㄴ');
		expect(reached).toEqual([]);
	});

	it('hides the overlay once flushed', () => {
		const { fix, overlay, emitted, type } = setup();
		type('insertText', '테');
		fix.flush();
		expect(emitted).toEqual(['테']);
		expect(overlay.style.display).toBe('none');
		expect(overlay.textContent).toBe('');
	});

	it('leaves Latin input to xterm untouched', () => {
		const { reached, emitted, type } = setup();
		expect(type('insertText', 'a')).toBe(true);
		expect(reached).toEqual(['beforeinput a', 'input a']);
		expect(emitted).toEqual([]);
	});

	it('commits on a click and bounces the textarea focus', () => {
		const { element, textarea, emitted, type } = setup();
		textarea.focus();
		const focus = focusLog(textarea);
		type('insertText', '가');
		element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		expect(emitted).toEqual(['가']);
		expect(focus).toEqual(['blur', 'focus']);
		expect(document.activeElement).toBe(textarea);
	});

	it('commits when the window loses focus', () => {
		const { textarea, emitted, type } = setup();
		textarea.focus();
		const focus = focusLog(textarea);
		type('insertText', '가');
		window.dispatchEvent(new Event('blur'));
		expect(emitted).toEqual(['가']);
		expect(focus).toEqual(['blur', 'focus']);
	});

	it('flushes without a bounce when the textarea loses focus', () => {
		const { textarea, emitted, type } = setup();
		textarea.focus();
		const focus = focusLog(textarea);
		type('insertText', '가');
		textarea.blur();
		expect(emitted).toEqual(['가']);
		expect(focus).toEqual(['blur']);
		expect(document.activeElement).not.toBe(textarea);
	});

	it('removes its listeners and the overlay on dispose', () => {
		const { element, textarea, fix, reached, emitted, type } = setup();
		textarea.focus();
		// Held when the fix goes, so that any listener left would emit it.
		type('insertText', '가');
		fix.dispose();
		window.dispatchEvent(new Event('blur'));
		element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		textarea.blur();
		type('insertText', '나');
		expect(reached).toEqual(['beforeinput 나', 'input 나']);
		expect(emitted).toEqual([]);
		expect(element.querySelector('.hangul-pending')).toBeNull();
	});
});
