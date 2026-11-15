// @vitest-environment happy-dom
// Named .svelte.test.ts for the fake layout's $state, which the buttons' titles follow.
import { flushSync, mount, unmount } from 'svelte';
import { writable } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP, type AppContext } from './app-context';
import type { Status } from './daemon-link';
import type { ManagerState } from './manager';
import StatusBar from './StatusBar.svelte';

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;

afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target.remove();
});

const base: ManagerState = { status: 'connected', sessions: [], repos: [], reposListed: true, creating: false, focused: true };

// The manager as a store, the layout as state: what the status line reads of each.
function show(state: Partial<ManagerState> = {}) {
	const store = writable<ManagerState>({ ...base, ...state });
	const manager = { subscribe: store.subscribe, dismissReport: vi.fn(() => store.update((s) => ({ ...s, report: undefined }))) };
	const layout = $state({ sidebarHidden: false, panelHidden: false, toggleSidebar: vi.fn(), togglePanel: vi.fn() });
	const ctx = { manager, tabs: {}, layout } as unknown as AppContext;
	target = document.createElement('div');
	document.body.append(target);
	shown = mount(StatusBar, { target, context: new Map([[APP, ctx]]) });
	flushSync();
	const set = (s: Partial<ManagerState>) => {
		store.update((old) => ({ ...old, ...s }));
		flushSync();
	};
	return { manager, layout, set };
}

const state = () => target.querySelector('.state')!;
const dot = () => target.querySelector('.state .dot')!;

describe('StatusBar', () => {
	it.each<[Status, string, string]>([
		['connected', 'connected', 'ok'],
		['connecting', 'connecting…', 'wait'],
		['starting', 'starting daemon…', 'wait'],
		['restarting', 'restarting daemon…', 'wait'],
		['not-running', 'daemon not running', 'bad'],
		['version-mismatch', 'daemon restart needed (daemon v2, app v1)', 'bad'],
		['disconnected', 'disconnected, retrying…', 'wait'],
	])('shows %s as its text with a %s dot', (status, text, tone) => {
		show({ status, daemonV: 2 });
		expect(state().textContent).toBe(text);
		expect(dot().classList.contains(tone)).toBe(true);
	});

	it('counts the sessions and follows the manager', () => {
		const { set } = show();
		expect(target.textContent).toContain('0 sessions');
		set({ sessions: [{}, {}, {}] as ManagerState['sessions'] });
		expect(target.textContent).toContain('3 sessions');
		set({ status: 'disconnected' });
		expect(state().textContent).toBe('disconnected, retrying…');
	});

	it('shows the message with its title', () => {
		const { set } = show();
		expect(target.querySelector('.message')).toBeNull();
		set({ message: 'daemon exited' });
		const m = target.querySelector('.message')!;
		expect(m.textContent).toBe('daemon exited');
		expect(m.getAttribute('title')).toBe('daemon exited');
	});

	it('shows a report with its tone, dismissed by a click', () => {
		const { manager, set } = show({ report: { text: 'saved', tone: 'info' } });
		let r = target.querySelector<HTMLButtonElement>('button.report')!;
		expect(r.textContent).toBe('saved');
		expect(r.getAttribute('title')).toBe('saved');
		expect(r.classList.contains('info')).toBe(true);
		set({ report: { text: 'open failed', tone: 'error' } });
		r = target.querySelector<HTMLButtonElement>('button.report')!;
		expect(r.classList.contains('error')).toBe(true);
		r.click();
		flushSync();
		expect(manager.dismissReport).toHaveBeenCalledTimes(1);
		expect(target.querySelector('button.report')).toBeNull();
	});

	it('calls the layout from each toggle, titled Show or Hide', () => {
		const { layout } = show();
		const sidebar = target.querySelector<HTMLButtonElement>('button.sidebar-toggle')!;
		const files = target.querySelector<HTMLButtonElement>('button.files-toggle')!;
		expect(sidebar.title).toBe('Hide sidebar (⌘B)');
		expect(files.title).toBe('Hide files (⌥⌘B)');
		sidebar.click();
		expect(layout.toggleSidebar).toHaveBeenCalledTimes(1);
		files.click();
		expect(layout.togglePanel).toHaveBeenCalledTimes(1);
		layout.sidebarHidden = true;
		layout.panelHidden = true;
		flushSync();
		expect(sidebar.title).toBe('Show sidebar (⌘B)');
		expect(files.title).toBe('Show files (⌥⌘B)');
	});
});
