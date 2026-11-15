<script lang="ts">
	import { getCurrentWebview } from '@tauri-apps/api/webview';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import type { Terminal } from '@xterm/xterm';
	import { onDestroy } from 'svelte';
	import AddRepo from './lib/AddRepo.svelte';
	import { setApp } from './lib/app-context';
	import AppUpdateBanner from './lib/AppUpdateBanner.svelte';
	import AppWelcome from './lib/AppWelcome.svelte';
	import { releaseUrl } from './lib/app-update';
	import { tabFile } from './lib/changes';
	import { DaemonConnection } from './lib/connection';
	import { runningCount } from './lib/daemon-update';
	import { appBuild, checkRestart, daemonOnDisk, readEndpoint, restartDaemon, startDaemon } from './lib/endpoint';
	import { clampPanelWidth, PANEL_DEFAULT_WIDTH } from './lib/file-panel';
	import FilePane from './lib/FilePane.svelte';
	import FilesPanel from './lib/FilesPanel.svelte';
	import { onTabAsked } from './lib/files';
	import { watchFocus } from './lib/focus';
	import Icon from './lib/Icon.svelte';
	import { isNewSessionShortcut, isNextTabShortcut, isPrevTabShortcut, isSaveShortcut, isSidebarShortcut, tabNumber } from './lib/keys';
	import { holdLayout } from './lib/layout-hold';
	import { Layout } from './lib/layout.svelte';
	import { openExternal } from './lib/links';
	import { SessionManager } from './lib/manager';
	import NewSessionDialog from './lib/NewSessionDialog.svelte';
	import type { Notifier, Target } from './lib/notify';
	import RepoWelcome from './lib/RepoWelcome.svelte';
	import { isSessionTab, sessionTab } from './lib/session-tabs';
	import SessionList from './lib/SessionList.svelte';
	import SidebarEdge from './lib/SidebarEdge.svelte';
	import StatusBar from './lib/StatusBar.svelte';
	import TabBar from './lib/TabBar.svelte';
	import { OTHER, WELCOME } from './lib/tabs';
	import { Tabs } from './lib/tabs.svelte';
	import TerminalPane from './lib/TerminalPane.svelte';
	import { shellQuoteAll } from './lib/shellquote';
	import { Startup } from './lib/startup.svelte';
	import { isTauri } from './lib/tauri';
	import { createTauriNotifier } from './lib/tauri-notify';
	import { createTerminal, TermView } from './lib/term-view';
	import UpdateBanner from './lib/UpdateBanner.svelte';

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
	const startup = new Startup({ manager, tabs });
	onDestroy(() => startup.stop());
	setApp({ manager, tabs, layout, startup });
	// For the notices' $appUpdater.
	const appUpdater = startup.updater;

	// Every way of closing the window but ⌘Q comes here: its close button, ⌘W
	// and the menu. With a listener, Tauri leaves the closing to it.
	if (isTauri()) {
		const unlisten = getCurrentWindow().onCloseRequested(async (e) => {
			if (!(await tabs.mayLoseAll('Close the window?', 'Close'))) e.preventDefault();
		});
		unlisten.catch((e) => manager.report(`asking before closing unavailable: ${e instanceof Error ? e.message : String(e)}`));
		onDestroy(() => void unlisten.then((f) => f(), () => {}));
	}

	let destroyed = false;
	onDestroy(() => {
		destroyed = true;
		manager.stop();
	});
	onDestroy(
		watchFocus(
			(focused) => manager.setFocused(focused),
			(e) => manager.report(`window focus unavailable: ${e instanceof Error ? e.message : String(e)}`),
		),
	);

	// Closed for this app run: the restart can wait, and the notice covers the terminal.
	let daemonNoticeClosed = $state(false);

	const unlistenTabs = onTabAsked((a) => {
		switch (a) {
			case 'close':
				return tabs.closeActive();
			case 'prev':
				return tabs.step(-1);
			case 'next':
				return tabs.step(1);
			case 'files':
				return layout.togglePanel();
		}
	});
	unlistenTabs.catch((e) => manager.report(`tab shortcuts unavailable: ${e instanceof Error ? e.message : String(e)}`));
	onDestroy(() => void unlistenTabs.then((f) => f(), () => {}));

	// A click brings the window up whatever the notification was about.
	function openNotified(target?: Target): void {
		tabs.openNotified(target);
		const win = getCurrentWindow();
		win.show()
			.then(() => win.unminimize())
			.then(() => win.setFocus())
			.catch((e) => manager.report(`bringing the window up failed: ${e instanceof Error ? e.message : String(e)}`));
	}

	// The manager starts once the notifier is set up, so the notifications it
	// sends on connecting, such as the missed summary, do not go to the console.
	const tauriNotifier = isTauri()
		? createTauriNotifier(openNotified, (e) => manager.report(`notification failed: ${e instanceof Error ? e.message : String(e)}`))
		: undefined;
	onDestroy(() => void tauriNotifier?.then((n) => n.stop()).catch(() => {}));
	void Promise.resolve(tauriNotifier)
		.then(
			(n) => {
				if (n) notifier = n;
				return n?.allowed === false ? 'notifications are turned off for vaquita in System Settings' : undefined;
			},
			(e) => `notifications unavailable: ${e instanceof Error ? e.message : String(e)}`,
		)
		.then((failure) => {
			if (destroyed) return;
			manager.start();
			if (failure) manager.report(failure);
		});

	let aside = $state<HTMLElement>();
	let addRepo = $state<ReturnType<typeof AddRepo>>();

	// On the window in the capture phase, so it runs before xterm's handler on
	// its textarea and the terminal never sees the key. ⌃Tab and ⌃⇧Tab are
	// here and not in the menu, as AppKit would run its key-view loop on them;
	// ⌥⌘← and ⌥⌘→ are here beside them. The menu has ⌘⇧[ and ⌘⇧].
	function shortcut(e: KeyboardEvent) {
		const n = tabNumber(e);
		if (isNewSessionShortcut(e)) tabs.newSession();
		else if (isSidebarShortcut(e)) layout.toggleSidebar();
		else if (isPrevTabShortcut(e)) tabs.step(-1);
		else if (isNextTabShortcut(e)) tabs.step(1);
		else if (n !== undefined) tabs.showAt(n);
		else if (isSaveShortcut(e)) tabs.save();
		else return;
		e.preventDefault();
		e.stopPropagation();
	}

	// The OS file drop only exists inside Tauri. Paths dropped on the sidebar
	// are added as repos; anywhere else they are typed into the selected session.
	if (isTauri()) {
		const unlisten = getCurrentWebview().onDragDropEvent((e) => {
			if (e.payload.type !== 'drop') return;
			// The position arrives in physical pixels.
			const { x, y } = e.payload.position.toLogical(window.devicePixelRatio);
			const box = aside?.getBoundingClientRect();
			if (box && x >= box.left && x < box.right && y >= box.top && y < box.bottom) {
				for (const p of e.payload.paths) manager.addRepo(p);
				return;
			}
			const sid = $manager.selected;
			const view = tabs.selectedView();
			if (sid === undefined || !view) return;
			// The paths go to the terminal, so its tab shows.
			if (tabs.active !== sessionTab(sid)) void tabs.show(sessionTab(sid));
			try {
				view.sendInput(shellQuoteAll(e.payload.paths));
			} catch (err) {
				manager.report(`file drop refused: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
		unlisten.catch((e) => manager.report(`file drop unavailable: ${e instanceof Error ? e.message : String(e)}`));
		onDestroy(() => void unlisten.then((f) => f(), () => {}));
	}
</script>

<svelte:window onkeydowncapture={shortcut} />

<main class:sidebar-hidden={layout.sidebarHidden} class:files-hidden={!layout.panelShown} style:--sidebar-width="{layout.sidebarWidth}px" style:--panel-width="{layout.panelWidth}px">
	<aside bind:this={aside}>
		<header>
			<span class="title">Repos</span>
			<AddRepo bind:this={addRepo} disabled={$manager.status !== 'connected'} onadd={(p) => manager.addRepo(p)} />
		</header>
		<SessionList
			sessions={$manager.sessions}
			selected={$manager.selected}
			selectedRepo={tabs.selectedRow ? undefined : tabs.group}
			otherTabs={(tabs.groups[OTHER] ?? []).some((k) => !isSessionTab(k))}
			onselect={tabs.selectSession}
			onselectrepo={(r) => (r === OTHER ? tabs.openOther() : tabs.openWelcome(r))}
			onkill={(sid) => manager.kill(sid)}
			repos={$manager.repos}
			home={startup.home}
			disabled={$manager.creating || $manager.status !== 'connected'}
			onreopen={(sid) => manager.reopen(sid)}
			ondismiss={(sid) => manager.dismiss(sid)}
			onstart={(repo, cmd) => manager.create(repo, cmd, '')}
			onremoverepo={(p) => manager.removeRepo(p)}
			onrename={(sid, name) => manager.rename(sid, name)}
			onreport={(m) => manager.report(m)}
			addDisabled={$manager.status !== 'connected'}
			onaddrepo={() => void addRepo?.open()}
			onnewsession={tabs.newSession}
		/>
		<div class="sidebar-footer">
			<button class="new-session" title="New session (⌘T)" onclick={tabs.newSession}>
				<Icon name="plus" />
				<span class="label">New session</span>
				<kbd>⌘T</kbd>
			</button>
		</div>
		<SidebarEdge width={layout.sidebarWidth} onstart={() => holdLayout(true)} onresize={(w) => (layout.sidebarWidth = w)} onend={layout.sidebarResized} />
	</aside>
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
				<AppWelcome bind:this={tabs.appWelcome} version={startup.version} addDisabled={$manager.status !== 'connected'} onaddrepo={() => void addRepo?.open()} onnewsession={tabs.newSession} />
			{/if}
		</div>
	</section>
	<!-- Unmounted, not hidden, while it is off, so nothing of the tree or the
	     changes runs and no folder is watched. -->
	{#if layout.panelShown}
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
	{/if}
	<div class="notices">
		{#if $appUpdater.version !== undefined}
			{@const version = $appUpdater.version}
			<AppUpdateBanner
				{version}
				installing={$appUpdater.installing}
				error={$appUpdater.error}
				oninstall={() => void startup.install()}
				ondismiss={() => appUpdater.dismiss()}
				onnotes={() => openExternal(releaseUrl(version), (e) => manager.report(`opening the release notes failed: ${e instanceof Error ? e.message : String(e)}`))}
			/>
		{/if}
		{#if $manager.update && $manager.status === 'connected' && !daemonNoticeClosed}
			<UpdateBanner
				update={$manager.update}
				running={runningCount($manager.sessions.map((r) => r.info))}
				onrestart={() => manager.restartDaemon()}
				ondismiss={() => (daemonNoticeClosed = true)}
			/>
		{/if}
	</div>
	<StatusBar />
</main>
