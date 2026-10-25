// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state: a list update has to
// reach the mounted list while a name is being edited.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from './manager';
import type { SessionInfo } from './protocol';
import SessionList from './SessionList.svelte';

const opener = vi.hoisted(() => ({ revealItemInDir: vi.fn(async (_path: string) => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => opener);

const row =(sid: number, extra: Partial<SessionInfo> = {}): SessionRow<unknown> => ({
	info: { sid, inc: 'i', cwd: '/tmp/repo', cmd: 'claude', name: '', cols: 80, rows: 24, state: 'running', pid: 2, code: 0, ...extra },
	ro: false,
	reports: 0,
	resets: 0,
});

let target: HTMLElement;
let app: ReturnType<typeof mount> | undefined;

function show(sessions: SessionRow<unknown>[], repos: string[] = []) {
	const props = $state({
		sessions,
		repos,
		home: undefined as string | undefined,
		disabled: false,
		onselect: vi.fn(),
		onkill: vi.fn(),
		onreopen: vi.fn(),
		ondismiss: vi.fn(),
		onstart: vi.fn(),
		onremoverepo: vi.fn(),
		onrename: vi.fn(),
		onreport: vi.fn(),
		addDisabled: false,
		onaddrepo: vi.fn(),
		onnewsession: vi.fn(),
	});
	target = document.createElement('div');
	document.body.append(target);
	app = mount(SessionList, { target, props });
	flushSync();
	return props;
}

// As a restart of the app would: the same props, a new list.
function remount(props: ReturnType<typeof show>) {
	unmount(app!);
	app = mount(SessionList, { target, props });
	flushSync();
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
	localStorage.clear();
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
		// A message is marked with its state, for the colour of what waits on the user.
		expect(all('.detail').map((e) => e.classList.contains('input'))).toEqual([true, false, false, false, false]);
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

	it('reopens an old session when its row is clicked, and selects it while reopening is disabled', () => {
		const p = show([row(3, { restorable: true, state: 'exited' })]);
		click(target.querySelector<HTMLButtonElement>('button.row')!);
		expect(p.onreopen).toHaveBeenCalledWith(3);
		expect(p.onselect).not.toHaveBeenCalled();
		p.disabled = true;
		flushSync();
		click(target.querySelector<HTMLButtonElement>('button.row')!);
		expect(p.onreopen).toHaveBeenCalledTimes(1);
		expect(p.onselect).toHaveBeenCalledWith(3);
		target.querySelector('.title')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		expect(target.querySelector('input')).toBeNull();
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

describe('SessionList repo groups', () => {
	const header = (name: string) => [...target.querySelectorAll<HTMLButtonElement>('button[aria-expanded]:not([aria-haspopup])')].find((b) => b.textContent?.trim() === name)!;
	const button = (label: string) => target.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
	const menu = () => target.querySelector<HTMLElement>('[role="menu"]');
	const items = () => [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
	const item = (label: string) => items().find((b) => b.textContent?.trim() === label)!;
	const rowCount = () => target.querySelectorAll('button.row').length;
	function click(el: HTMLElement) {
		el.click();
		flushSync();
	}
	// A pointer's click on ⋯, its pointerdown first, which an open menu takes as a press outside it.
	function press(el: HTMLElement) {
		el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		flushSync();
		el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
		flushSync();
	}

	it('heads a repo group with the folder name, titled with the full path', () => {
		show([row(1)], ['/tmp/repo']);
		expect(header('repo').title).toBe('/tmp/repo');
		expect(header('repo').getAttribute('aria-expanded')).toBe('true');
		expect(target.textContent).not.toContain('remove');
	});

	it('collapses a group on its toggle, and keeps it collapsed through a remount', () => {
		const p = show([row(1), row(2)], ['/tmp/repo']);
		expect(rowCount()).toBe(2);
		click(header('repo'));
		expect(rowCount()).toBe(0);
		expect(header('repo').getAttribute('aria-expanded')).toBe('false');
		expect(header('repo').querySelector('[data-icon="chevron-right"]')).not.toBeNull();
		remount(p);
		expect(rowCount()).toBe(0);
		expect(header('repo').getAttribute('aria-expanded')).toBe('false');
		click(header('repo'));
		expect(rowCount()).toBe(2);
		expect(header('repo').querySelector('[data-icon="chevron-down"]')).not.toBeNull();
		remount(p);
		expect(rowCount()).toBe(2);
	});

	it('shows on a collapsed header that a hidden row needs input, else a login, and that one is unread', () => {
		const p = show(
			[
				row(1, { status: { state: 'auth' } }),
				row(2, { status: { state: 'input', msg: 'Allow Bash(git status)?' } }),
				row(3, { unread: true }),
				row(4, { cwd: '/tmp/elsewhere', unread: true }),
			],
			['/tmp/repo'],
		);
		const badge = () => target.querySelector('.badges [role="img"][aria-label^="needs"]');
		const dot = () => target.querySelector('.badges .dot.unread');
		// Open groups leave it to their rows.
		expect(target.querySelector('.badges')).toBeNull();
		click(header('repo'));
		expect(badge()?.getAttribute('aria-label')).toBe('needs input');
		expect(badge()?.querySelector('[data-icon="exclamation-triangle"]')).not.toBeNull();
		expect(dot()).not.toBeNull();
		p.sessions = [row(1, { status: { state: 'auth' } }), row(3)];
		flushSync();
		expect(badge()?.getAttribute('aria-label')).toBe('needs login');
		expect(badge()?.querySelector('[data-icon="key"]')).not.toBeNull();
		expect(dot()).toBeNull();
		p.sessions = [row(3)];
		flushSync();
		expect(target.querySelector('.badges')).toBeNull();
		// The group outside every repo too.
		p.sessions = [row(4, { cwd: '/tmp/elsewhere', unread: true })];
		flushSync();
		click(header('other'));
		expect(dot()).not.toBeNull();
		expect(badge()).toBeNull();
	});

	it('opens every group when the stored collapsed groups are unreadable', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		localStorage.setItem('vaquita.collapsed', '["/tmp/repo"');
		show([row(1)], ['/tmp/repo']);
		expect(rowCount()).toBe(1);
		expect(warn).toHaveBeenCalled();
	});

	it('collapses the group of sessions outside every repo too', () => {
		show([row(1), row(2, { cwd: '/tmp/elsewhere' })], ['/tmp/repo']);
		expect(header('other').title).toBe('other');
		expect(target.querySelector('button[aria-label="Repo menu"]')).not.toBeNull();
		expect(target.querySelectorAll('button[aria-label="Repo menu"]')).toHaveLength(1);
		click(header('other'));
		expect(rowCount()).toBe(1);
		expect(header('repo').getAttribute('aria-expanded')).toBe('true');
	});

	it('starts claude or codex in the repo from its header', () => {
		const p = show([], ['/tmp/repo']);
		click(button('Start claude in /tmp/repo'));
		expect(p.onstart).toHaveBeenCalledWith('/tmp/repo', 'claude');
		click(button('Start codex in /tmp/repo'));
		expect(p.onstart).toHaveBeenCalledWith('/tmp/repo', 'codex');
		p.disabled = true;
		flushSync();
		expect(button('Start claude in /tmp/repo').disabled).toBe(true);
		expect(button('Start codex in /tmp/repo').disabled).toBe(true);
	});

	it('opens the repo menu from ⋯, below it', () => {
		show([], ['/tmp/repo']);
		const more = button('Repo menu');
		expect(more.getAttribute('aria-haspopup')).toBe('menu');
		expect(more.getAttribute('aria-expanded')).toBe('false');
		click(more);
		expect(menu()).not.toBeNull();
		expect(items().map((b) => b.textContent?.trim())).toEqual(['New Claude session', 'New Codex session', 'New shell', 'Remove repo']);
		expect(item('Remove repo').classList.contains('danger')).toBe(true);
		expect(more.getAttribute('aria-expanded')).toBe('true');
	});

	it('opens the repo menu at the pointer on a right-click on the header, and never the webview menu', () => {
		show([row(2, { cwd: '/tmp/elsewhere' })], ['/tmp/repo']);
		const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
		header('repo').dispatchEvent(e);
		flushSync();
		expect(e.defaultPrevented).toBe(true);
		expect(menu()!.style.left).toBe('30px');
		expect(menu()!.style.top).toBe('40px');
		expect(button('Repo menu').getAttribute('aria-expanded')).toBe('true');
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		flushSync();
		expect(menu()).toBeNull();
		// The group without a repo has no menu.
		const o = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		header('other').dispatchEvent(o);
		flushSync();
		expect(o.defaultPrevented).toBe(true);
		expect(menu()).toBeNull();
	});

	it('closes the open repo menu on a click on its ⋯, and opens it on the next', () => {
		show([], ['/tmp/repo']);
		const more = button('Repo menu');
		press(more);
		expect(menu()).not.toBeNull();
		press(more);
		expect(menu()).toBeNull();
		expect(more.getAttribute('aria-expanded')).toBe('false');
		press(more);
		expect(menu()).not.toBeNull();
		// A press elsewhere closes it; a click on ⋯ from the keyboard then opens it.
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		flushSync();
		expect(menu()).toBeNull();
		click(more);
		expect(menu()).not.toBeNull();
	});

	it('starts a shell from the menu, and closes it', () => {
		const p = show([], ['/tmp/repo']);
		click(button('Repo menu'));
		click(item('New shell'));
		expect(p.onstart).toHaveBeenCalledWith('/tmp/repo', '');
		expect(menu()).toBeNull();
		click(button('Repo menu'));
		click(item('New Claude session'));
		expect(p.onstart).toHaveBeenLastCalledWith('/tmp/repo', 'claude');
		click(button('Repo menu'));
		click(item('New Codex session'));
		expect(p.onstart).toHaveBeenLastCalledWith('/tmp/repo', 'codex');
	});

	it('removes the repo on a second click on Remove repo only', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const p = show([], ['/tmp/repo']);
		click(button('Repo menu'));
		click(item('Remove repo'));
		expect(p.onremoverepo).not.toHaveBeenCalled();
		expect(item('Confirm remove repo?')).not.toBeUndefined();
		now = 500;
		click(item('Confirm remove repo?'));
		expect(p.onremoverepo).toHaveBeenCalledTimes(1);
		expect(p.onremoverepo).toHaveBeenCalledWith('/tmp/repo');
		expect(menu()).toBeNull();
	});

	it('disables the start items while disabled, but not Remove repo', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const p = show([], ['/tmp/repo']);
		p.disabled = true;
		flushSync();
		click(button('Repo menu'));
		expect(items().map((b) => b.getAttribute('aria-disabled'))).toEqual(['true', 'true', 'true', null]);
		for (const label of ['New Claude session', 'New Codex session', 'New shell']) click(item(label));
		expect(p.onstart).not.toHaveBeenCalled();
		expect(menu()).not.toBeNull();
		click(item('Remove repo'));
		now = 500;
		click(item('Confirm remove repo?'));
		expect(p.onremoverepo).toHaveBeenCalledWith('/tmp/repo');
	});
});

describe('SessionList session menu', () => {
	const menu = () => target.querySelector<HTMLElement>('[role="menu"]');
	const items = () => [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
	const labels = () => items().map((b) => b.textContent?.trim());
	const item = (label: string) => items().find((b) => b.textContent?.trim() === label)!;
	function click(el: HTMLElement) {
		el.click();
		flushSync();
	}
	// On the title, which WebKit leaves the row's button unfocused for.
	function rightClick(i = 0, x = 0, y = 0): MouseEvent {
		const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y });
		titles()[i].dispatchEvent(e);
		flushSync();
		return e;
	}

	it('opens at the pointer on a right-click on a row, from the row, and never the webview menu', () => {
		show([row(1), row(2)]);
		const e = rightClick(1, 30, 40);
		expect(e.defaultPrevented).toBe(true);
		expect(menu()!.style.left).toBe('30px');
		expect(menu()!.style.top).toBe('40px');
		// No Reveal in Finder outside Tauri.
		expect(labels()).toEqual(['Rename', 'Copy path', 'Kill']);
		expect(item('Kill').classList.contains('danger')).toBe(true);
		const actions = [...target.querySelectorAll('button[aria-label="Kill"]')].map((b) => b.parentElement!);
		expect(actions.map((a) => a.classList.contains('open'))).toEqual([false, true]);
		menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		flushSync();
		expect(menu()).toBeNull();
		expect(document.activeElement).toBe(target.querySelectorAll('button.row')[1]);
	});

	it('closes when its row goes, its incarnation or restorable state changes, or availability changes', () => {
		const p = show([row(1), row(2)]);
		const open = (i = 0) => {
			rightClick(i);
			expect(menu()).not.toBeNull();
		};
		open();
		p.sessions = [row(1), row(2, { cwd: '/tmp/other' })];
		flushSync();
		expect(menu()).not.toBeNull();
		p.sessions = [row(1, { inc: 'j' }), row(2)];
		flushSync();
		expect(menu()).toBeNull();
		open();
		p.sessions = [row(1, { inc: 'j', restorable: true, state: 'exited' }), row(2)];
		flushSync();
		expect(menu()).toBeNull();
		open();
		expect(labels()).toEqual(['Rename', 'Copy path', 'Reopen', 'Dismiss']);
		p.disabled = true;
		flushSync();
		expect(menu()).toBeNull();
		open();
		p.sessions = [row(2)];
		flushSync();
		expect(menu()).toBeNull();
	});

	it('closes the repo menu when its repo is removed', () => {
		const p = show([], ['/tmp/repo']);
		click(target.querySelector<HTMLElement>('button[aria-label="Repo menu"]')!);
		expect(menu()).not.toBeNull();
		p.repos = [];
		flushSync();
		expect(menu()).toBeNull();
	});

	it('opens no menu on a row whose name is being edited, leaving the input its own', () => {
		show([row(1)]);
		const el = edit();
		const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		el.dispatchEvent(e);
		flushSync();
		expect(e.defaultPrevented).toBe(false);
		expect(menu()).toBeNull();
		expect(document.activeElement).toBe(el);
	});

	it('renames from the menu', () => {
		show([row(1, { name: 'w' })]);
		rightClick();
		click(item('Rename'));
		expect(menu()).toBeNull();
		expect(input()!.value).toBe('w');
		expect(document.activeElement).toBe(input());
	});

	it('copies the path from the menu, and reports a failure', async () => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		const p = show([row(1, { cwd: '/tmp/repo/a' })]);
		rightClick();
		click(item('Copy path'));
		expect(write).toHaveBeenCalledWith('/tmp/repo/a');
		expect(menu()).toBeNull();
		write.mockRejectedValueOnce(new Error('denied'));
		rightClick();
		click(item('Copy path'));
		await vi.waitFor(() => expect(p.onreport).toHaveBeenCalledWith('copy path failed: denied'));
	});

	it('disables Copy path for a session without a folder', () => {
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
		show([row(1, { cwd: '' })]);
		rightClick();
		expect(item('Copy path').getAttribute('aria-disabled')).toBe('true');
		click(item('Copy path'));
		expect(write).not.toHaveBeenCalled();
		expect(menu()).not.toBeNull();
	});

	it('kills on a second click on Kill only, keeping the menu open in between', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const p = show([row(1), row(2)]);
		rightClick(1);
		click(item('Kill'));
		expect(p.onkill).not.toHaveBeenCalled();
		expect(menu()).not.toBeNull();
		now = 500;
		click(item('Confirm kill?'));
		expect(p.onkill).toHaveBeenCalledTimes(1);
		expect(p.onkill).toHaveBeenCalledWith(2);
		expect(menu()).toBeNull();
	});

	it('offers Reopen and Dismiss for an old session instead of Kill', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const p = show([row(3, { restorable: true, state: 'exited' })]);
		rightClick();
		expect(labels()).toEqual(['Rename', 'Copy path', 'Reopen', 'Dismiss']);
		click(item('Reopen'));
		expect(p.onreopen).toHaveBeenCalledWith(3);
		rightClick();
		click(item('Dismiss'));
		expect(p.ondismiss).not.toHaveBeenCalled();
		now = 500;
		click(item('Confirm dismiss?'));
		expect(p.ondismiss).toHaveBeenCalledWith(3);
		p.disabled = true;
		flushSync();
		rightClick();
		expect(item('Reopen').getAttribute('aria-disabled')).toBe('true');
		click(item('Reopen'));
		expect(p.onreopen).toHaveBeenCalledTimes(1);
	});

	describe('inside Tauri', () => {
		const internals = window as unknown as { __TAURI_INTERNALS__?: object };
		beforeEach(() => {
			internals.__TAURI_INTERNALS__ = {};
			opener.revealItemInDir.mockClear();
		});
		afterEach(() => {
			delete internals.__TAURI_INTERNALS__;
		});

		it('reveals a row or a repo in Finder, and reports a failure', async () => {
			const p = show([row(1, { cwd: '/tmp/repo/a' }), row(2, { cwd: '' })], ['/tmp/repo']);
			rightClick(0);
			expect(labels()).toEqual(['Rename', 'Copy path', 'Reveal in Finder', 'Kill']);
			click(item('Reveal in Finder'));
			await vi.waitFor(() => expect(opener.revealItemInDir).toHaveBeenCalledWith('/tmp/repo/a'));
			click(target.querySelector<HTMLButtonElement>('button[aria-label="Repo menu"]')!);
			expect(labels()).toEqual(['New Claude session', 'New Codex session', 'New shell', 'Reveal in Finder', 'Remove repo']);
			click(item('Reveal in Finder'));
			await vi.waitFor(() => expect(opener.revealItemInDir).toHaveBeenLastCalledWith('/tmp/repo'));
			opener.revealItemInDir.mockRejectedValueOnce(new Error('no such file'));
			rightClick(0);
			click(item('Reveal in Finder'));
			await vi.waitFor(() => expect(p.onreport).toHaveBeenCalledWith('reveal in Finder failed: no such file'));
			rightClick(1);
			expect(item('Reveal in Finder').getAttribute('aria-disabled')).toBe('true');
		});
	});
});

