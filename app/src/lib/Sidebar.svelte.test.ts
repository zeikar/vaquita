// @vitest-environment happy-dom
// Named .svelte.test.ts for the fake tabs' $state, as the store's are.
import { flushSync, mount, unmount } from 'svelte';
import { writable } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP, type AppContext } from './app-context';
import { Layout, type LayoutTabs } from './layout.svelte';
import type { ManagerState } from './manager';
import Sidebar from './Sidebar.svelte';
import { SIDEBAR_WIDTH } from './sidebar';

vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }));

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;

afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target.remove();
});

const base: ManagerState = { status: 'connected', sessions: [], repos: [], reposListed: true, creating: false, focused: true };

// The real Layout, as the refs it is given are what this pins down.
function show(state: Partial<ManagerState> = {}) {
	const store = writable<ManagerState>({ ...base, ...state });
	const manager = { subscribe: store.subscribe, addRepo: vi.fn(), report: vi.fn() };
	const tabs = $state({
		group: undefined as string | undefined,
		selectedRow: undefined,
		groups: {},
		selectSession: vi.fn(),
		openOther: vi.fn(),
		openWelcome: vi.fn(),
		newSession: vi.fn(),
		refocus: vi.fn(),
		selectedView: () => undefined,
		filePane: undefined,
	});
	const layout = new Layout(tabs as unknown as LayoutTabs);
	const ctx = { manager, tabs, layout, startup: { home: undefined } } as unknown as AppContext;
	target = document.createElement('div');
	document.body.append(target);
	shown = mount(Sidebar, { target, context: new Map([[APP, ctx]]) });
	flushSync();
	return { manager, tabs, layout };
}

const pathInput = () => target.querySelector<HTMLInputElement>('input[placeholder="repo path"]');

describe('Sidebar', () => {
	it("binds the layout's sidebar to its aside, which the file drop measures", () => {
		const { layout } = show();
		expect(layout.sidebar).toBe(target.querySelector('aside'));
		unmount(shown!);
		shown = undefined;
		expect(layout.sidebar).toBeNull();
	});

	it("binds the layout's addRepo to the header's AddRepo, which the app welcome opens", async () => {
		const { layout, manager } = show();
		expect(pathInput()).toBeNull();
		await layout.addRepo!.open();
		flushSync();
		const input = pathInput()!;
		input.value = '/tmp/repo';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(manager.addRepo).toHaveBeenCalledWith('/tmp/repo');
	});

	it("opens the same AddRepo from the list's Add repo…", () => {
		show();
		target.querySelector('ul')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		flushSync();
		[...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.trim() === 'Add repo…')!.click();
		flushSync();
		expect(pathInput()).not.toBeNull();
	});

	it('disables adding while not connected', () => {
		show({ status: 'disconnected' });
		expect(target.querySelector<HTMLButtonElement>('button[aria-label="Add repo"]')!.disabled).toBe(true);
	});

	it('starts a new session from its footer', () => {
		const { tabs } = show();
		target.querySelector<HTMLButtonElement>('button.new-session')!.click();
		expect(tabs.newSession).toHaveBeenCalledTimes(1);
	});

	it("sets the layout's width from its edge and stores it", () => {
		const { layout } = show();
		layout.sidebarWidth = 350;
		target.querySelector<HTMLElement>('[role="separator"][aria-label="Resize sidebar"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(layout.sidebarWidth).toBe(280);
		expect(localStorage.getItem(SIDEBAR_WIDTH)).toBe('280');
	});
});
