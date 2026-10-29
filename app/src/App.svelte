<script lang="ts">
	import { homeDir } from '@tauri-apps/api/path';
	import { getCurrentWebview } from '@tauri-apps/api/webview';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { onDestroy, tick } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import AddRepo from './lib/AddRepo.svelte';
	import AppUpdateBanner from './lib/AppUpdateBanner.svelte';
	import { AppUpdater, releaseUrl } from './lib/app-update';
	import { ask } from './lib/ask';
	import { DaemonConnection } from './lib/connection';
	import { runningCount } from './lib/daemon-update';
	import { documents } from './lib/documents';
	import { appBuild, checkAppUpdate, checkRestart, installAppUpdate, onUpdateCheckAsked, readEndpoint, restartDaemon, startDaemon } from './lib/endpoint';
	import { openPath } from './lib/file-links';
	import { clampPanelWidth, loadPanelWidth, PANEL_DEFAULT_WIDTH, PANEL_HIDDEN, PANEL_WIDTH } from './lib/file-panel';
	import FilePane from './lib/FilePane.svelte';
	import FileTree from './lib/FileTree.svelte';
	import { onTabAsked } from './lib/files';
	import { watchFocus } from './lib/focus';
	import { repoName, repoOf } from './lib/groups';
	import Icon from './lib/Icon.svelte';
	import { isNewSessionShortcut, isNextTabShortcut, isPrevTabShortcut, isSaveShortcut, isSidebarShortcut } from './lib/keys';
	import { holdLayout } from './lib/layout-hold';
	import { openExternal } from './lib/links';
	import { SessionManager } from './lib/manager';
	import NewSessionDialog, { LAST_CWD } from './lib/NewSessionDialog.svelte';
	import { sessionTitle, type Notifier, type Target } from './lib/notify';
	import { shortPath } from './lib/paths';
	import SessionList from './lib/SessionList.svelte';
	import { loadWidth, SIDEBAR_HIDDEN, SIDEBAR_WIDTH } from './lib/sidebar';
	import SidebarEdge from './lib/SidebarEdge.svelte';
	import { load, save } from './lib/storage';
	import TabBar from './lib/TabBar.svelte';
	import { closeInGroup, fallback, fileName, groupKey, loadTabs, neighbour, openFileTab, OTHER, prune, saveTabs, setOrder, touch, unpreview, type Previews, type Recent } from './lib/tabs';
	import TerminalPane from './lib/TerminalPane.svelte';
	import { shellQuoteAll } from './lib/shellquote';
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
		checkRestart,
		restartDaemon,
		connect: (endpoint, handlers) => new DaemonConnection(endpoint, handlers),
		createTerminal: (cols, rows) => createTerminal(cols, rows),
		createView: (term, core, cwd) =>
			new TermView(term, core, (m, tone) => manager.report(m, tone), cwd, (path) => openFile(cwd, path), () => active === undefined),
		notifier: { show: (n) => notifier.show(n) },
	});
	// The file tabs of every group, and the one shown; undefined is the
	// terminal, as after a relaunch and whenever another session is selected.
	let groups = $state(loadTabs());
	let active = $state<string>();
	// The preview tab of each group, for the app run only.
	let previews = $state<Previews>({});
	// What each group showed, most recent first, for where closing the shown
	// tab goes. Per group, as the tabs are, and for the app run only; plain,
	// since nothing renders it.
	const recent = new Map<string, Recent>();
	const dirty = new SvelteSet<string>();
	// An edit keeps a preview tab, in every group that has it.
	onDestroy(
		documents.onDirtyChange((path, d) => {
			if (d) {
				dirty.add(path);
				previews = unpreview(previews, path);
			} else dirty.delete(path);
		}),
	);
	let filePane = $state<ReturnType<typeof FilePane>>();

	const selectedRow = $derived($manager.sessions.find((r) => r.info.sid === $manager.selected));
	const group = $derived(selectedRow && groupKey(selectedRow.info.cwd, $manager.repos));
	const groupTabs = $derived((group !== undefined && groups[group]) || []);
	// The repo whose tree the file panel shows: the selected session's group,
	// unless that is no repo.
	const root = $derived(group !== OTHER ? group : undefined);

	// Not before the daemon has sent its list: the empty one the app starts
	// with would drop every repo's tabs. Those of a repo removed move to Other,
	// so that no one is left without a way to save the edits they may hold.
	$effect(() => {
		if (!$manager.reposListed) return;
		const kept = prune(groups, $manager.repos);
		if (kept === groups) return;
		groups = kept;
		saveTabs(kept);
	});

	// A file covers the terminal, whose session is then not being looked at.
	$effect(() => manager.setCovered(active !== undefined));

	let shownSid: number | undefined;
	$effect(() => {
		if ($manager.selected === shownSid) return;
		shownSid = $manager.selected;
		void showTab(undefined);
	});
	// A repo added or removed can move the session to another group, whose
	// tabs do not include the one shown.
	$effect(() => {
		if (active !== undefined && !groupTabs.includes(active)) void showTab(undefined);
	});

	// A ⌘-clicked file in a session's terminal; cwd is its starting folder.
	// Unpinned, it opens as the group's preview. A dirty document opens pinned:
	// documents are shared by path across groups, so it may hold another
	// group's edits, and a preview, which the next file replaces, holds none.
	function openFile(cwd: string, path: string, pin = false): void {
		const r = openFileTab(groups, previews, groupKey(cwd, $manager.repos), path, pin || documents.isDirty(path));
		groups = r.groups;
		previews = r.previews;
		if (r.drop !== undefined) documents.dropDocument(r.drop);
		saveTabs(groups);
		void showTab(path);
	}

	// The order a drag on the bar left the group's tabs in, kept across restarts.
	function reorderTabs(order: string[]): void {
		if (group === undefined) return;
		groups = setOrder(groups, group, order);
		saveTabs(groups);
	}

	// A file clicked in the tree goes through the gate a ⌘-click does, so what
	// the app does not show in a tab is opened or revealed the same way. Its tab
	// lands in the selected session's group, the tree's repo.
	function openFromTree(path: string, pin = false): void {
		const cwd = selectedRow?.info.cwd;
		if (cwd === undefined) return;
		void openPath(path, '', (m, tone) => manager.report(m, tone), (p) => openFile(cwd, p, pin));
	}

	// What shows takes the focus, so that typing never reaches a terminal
	// covered by a file.
	function focusContent(): void {
		if (active !== undefined) filePane?.focus();
		else selectedView()?.focus();
	}

	// No file under the new-session dialog: it gives the focus back to what had
	// it when it opened, which may be the terminal the file would cover. The
	// terminal can show, as when the session it creates is selected; the
	// dialog keeps the focus then.
	async function showTab(path: string | undefined): Promise<void> {
		if (dialogOpen && path !== undefined) return;
		active = path;
		// Every change of the shown tab ends here, so this one line keeps the list.
		if (group !== undefined) recent.set(group, touch(recent.get(group) ?? [], path));
		// The file pane is there to take the focus only once it has rendered.
		await tick();
		if (!dialogOpen) focusContent();
	}

	// Asked before unsaved edits are lost; false when the user keeps them or
	// the question could not be asked.
	async function mayLose(message: string, okLabel: string): Promise<boolean> {
		try {
			return await ask(message, okLabel);
		} catch (e) {
			manager.report(`asking about unsaved changes failed: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}

	// One question for all the unsaved among them; declined, nothing closes,
	// so the bar is not left half-changed under the answer.
	// Only the documents that go are asked about: edits in a path another group
	// still has stay reachable from its tab there.
	async function closeFileTabs(paths: string[]): Promise<void> {
		const key = group;
		if (key === undefined) return;
		const unsaved = closeInGroup(groups, previews, key, paths).drop.filter((p) => documents.isDirty(p));
		if (unsaved.length > 0) {
			const question =
				unsaved.length === 1
					? `${fileName(unsaved[0])} has unsaved changes. Close it?`
					: `${unsaved.length} files have unsaved changes. Close them?`;
			if (!(await mayLose(question, 'Close'))) return;
		}
		// Again on the tabs as they are after the question, which a repo list
		// from the daemon may have moved; closing stops if that left an unsaved
		// document going that was not asked about, its tabs kept.
		const r = closeInGroup(groups, previews, key, paths);
		if (r.drop.some((p) => documents.isDirty(p) && !unsaved.includes(p))) {
			manager.report('The tabs changed while asking; nothing was closed.');
			return;
		}
		for (const p of r.drop) documents.dropDocument(p);
		groups = r.groups;
		previews = r.previews;
		saveTabs(groups);
		if (active !== undefined && paths.includes(active)) void showTab(fallback(recent.get(key) ?? [], groups[key] ?? []));
	}

	// ⌘W: the file tab shown, else the window, as the menu's Close Window did.
	function closeActive(): void {
		if (active !== undefined) void closeFileTabs([active]);
		else getCurrentWindow().close().catch((e) => manager.report(`closing the window failed: ${e instanceof Error ? e.message : String(e)}`));
	}

	// For what ends the app run: true at once when nothing is unsaved.
	async function mayLoseAll(question: string, okLabel: string): Promise<boolean> {
		const n = dirty.size;
		return n === 0 || (await mayLose(`${n === 1 ? '1 file has' : `${n} files have`} unsaved changes. ${question}`, okLabel));
	}

	// The install ends in an exit, which no close request precedes. Editing is
	// frozen before the question and until the install fails or is declined, so
	// that nothing typed meanwhile is lost to the exit.
	let updating = $state(false);
	async function installUpdate(): Promise<void> {
		if (updating) return;
		updating = true;
		if (await mayLoseAll('Update and relaunch?', 'Update')) await appUpdater.install();
		// A successful install leaves the app on its way out, still installing.
		updating = $appUpdater.installing;
	}

	// Every way of closing the window but ⌘Q comes here: its close button, ⌘W
	// and the menu. With a listener, Tauri leaves the closing to it.
	if (isTauri()) {
		const unlisten = getCurrentWindow().onCloseRequested(async (e) => {
			if (!(await mayLoseAll('Close the window?', 'Close'))) e.preventDefault();
		});
		unlisten.catch((e) => manager.report(`asking before closing unavailable: ${e instanceof Error ? e.message : String(e)}`));
		onDestroy(() => void unlisten.then((f) => f(), () => {}));
	}

	function stepTab(step: number): void {
		void showTab(neighbour(groupTabs, active, step));
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

	const appUpdater = new AppUpdater({
		check: checkAppUpdate,
		install: installAppUpdate,
		warn: (m) => console.warn(m),
		report: (m, tone) => manager.report(m, tone),
	});
	appUpdater.start();
	onDestroy(() => appUpdater.stop());
	const unlistenCheck = onUpdateCheckAsked(() => void appUpdater.checkNow());
	unlistenCheck.catch((e) => manager.report(`Check for Updates unavailable: ${e instanceof Error ? e.message : String(e)}`));
	onDestroy(() => void unlistenCheck.then((f) => f(), () => {}));
	const unlistenTabs = onTabAsked((a) => {
		switch (a) {
			case 'close':
				return closeActive();
			case 'terminal':
				return void showTab(undefined);
			case 'prev':
				return stepTab(-1);
			case 'next':
				return stepTab(1);
			case 'files':
				return togglePanel();
		}
	});
	unlistenTabs.catch((e) => manager.report(`tab shortcuts unavailable: ${e instanceof Error ? e.message : String(e)}`));
	onDestroy(() => void unlistenTabs.then((f) => f(), () => {}));

	// A click brings the window up whatever the notification was about; the
	// manager selects its session only if that very session is still there.
	function openNotified(target?: Target): void {
		manager.openNotified(target);
		// The same session stays selected, so nothing else uncovers its terminal.
		if (target && selectedRow?.info.sid === target.sid && selectedRow.info.inc === target.inc) void showTab(undefined);
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

	let dialogOpen = $state(false);
	let dialogCwd = $state('');

	// The dialog starts in the selected session's repo, else in the folder it
	// last created a session in, else in the home folder.
	function newSession() {
		if (dialogOpen) return;
		const { sessions, selected, repos } = $manager;
		const cwd = sessions.find((r) => r.info.sid === selected)?.info.cwd;
		dialogCwd = (cwd !== undefined ? repoOf(cwd, repos) : undefined) ?? load(LAST_CWD) ?? '';
		dialogOpen = true;
	}

	// On the window in the capture phase, so it runs before xterm's handler on
	// its textarea and the terminal never sees the key. ⌃Tab and ⌃⇧Tab are
	// here and not in the menu, as AppKit would run its key-view loop on them.
	// The menu has ⌘⇧[ and ⌘⇧].
	function shortcut(e: KeyboardEvent) {
		if (isNewSessionShortcut(e)) newSession();
		else if (isSidebarShortcut(e)) toggleSidebar();
		else if (isPrevTabShortcut(e)) stepTab(-1);
		else if (isNextTabShortcut(e)) stepTab(1);
		else if (isSaveShortcut(e)) {
			// By path, not through an editor, so a tab that shows no editor saves too.
			if (active !== undefined) void documents.saveDocument(active, (m) => manager.report(m));
		} else return;
		e.preventDefault();
		e.stopPropagation();
	}

	let sidebarWidth = $state(loadWidth());
	let sidebarHidden = $state(load(SIDEBAR_HIDDEN) === 'true');

	function selectedView(): TermView | undefined {
		const { sessions, selected } = $manager;
		return sessions.find((r) => r.info.sid === selected)?.view;
	}

	// The content takes the focus, which would otherwise be lost in a hidden
	// sidebar or left on the status line's button.
	function toggleSidebar() {
		sidebarHidden = !sidebarHidden;
		save(SIDEBAR_HIDDEN, String(sidebarHidden));
		if (!dialogOpen) focusContent();
	}

	function sidebarResized() {
		holdLayout(false);
		selectedView()?.refit();
		filePane?.relayout();
		save(SIDEBAR_WIDTH, String(sidebarWidth));
	}

	let panelWidth = $state(loadPanelWidth());
	let panelHidden = $state(load(PANEL_HIDDEN) === 'true');

	// As toggleSidebar: the focus may be in the tree, which goes.
	function togglePanel() {
		panelHidden = !panelHidden;
		save(PANEL_HIDDEN, String(panelHidden));
		if (!dialogOpen) focusContent();
	}

	function panelResized() {
		holdLayout(false);
		selectedView()?.refit();
		filePane?.relayout();
		save(PANEL_WIDTH, String(panelWidth));
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
			const view = selectedView();
			if (!view) return;
			// The paths go to the terminal, so it shows.
			if (active !== undefined) void showTab(undefined);
			try {
				view.sendInput(shellQuoteAll(e.payload.paths));
			} catch (err) {
				manager.report(`file drop refused: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
		unlisten.catch((e) => manager.report(`file drop unavailable: ${e instanceof Error ? e.message : String(e)}`));
		onDestroy(() => void unlisten.then((f) => f(), () => {}));
	}

	// Rows show paths under it with ~; in a plain browser it stays unknown and
	// paths absolute, as a guess could show another user's folder as home.
	let home = $state<string>();
	if (isTauri()) {
		homeDir().then(
			(h) => (home = h),
			(e) => manager.report(`home folder unavailable: ${e instanceof Error ? e.message : String(e)}`),
		);
	}

	const statusText = $derived.by(() => {
		switch ($manager.status) {
			case 'connected':
				return 'connected';
			case 'connecting':
				return 'connecting…';
			case 'starting':
				return 'starting daemon…';
			case 'restarting':
				return 'restarting daemon…';
			case 'not-running':
				return 'daemon not running';
			case 'version-mismatch':
				return `daemon restart needed (daemon v${$manager.daemonV}, app v1)`;
			case 'disconnected':
				return 'disconnected, retrying…';
		}
	});
	// The status line is grey; only its dot says how the daemon is.
	const statusTone = $derived.by(() => {
		switch ($manager.status) {
			case 'connected':
				return 'ok';
			case 'not-running':
			case 'version-mismatch':
				return 'bad';
			default:
				return 'wait';
		}
	});
</script>

<svelte:window onkeydowncapture={shortcut} />

<main class:sidebar-hidden={sidebarHidden} class:files-hidden={panelHidden} style:--sidebar-width="{sidebarWidth}px" style:--panel-width="{panelWidth}px">
	<aside bind:this={aside}>
		<header>
			<span class="title">Repos</span>
			<AddRepo bind:this={addRepo} disabled={$manager.status !== 'connected'} onadd={(p) => manager.addRepo(p)} />
		</header>
		<SessionList
			sessions={$manager.sessions}
			selected={$manager.selected}
			onselect={(sid) => manager.select(sid)}
			onkill={(sid) => manager.kill(sid)}
			repos={$manager.repos}
			{home}
			disabled={$manager.creating || $manager.status !== 'connected'}
			onreopen={(sid) => manager.reopen(sid)}
			ondismiss={(sid) => manager.dismiss(sid)}
			onstart={(repo, cmd) => manager.create(repo, cmd, '')}
			onremoverepo={(p) => manager.removeRepo(p)}
			onrename={(sid, name) => manager.rename(sid, name)}
			onreport={(m) => manager.report(m)}
			addDisabled={$manager.status !== 'connected'}
			onaddrepo={() => void addRepo?.open()}
			onnewsession={newSession}
		/>
		<div class="sidebar-footer">
			<button class="new-session" title="New session (⌘T)" onclick={newSession}>
				<Icon name="plus" />
				<span class="label">New session</span>
				<kbd>⌘T</kbd>
			</button>
		</div>
		<SidebarEdge width={sidebarWidth} onstart={() => holdLayout(true)} onresize={(w) => (sidebarWidth = w)} onend={sidebarResized} />
	</aside>
	<NewSessionDialog
		open={dialogOpen}
		repos={$manager.repos}
		defaultCwd={dialogCwd}
		disabled={$manager.creating || $manager.status !== 'connected'}
		oncreate={(cwd, cmd, name) => manager.create(cwd, cmd, name)}
		onclose={() => (dialogOpen = false)}
		fallbackFocus={focusContent}
	/>
	<section class="content">
		{#if selectedRow}
			<TabBar
				title={sessionTitle(selectedRow.info)}
				tabs={groupTabs}
				{active}
				preview={group !== undefined ? previews[group] : undefined}
				{dirty}
				onselect={(p) => void showTab(p)}
				onclose={(ps) => void closeFileTabs(ps)}
				onpin={(p) => (previews = unpreview(previews, p))}
				onreorder={reorderTabs}
				report={(m) => manager.report(m)}
			/>
		{/if}
		<div class="stack">
			<TerminalPane sessions={$manager.sessions} selected={$manager.selected} />
			{#if active !== undefined}
				{@const path = active}
				<FilePane bind:this={filePane} {path} repo={root} {home} readOnly={updating} onclose={() => void closeFileTabs([path])} report={(m) => manager.report(m)} />
			{/if}
		</div>
	</section>
	<!-- Unmounted, not hidden, while it is off, so nothing of the tree runs and
	     no folder is watched. -->
	{#if !panelHidden}
		<aside class="files">
			<header>
				<span class="title">Files</span>
				{#if root !== undefined}<span class="repo" title={root}>{repoName(root)}</span>{/if}
			</header>
			{#if root !== undefined}
				{#key root}
					<FileTree {root} highlight={active} onopen={openFromTree} report={(m) => manager.report(m)} />
				{/key}
			{:else if selectedRow}
				{@const cwd = selectedRow.info.cwd}
				<!-- An empty cwd is the home folder, unknown in a plain browser. -->
				{@const folder = cwd || home}
				<div class="no-repo">
					<p>This session's folder is not a registered repo, so it has no file tree.</p>
					<button
						title={folder}
						disabled={$manager.status !== 'connected' || folder === undefined}
						onclick={() => folder !== undefined && manager.addRepo(folder)}
					>
						Add {shortPath(cwd, home)} as a repo
					</button>
				</div>
			{/if}
			<SidebarEdge
				side="left"
				clamp={clampPanelWidth}
				defaultWidth={PANEL_DEFAULT_WIDTH}
				label="Resize files panel"
				width={panelWidth}
				onstart={() => holdLayout(true)}
				onresize={(w) => (panelWidth = w)}
				onend={panelResized}
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
				oninstall={() => void installUpdate()}
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
	<footer>
		<button class="icon-btn sidebar-toggle" title="{sidebarHidden ? 'Show' : 'Hide'} sidebar (⌘B)" onclick={toggleSidebar}>
			<Icon name="sidebar" />
		</button>
		<span class="state"><span class="dot {statusTone}"></span>{statusText}</span>
		<span>{$manager.sessions.length} sessions</span>
		{#if $manager.message}<span class="message" title={$manager.message}>{$manager.message}</span>{/if}
		{#if $manager.report}
			{@const report = $manager.report}
			<button class="report {report.tone}" title={report.text} onclick={() => manager.dismissReport()}>{report.text}</button>
		{/if}
		<button class="icon-btn files-toggle" title="{panelHidden ? 'Show' : 'Hide'} files (⌥⌘B)" onclick={togglePanel}>
			<Icon name="sidebar-right" />
		</button>
	</footer>
</main>
