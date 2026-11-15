import { loadPanelWidth, PANEL_HIDDEN, PANEL_WIDTH } from './file-panel';
import { showView } from './FilesPanel.svelte';
import { holdLayout } from './layout-hold';
import { loadWidth, SIDEBAR_HIDDEN, SIDEBAR_WIDTH } from './sidebar';
import { load, save } from './storage';
import type { Tabs } from './tabs.svelte';

export type LayoutTabs = Pick<Tabs, 'group' | 'refocus' | 'selectedView' | 'filePane'>;

// The sidebar's and the files panel's widths and whether each is hidden,
// remembered across launches.
export class Layout {
	private readonly tabs: LayoutTabs;
	sidebarWidth = $state(loadWidth());
	sidebarHidden = $state(load(SIDEBAR_HIDDEN) === 'true');
	panelWidth = $state(loadPanelWidth());
	panelHidden = $state(load(PANEL_HIDDEN) === 'true');
	// With nothing selected the panel would have no repo to show, and the app
	// welcome is drawn without it; the stored choice is kept for later. A
	// function, as the constructor sets tabs after the fields.
	readonly panelShown = $derived.by(() => !this.panelHidden && this.tabs.group !== undefined);

	constructor(tabs: LayoutTabs) {
		this.tabs = tabs;
	}

	// The content takes the focus, which would otherwise be lost in a hidden
	// sidebar or left on the status line's button.
	toggleSidebar = (): void => {
		this.sidebarHidden = !this.sidebarHidden;
		save(SIDEBAR_HIDDEN, String(this.sidebarHidden));
		this.tabs.refocus();
	};

	sidebarResized = (): void => {
		holdLayout(false);
		this.tabs.selectedView()?.refit();
		this.tabs.filePane?.relayout();
		save(SIDEBAR_WIDTH, String(this.sidebarWidth));
	};

	// As toggleSidebar: the focus may be in the tree, which goes.
	togglePanel = (): void => {
		this.panelHidden = !this.panelHidden;
		save(PANEL_HIDDEN, String(this.panelHidden));
		this.tabs.refocus();
	};

	// The welcome's "All past conversations": the panel's Past view, shown.
	showPast = (): void => {
		showView('past');
		if (this.panelHidden) this.togglePanel();
	};

	panelResized = (): void => {
		holdLayout(false);
		this.tabs.selectedView()?.refit();
		this.tabs.filePane?.relayout();
		save(PANEL_WIDTH, String(this.panelWidth));
	};
}
