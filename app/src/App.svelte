<script lang="ts">
	import type { Terminal } from '@xterm/xterm';
	import { onDestroy } from 'svelte';
	import { setApp } from './lib/app-context';
	import AppWelcome from './lib/AppWelcome.svelte';
	import { DaemonConnection } from './lib/connection';
	import { appBuild, checkRestart, daemonOnDisk, readEndpoint, restartDaemon, startDaemon } from './lib/endpoint';
	import { watchFileDrop } from './lib/file-drop';
	import FilePane from './lib/FilePane.svelte';
	import FilesAside from './lib/FilesAside.svelte';
	import { Layout } from './lib/layout.svelte';
	import { SessionManager } from './lib/manager';
	import NewSessionDialog from './lib/NewSessionDialog.svelte';
	import Notices from './lib/Notices.svelte';
	import type { Notifier } from './lib/notify';
	import RepoWelcome from './lib/RepoWelcome.svelte';
	import { isSessionTab } from './lib/session-tabs';
	import Sidebar from './lib/Sidebar.svelte';
	import StatusBar from './lib/StatusBar.svelte';
	import TabBar from './lib/TabBar.svelte';
	import { WELCOME } from './lib/tabs';
	import { Tabs } from './lib/tabs.svelte';
	import TerminalPane from './lib/TerminalPane.svelte';
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
	<section class="content">
		<!-- No bar with nothing in it: a repo's welcome alone starts at the top, as the app welcome does. -->
		{#if tabs.group !== undefined && tabs.groupTabs.length > 0}
			<TabBar
				sessions={$manager.sessions}
				tabs={tabs.groupTabs}
				active={tabs.active}
				preview={tabs.previews[tabs.group]}
				dirty={tabs.dirty}
				onselect={(p) => void tabs.show(p)}
				onclose={(ps) => void tabs.close(ps)}
				onpin={(p) => tabs.pin(p)}
				onreorder={tabs.reorder}
				onnew={tabs.newSession}
				report={(m) => manager.report(m)}
			/>
		{/if}
		<div class="stack">
			<TerminalPane sessions={$manager.sessions} selected={$manager.selected} />
			{#if tabs.active === WELCOME && tabs.root !== undefined}
				{@const repo = tabs.root}
				<!-- Keyed, so another repo's welcome reads its own changes and past conversations. -->
				{#key repo}
					<RepoWelcome
						bind:this={tabs.repoWelcome}
						{repo}
						home={startup.home}
						sessions={$manager.sessions.map((r) => r.info)}
						repos={$manager.repos}
						connected={$manager.status === 'connected'}
						creating={$manager.creating}
						onstart={(cmd) => manager.create(repo, cmd, '')}
						onallpast={layout.showPast}
						onresume={(cwd, cmd) => void manager.create(cwd, cmd, '')}
						onselect={tabs.selectSession}
						onreopen={(sid) => manager.reopen(sid)}
						report={(m) => manager.report(m)}
					/>
				{/key}
			{:else if tabs.active !== undefined && !isSessionTab(tabs.active)}
				{@const path = tabs.active}
				<FilePane bind:this={tabs.filePane} {path} repo={tabs.root} home={startup.home} readOnly={startup.updating} onclose={() => void tabs.close([path])} onopenfile={(p) => tabs.openFromTree(p)} report={(m) => manager.report(m)} />
			{/if}
			{#if tabs.group === undefined}
				<AppWelcome bind:this={tabs.appWelcome} version={startup.version} addDisabled={$manager.status !== 'connected'} onaddrepo={() => void layout.addRepo?.open()} onnewsession={tabs.newSession} />
			{/if}
		</div>
	</section>
	<!-- Unmounted, not hidden, while it is off, so nothing of the tree or the
	     changes runs and no folder is watched. -->
	{#if layout.panelShown}
		<FilesAside />
	{/if}
	<Notices />
	<StatusBar />
</main>
