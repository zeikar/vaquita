// @vitest-environment happy-dom
// Named .svelte.test.ts so that the store's runes compile; in the client
// build, the one the app runs, as vitest makes the server one for node.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_HIDDEN, PANEL_WIDTH } from './file-panel';
import { showView } from './FilesPanel.svelte';
import { holdLayout, layoutHeld } from './layout-hold';
import { Layout, type LayoutTabs } from './layout.svelte';
import { SIDEBAR_HIDDEN, SIDEBAR_WIDTH } from './sidebar';

vi.mock('./FilesPanel.svelte', () => ({ showView: vi.fn() }));

let store: Map<string, string>;
beforeEach(() => {
	store = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.mocked(showView).mockClear();
	holdLayout(false);
});

const repo = '/tmp/repo';

// The tabs as far as Layout uses them; group is state, as the store's is.
function make() {
	const view = { refit: vi.fn() };
	const filePane = { relayout: vi.fn() };
	const tabs = $state({ group: repo as string | undefined, refocus: vi.fn(), selectedView: () => view, filePane });
	const layout = new Layout(tabs as unknown as LayoutTabs);
	return { tabs, view, filePane, layout };
}

describe('Layout', () => {
	it('loads the stored widths and hidden flags', () => {
		store.set(SIDEBAR_WIDTH, '320');
		store.set(SIDEBAR_HIDDEN, 'true');
		store.set(PANEL_WIDTH, '300');
		store.set(PANEL_HIDDEN, 'true');
		const { layout } = make();
		expect(layout.sidebarWidth).toBe(320);
		expect(layout.sidebarHidden).toBe(true);
		expect(layout.panelWidth).toBe(300);
		expect(layout.panelHidden).toBe(true);
		expect(layout.panelShown).toBe(false);
	});

	it('starts from the defaults with nothing stored', () => {
		const { layout } = make();
		expect(layout.sidebarWidth).toBe(280);
		expect(layout.sidebarHidden).toBe(false);
		expect(layout.panelWidth).toBe(260);
		expect(layout.panelHidden).toBe(false);
		expect(layout.panelShown).toBe(true);
	});

	it('flips, stores and refocuses on each toggle', () => {
		const { tabs, layout } = make();
		layout.toggleSidebar();
		expect(layout.sidebarHidden).toBe(true);
		expect(store.get(SIDEBAR_HIDDEN)).toBe('true');
		expect(tabs.refocus).toHaveBeenCalledTimes(1);
		layout.toggleSidebar();
		expect(layout.sidebarHidden).toBe(false);
		expect(store.get(SIDEBAR_HIDDEN)).toBe('false');
		expect(tabs.refocus).toHaveBeenCalledTimes(2);

		layout.togglePanel();
		expect(layout.panelHidden).toBe(true);
		expect(layout.panelShown).toBe(false);
		expect(store.get(PANEL_HIDDEN)).toBe('true');
		expect(tabs.refocus).toHaveBeenCalledTimes(3);
		layout.togglePanel();
		expect(layout.panelShown).toBe(true);
		expect(store.get(PANEL_HIDDEN)).toBe('false');
		expect(tabs.refocus).toHaveBeenCalledTimes(4);
	});

	it('shows no panel with no group, whatever is stored', () => {
		store.set(PANEL_HIDDEN, 'false');
		const { tabs, layout } = make();
		tabs.group = undefined;
		expect(layout.panelShown).toBe(false);
		tabs.group = repo;
		expect(layout.panelShown).toBe(true);
		tabs.group = undefined;
		expect(layout.panelShown).toBe(false);
		expect(layout.panelHidden).toBe(false);
	});

	it('releases the hold, refits, relays out and stores the width once an edge is let go', () => {
		const { view, filePane, layout } = make();
		holdLayout(true);
		layout.sidebarWidth = 340;
		layout.sidebarResized();
		expect(layoutHeld()).toBe(false);
		expect(view.refit).toHaveBeenCalledTimes(1);
		expect(filePane.relayout).toHaveBeenCalledTimes(1);
		expect(store.get(SIDEBAR_WIDTH)).toBe('340');

		holdLayout(true);
		layout.panelWidth = 400;
		layout.panelResized();
		expect(layoutHeld()).toBe(false);
		expect(view.refit).toHaveBeenCalledTimes(2);
		expect(filePane.relayout).toHaveBeenCalledTimes(2);
		expect(store.get(PANEL_WIDTH)).toBe('400');
	});

	it('shows Past and un-hides only a hidden panel', () => {
		const { tabs, layout } = make();
		layout.showPast();
		expect(showView).toHaveBeenCalledWith('past');
		expect(layout.panelHidden).toBe(false);
		expect(tabs.refocus).not.toHaveBeenCalled();

		layout.panelHidden = true;
		layout.showPast();
		expect(showView).toHaveBeenCalledTimes(2);
		expect(layout.panelHidden).toBe(false);
		expect(store.get(PANEL_HIDDEN)).toBe('false');
		expect(tabs.refocus).toHaveBeenCalledTimes(1);
	});
});
