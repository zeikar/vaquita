<script lang="ts">
	import type { Terminal } from '@xterm/xterm';
	import { onDestroy } from 'svelte';
	import { setApp } from './lib/app-context';
	import { DaemonConnection } from './lib/connection';
	import Content from './lib/Content.svelte';
	import { appBuild, checkRestart, daemonOnDisk, readEndpoint, restartDaemon, startDaemon } from './lib/endpoint';
	import { watchFileDrop } from './lib/file-drop';
	import FilesAside from './lib/FilesAside.svelte';
	import { Layout } from './lib/layout.svelte';
	import { SessionManager } from './lib/manager';
	import NewSessionDialog from './lib/NewSessionDialog.svelte';
	import Notices from './lib/Notices.svelte';
	import type { Notifier } from './lib/notify';
	import { isSessionTab } from './lib/session-tabs';
	import Sidebar from './lib/Sidebar.svelte';
	import StatusBar from './lib/StatusBar.svelte';
	import { Tabs } from './lib/tabs.svelte';
	import { watchMenu, windowShortcut } from './lib/shortcuts';
	import { Startup } from './lib/startup.svelte';
	import { createTerminal, TermView } from './lib/term-view';

	// Replaced by the Tauri notifier once it is ready; the console one stays in
	// a plain browser and when the Tauri one cannot be set up.
	let notifier: Notifier = { show: (n) => console.info('notification', n) };
	const manager = new SessionManager({
		readEndpoint,
		startDaemon,
		appBuild,
		daemonOnDisk,
		checkRestart,
		restartDaemon,
		connect: (endpoint, handlers) => new DaemonConnection(endpoint, handlers),
		createTerminal: (cols, rows) => createTerminal(cols, rows),
		createView: (term, core, cwd) =>
			new TermView(term, core, (m, tone) => manager.report(m, tone), cwd, (path) => tabs.openFile(cwd, path), () => tabs.active !== undefined && isSessionTab(tabs.active)),
		notifier: { show: (n) => notifier.show(n) },
	});
	// Typed, as the manager's views read it: inferred, its type and the
	// manager's would each wait on the other.
	const tabs: Tabs<Terminal, TermView> = new Tabs({ manager });
	onDestroy(() => tabs.stop());
	const layout = new Layout(tabs);
	const startup = new Startup({ manager, tabs, useNotifier: (n) => (notifier = n) });
	onDestroy(() => startup.stop());
	setApp({ manager, tabs, layout, startup });
	const shortcut = windowShortcut(tabs, layout);
	onDestroy(watchMenu(tabs, layout, manager));
	onDestroy(watchFileDrop(manager, tabs, () => layout.sidebar));
</script>

<svelte:window onkeydowncapture={shortcut} />

<main class:sidebar-hidden={layout.sidebarHidden} class:files-hidden={!layout.panelShown} style:--sidebar-width="{layout.sidebarWidth}px" style:--panel-width="{layout.panelWidth}px">
	<Sidebar />
	<NewSessionDialog
		open={tabs.dialogOpen}
		repos={$manager.repos}
		defaultCwd={tabs.dialogCwd}
		disabled={$manager.creating || $manager.status !== 'connected'}
		oncreate={(cwd, cmd, name) => manager.create(cwd, cmd, name)}
		onclose={() => (tabs.dialogOpen = false)}
		fallbackFocus={tabs.focusContent}
	/>
	<Content />
	<!-- Unmounted, not hidden, while it is off, so nothing of the tree or the
	     changes runs and no folder is watched. -->
	{#if layout.panelShown}
		<FilesAside />
	{/if}
	<Notices />
	<StatusBar />
</main>
