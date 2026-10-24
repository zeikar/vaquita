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
		home: undefined as string | undefined,
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
	vi.restoreAllMocks();
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
		target.querySelector('.detail')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
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
		expect(target.querySelector('button[aria-label="Kill"] [data-icon="x-mark"]')).not.toBeNull();
	});
});

describe('SessionList rows', () => {
	const all = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
	const button = (label: string) => target.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
	function click(el: HTMLElement) {
		el.click();
		flushSync();
	}

	it('takes the agent icon from agent, else from the first word of cmd', () => {
		show([row(1, { agent: 'codex', cmd: 'claude' }), row(2), row(3, { cmd: "'codex' resume" }), row(4, { cmd: '' })]);
		expect(all('.agent svg[data-icon]').map((e) => e.dataset.icon)).toEqual(['openai', 'claude', 'openai', 'command-line']);
		expect(all('.agent').map((e) => e.title)).toEqual(['codex', 'claude', 'codex', 'shell']);
	});

	it('shows the status message, else the state of an old or exited session, else the short path', () => {
		const p = show([
			row(1, { cwd: '/Users/me/Developer/Projects/iki', status: { state: 'input', msg: 'Allow Bash(git status)?' } }),
			row(2, { cwd: '/Users/me/Developer/Projects/iki' }),
			row(3, { restorable: true, state: 'exited' }),
			row(4, { state: 'exited', code: 1 }),
			row(5, { state: 'exited', code: 0, orphans: [7, 8] }),
		]);
		const details = () => all('.detail').map((e) => e.textContent);
		expect(details()).toEqual(['Allow Bash(git status)?', '/U/m/D/P/iki', 'from an earlier run', 'exited (1)', 'exited (0) · orphans: 7, 8']);
		p.home = '/Users/me';
		flushSync();
		expect(details()[1]).toBe('~/D/P/iki');
	});

	it('keeps the full path and the counters in the row tooltip', () => {
		const r = row(1, { cwd: '/tmp/repo/a/b' });
		show([{ ...r, ro: true, reports: 2 }, row(2, { cwd: '' })]);
		expect(all('button.row').map((e) => e.title)).toEqual(['/tmp/repo/a/b\nread-only\nreports: 2', '~']);
	});

	it('titles and labels the status icon with the message, else the state', () => {
		show([row(1, { status: { state: 'input', msg: 'Allow?' } }), row(2, { status: { state: 'error' } }), row(3)]);
		const s = all('.status');
		expect(s.map((e) => e.getAttribute('title'))).toEqual(['Allow?', 'failed', null]);
		expect(s.map((e) => e.getAttribute('aria-label'))).toEqual(['Allow?', 'failed', null]);
		expect(s.map((e) => e.getAttribute('role'))).toEqual(['img', 'img', null]);
		expect(s[0].querySelector('[data-icon="exclamation-triangle"]')).not.toBeNull();
		expect(s[1].querySelector('[data-icon="x-circle"]')).not.toBeNull();
	});

	it('kills on a second click at least 400 ms after the first, asking in between', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const p = show([row(1), row(2)]);
		const kill = all('button[aria-label="Kill"]')[1];
		click(kill);
		expect(kill.textContent?.trim()).toBe('Confirm kill?');
		expect(kill.getAttribute('aria-label')).toBe('Confirm kill?');
		now = 200;
		click(kill);
		expect(p.onkill).not.toHaveBeenCalled();
		now = 500;
		click(kill);
		expect(p.onkill).toHaveBeenCalledTimes(1);
		expect(p.onkill).toHaveBeenCalledWith(2);
		expect(kill.querySelector('[data-icon="x-mark"]')).not.toBeNull();
		expect(kill.getAttribute('aria-label')).toBe('Kill');
	});

	it('reopens and dismisses an old session, the dismiss on a second click', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const p = show([row(3, { restorable: true, state: 'exited' })]);
		expect(target.querySelector('button[aria-label="Kill"]')).toBeNull();
		click(button('Reopen'));
		expect(p.onreopen).toHaveBeenCalledWith(3);
		click(button('Dismiss'));
		expect(button('Confirm dismiss?').textContent?.trim()).toBe('Confirm dismiss?');
		expect(p.ondismiss).not.toHaveBeenCalled();
		now = 1000;
		click(button('Confirm dismiss?'));
		expect(p.ondismiss).toHaveBeenCalledWith(3);
		expect(button('Dismiss')).not.toBeNull();
	});

	it('disables Reopen while disabled', () => {
		const p = show([row(3, { restorable: true, state: 'exited' })]);
		p.disabled = true;
		flushSync();
		expect(button('Reopen').disabled).toBe(true);
		click(button('Reopen'));
		expect(p.onreopen).not.toHaveBeenCalled();
		expect(button('Dismiss').disabled).toBe(false);
	});
});
