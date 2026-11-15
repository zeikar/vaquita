<script lang="ts">
	import { getApp } from './app-context';
	import { tabFile } from './changes';
	import { clampPanelWidth, PANEL_DEFAULT_WIDTH } from './file-panel';
	import FilesPanel from './FilesPanel.svelte';
	import { holdLayout } from './layout-hold';
	import { isSessionTab } from './session-tabs';
	import SidebarEdge from './SidebarEdge.svelte';
	import { WELCOME } from './tabs';

	const { manager, tabs, layout, startup } = getApp();
</script>

<aside class="files">
	<FilesPanel
		root={tabs.root}
		cwd={tabs.selectedRow?.info.cwd}
		home={startup.home}
		connected={$manager.status === 'connected'}
		creating={$manager.creating}
		sessions={$manager.sessions.map((r) => r.info)}
		repos={$manager.repos}
		highlight={tabs.active === undefined || tabs.active === WELCOME || isSessionTab(tabs.active) ? undefined : tabFile(tabs.active)}
		onopen={tabs.openFromTree}
		onopendiff={tabs.openDiff}
		onaddrepo={(f) => manager.addRepo(f)}
		onresume={(cwd, cmd) => void manager.create(cwd, cmd, '')}
		onselect={tabs.selectSession}
		onreopen={(sid) => manager.reopen(sid)}
		onleave={tabs.refocus}
		report={(m) => manager.report(m)}
	/>
	<SidebarEdge
		side="left"
		clamp={clampPanelWidth}
		defaultWidth={PANEL_DEFAULT_WIDTH}
		label="Resize files panel"
		width={layout.panelWidth}
		onstart={() => holdLayout(true)}
		onresize={(w) => (layout.panelWidth = w)}
		onend={layout.panelResized}
	/>
</aside>