describe('SessionList empty-area menu', () => {
	const list = () => target.querySelector<HTMLElement>('ul')!;
	const menu = () => target.querySelector<HTMLElement>('[role="menu"]');
	const labels = () => [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((b) => b.textContent?.trim());
	const item = (label: string) => [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.trim() === label)!;
	function rightClick(el: HTMLElement, x = 0, y = 0): MouseEvent {
		const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y });
		el.dispatchEvent(e);
		flushSync();
		return e;
	}
	function click(el: HTMLElement) {
		el.click();
		flushSync();
	}

	it('offers Add repo and New session on a right-click on the empty space, at the pointer', () => {
		const p = show([row(1)], ['/tmp/repo']);
		const e = rightClick(list(), 30, 40);
		expect(e.defaultPrevented).toBe(true);
		expect(labels()).toEqual(['Add repo…', 'New session…']);
		expect(menu()!.style.left).toBe('30px');
		expect(menu()!.style.top).toBe('40px');
		click(item('Add repo…'));
		expect(p.onaddrepo).toHaveBeenCalledTimes(1);
		expect(menu()).toBeNull();
		rightClick(list());
		click(item('New session…'));
		expect(p.onnewsession).toHaveBeenCalledTimes(1);
		expect(p.onaddrepo).toHaveBeenCalledTimes(1);
		expect(menu()).toBeNull();
	});

	it('disables Add repo as the + button is, but not New session', () => {
		const p = show([row(1)]);
		p.addDisabled = true;
		flushSync();
		rightClick(list());
		expect(item('Add repo…').getAttribute('aria-disabled')).toBe('true');
		expect(item('New session…').getAttribute('aria-disabled')).toBeNull();
		click(item('Add repo…'));
		expect(p.onaddrepo).not.toHaveBeenCalled();
	});

	it('offers them in an empty list too', () => {
		show([]);
		rightClick(list());
		expect(labels()).toEqual(['Add repo…', 'New session…']);
	});

	it('still opens the session menu on a row and the repo menu on a header', () => {
		show([row(1)], ['/tmp/repo']);
		rightClick(titles()[0]);
		expect(labels()).toEqual(['Rename', 'Copy path', 'Kill']);
		rightClick(target.querySelector<HTMLElement>('button[aria-expanded]:not([aria-haspopup])')!);
		expect(labels()).toEqual(['New Claude session', 'New Codex session', 'New shell', 'Remove repo']);
	});
});
