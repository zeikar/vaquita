// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state: a list update has to
// reach the mounted list while a name is being edited.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from './manager';
import type { SessionInfo } from './protocol';
import SessionList from './SessionList.svelte';

const row = (sid: number, extra: Partial<SessionInfo> = {}): SessionRow<unknown> => ({
	info: { sid, inc: 'i', cwd: '/tmp/repo', cmd: 'claude', name: '', cols: 80, rows: 24, state: 'running', pid: 2, code: 0, ...extra },
	ro: false,
	reports: 0,
	resets: 0,
});

let target: HTMLElement;
let app: ReturnType<typeof mount> | undefined;

function show(sessions: SessionRow<unknown>[]) {
	const props = $state({
		sessions,
		repos: [] as string[],
		disabled: false,
		onselect: vi.fn(),
		onkill: vi.fn(),
		onreopen: vi.fn(),
		ondismiss: vi.fn(),
		onstart: vi.fn(),
		onremoverepo: vi.fn(),
		onrename: vi.fn(),
	});
	target = document.createElement('div');
	document.body.append(target);
	app = mount(SessionList, { target, props });
	return props;
}

const titles = () => [...target.querySelectorAll<HTMLElement>('span.title')];
const input = () => target.querySelector<HTMLInputElement>('input[aria-label="Session name"]');

function edit(title = titles()[0]): HTMLInputElement {
	title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
	flushSync();
	const el = input();
	expect(el).not.toBeNull();
	return el!;
}

function type(el: HTMLInputElement, text: string) {
	el.value = text;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

function key(el: HTMLInputElement, k: string, init: KeyboardEventInit = {}) {
	el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
	flushSync();
}

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	target?.remove();
});

describe('SessionList renaming', () => {
	it('opens a focused input with the name on a double-click on the title', () => {
		show([row(1, { name: 'w', title: 'topic' })]);
		const el = edit();
		expect(el.value).toBe('w');
		expect(el.placeholder).toBe('topic');
		expect(document.activeElement).toBe(el);
	});

	it('opens no input on a double-click elsewhere on the row', () => {
		show([row(1, { name: 'w' })]);
		target.querySelector('.cwd')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		expect(input()).toBeNull();
	});

	it('opens an empty input with the title the row would have without a name as its placeholder', () => {
		show([row(1, { title: 'topic' }), row(2)]);
		const [a, b] = titles();
		const el = edit(a);
		expect(el.value).toBe('');
		expect(el.placeholder).toBe('topic');
		key(el, 'Escape');
		expect(edit(b).placeholder).toBe('claude');
	});

	it('commits on Enter, once, and shows the title again', () => {
		const p = show([row(1, { name: 'w' })]);
		const el = edit();
		type(el, '  fix login ');
		key(el, 'Enter');
		el.dispatchEvent(new FocusEvent('blur'));
		expect(p.onrename).toHaveBeenCalledTimes(1);
		expect(p.onrename).toHaveBeenCalledWith(1, 'fix login');
		expect(input()).toBeNull();
		expect(titles()).toHaveLength(1);
		expect(p.onselect).not.toHaveBeenCalled();
	});

	it('commits an emptied name, which clears it', () => {
		const p = show([row(1, { name: 'w' })]);
		const el = edit();
		type(el, '');
		key(el, 'Enter');
		expect(p.onrename).toHaveBeenCalledWith(1, '');
	});

	it('commits on blur', () => {
		const p = show([row(1)]);
		const el = edit();
		type(el, 'x');
		el.blur();
		flushSync();
		expect(p.onrename).toHaveBeenCalledWith(1, 'x');
		expect(input()).toBeNull();
	});

	it('cancels on Escape', () => {
		const p = show([row(1, { name: 'w' })]);
		const el = edit();
		type(el, 'x');
		key(el, 'Escape');
		el.dispatchEvent(new FocusEvent('blur'));
		expect(input()).toBeNull();
		expect(p.onrename).not.toHaveBeenCalled();
		expect(titles()[0].textContent).toContain('w');
	});

	it('leaves an Enter or Escape that ends an IME composition to the IME', () => {
		const p = show([row(1)]);
		const el = edit();
		type(el, '한');
		// The last two are how WKWebView can report the key right after
		// compositionend.
		const ime: [string, KeyboardEventInit][] = [
			['Enter', { isComposing: true }],
			['Escape', { isComposing: true }],
			['Enter', { isComposing: false, keyCode: 229 }],
			['Escape', { isComposing: false, keyCode: 229 }],
		];
		for (const [k, init] of ime) {
			key(el, k, init);
			expect(input(), `${k} ${JSON.stringify(init)}`).toBe(el);
		}
		expect(p.onrename).not.toHaveBeenCalled();
	});

	it('sends nothing when the name is left as it was', () => {
		const p = show([row(1, { name: 'w' })]);
		key(edit(), 'Enter');
		const el = edit();
		type(el, ' w ');
		el.blur();
		flushSync();
		expect(p.onrename).not.toHaveBeenCalled();
	});

	it('keeps the typed text through a list update', () => {
		const p = show([row(1, { name: 'w' }), row(2)]);
		const el = edit();
		type(el, 'abc');
		p.sessions = [row(1, { name: 'w', status: { state: 'working' }, unread: true }), row(3)];
		flushSync();
		expect(input()).toBe(el);
		expect(el.value).toBe('abc');
		expect(document.activeElement).toBe(el);
		key(el, 'Enter');
		expect(p.onrename).toHaveBeenCalledWith(1, 'abc');
	});

	it('neither selects nor kills on clicks and keys inside the input', () => {
		const p = show([row(1, { name: 'w' })]);
		const el = edit();
		el.click();
		el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		key(el, ' ');
		key(el, 'a');
		flushSync();
		expect(input()).toBe(el);
		expect(p.onselect).not.toHaveBeenCalled();
		expect(p.onkill).not.toHaveBeenCalled();
		expect(target.querySelector('button.kill')?.textContent?.trim()).toBe('Kill');
	});
});
