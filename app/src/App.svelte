<script lang="ts">
	import { getVersion } from '@tauri-apps/api/app';
	import { homeDir } from '@tauri-apps/api/path';
	import { getCurrentWebview } from '@tauri-apps/api/webview';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { onDestroy, tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import AddRepo from './lib/AddRepo.svelte';
	import AppUpdateBanner from './lib/AppUpdateBanner.svelte';
	import AppWelcome from './lib/AppWelcome.svelte';
	import { AppUpdater, releaseUrl } from './lib/app-update';
	import { ask } from './lib/ask';
	import { diffTab, tabFile } from './lib/changes';
	import { DaemonConnection } from './lib/connection';
	import { runningCount } from './lib/daemon-update';
	import { documents } from './lib/documents';
	import { appBuild, checkAppUpdate, checkRestart, daemonOnDisk, installAppUpdate, onUpdateCheckAsked, readEndpoint, restartDaemon, startDaemon } from './lib/endpoint';
	import { openPath } from './lib/file-links';
	import { clampPanelWidth, loadPanelWidth, PANEL_DEFAULT_WIDTH, PANEL_HIDDEN, PANEL_WIDTH } from './lib/file-panel';
	import FilePane from './lib/FilePane.svelte';
	import FilesPanel, { showView } from './lib/FilesPanel.svelte';
	import { onTabAsked } from './lib/files';
	import { watchFocus } from './lib/focus';
	import Icon from './lib/Icon.svelte';
	import { isNewSessionShortcut, isNextTabShortcut, isPrevTabShortcut, isSaveShortcut, isSidebarShortcut, tabNumber } from './lib/keys';
	import { holdLayout } from './lib/layout-hold';
	import { openExternal } from './lib/links';
	import { SessionManager } from './lib/manager';
	import NewSessionDialog, { LAST_CWD } from './lib/NewSessionDialog.svelte';
	import { sessionTitle, type Notifier, type Target } from './lib/notify';
	import RepoWelcome from './lib/RepoWelcome.svelte';
	import { arrangeGroup, isSessionTab, needsAsk, placement, reconcile, sessionTab, tabSid } from './lib/session-tabs';
	import SessionList from './lib/SessionList.svelte';
	import { loadWidth, SIDEBAR_HIDDEN, SIDEBAR_WIDTH } from './lib/sidebar';
	import SidebarEdge from './lib/SidebarEdge.svelte';
	import { load, save } from './lib/storage';
	import TabBar from './lib/TabBar.svelte';
	import { closeInGroup, fallback, fileName, groupKey, loadTabs, neighbour, openFileTab, OTHER, prune, saveTabs, setOrder, touch, unpreview, WELCOME, type Previews, type Recent } from './lib/tabs';
	import TerminalPane from './lib/TerminalPane.svelte';
	import { shellQuoteAll } from './lib/shellquote';
	import { isTauri } from './lib/tauri';
	import { createTauriNotifier } from './lib/tauri-notify';
	import { createTerminal, TermView } from './lib/term-view';
	import UpdateBanner from './lib/UpdateBanner.svelte';
	import { newRepos, selectionAfterRemoval } from './lib/welcome';

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
			new TermView(term, core, (m, tone) => manager.report(m, tone), cwd, (path) => openFile(cwd, path), () => active !== undefined && isSessionTab(active)),
		notifier: { show: (n) => notifier.show(n) },
	});
	// The tabs of every group, files and sessions in one order, and the one
	// shown. A session's tab shows its terminal, the selected session's: showing
	// one selects it. WELCOME is a repo's welcome, shown over its session's
	// terminal or alone; it is no tab of any group. Undefined shows nothing, as
	// under the app welcome.
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
	let repoWelcome = $state<ReturnType<typeof RepoWelcome>>();
	let appWelcome = $state<ReturnType<typeof AppWelcome>>();

	// The group whose bar shows: the selected session's, or the repo chosen
	// by its name, for the app run only (a relaunch selects the stored
	// session, or nothing); undefined shows the app welcome.
	let group = $state<string>();
	const selectedRow = $derived($manager.sessions.find((r) => r.info.sid === $manager.selected));
	// Where each session's tab belongs. The repo list the app starts with is
	// empty, so until the daemon's the stored keys alone show; a session list
	// kept through a reconnect still shows its tabs.
	const placed = $derived(placement($manager.sessions.map((r) => r.info), $manager.repos));
	// Whether the lists are the daemon's current ones, for what drops or
	// leaves a tab on their word.
	const listed = $derived($manager.status === 'connected' && $manager.reposListed);
	const groupTabs = $derived.by(() => {
		if (group === undefined) return [];
		const sids = $manager.reposListed ? [...placed].flatMap(([sid, key]) => (key === group ? [sid] : [])) : [];
		return arrangeGroup(groups[group] ?? [], sids);
	});
	// The repo whose tree the file panel shows: the shown group, unless that
	// is no repo.
	const root = $derived(group !== OTHER ? group : undefined);

	// Not before the daemon has sent its list: the empty one the app starts
	// with would drop every repo's tabs. Those of a repo removed move to Other,
	// so that no one is left without a way to save the edits they may hold.
	$effect(() => {
		if (!$manager.reposListed) return;
		const before = groups;
		const kept = prune(before, $manager.repos);
		if (kept === before) return;
		groups = kept;
		saveTabs(kept);
		// With no session the moved file tabs are reached only by selecting
		// their group, which may be Other: tabs and no welcome, no tree. A
		// selected session with a tab takes the group along itself, below.
		if (selectedPlaced() || group === undefined || $manager.repos.includes(group)) return;
		const to = selectionAfterRemoval(before, group, $manager.repos);
		if (to === undefined) return;
		group = to;
		const moved = (kept[to] ?? []).filter((k) => !isSessionTab(k));
		void showTab(active !== undefined && moved.includes(active) ? active : moved[0]);
	});
	// The stored order follows the session list: a gone session's tab leaves
	// it, a new one, or one a repo added or removed moved, joins its group.
	$effect(() => {
		if (!listed) return;
		const next = reconcile(groups, placed);
		if (next === groups) return;
		groups = next;
		saveTabs(next);
	});

	// A file or a welcome covers the terminal, whose session is then not being looked at.
	$effect(() => manager.setCovered(active !== undefined && !isSessionTab(active)));

	// A session selected shows its tab, in its group: a click on its row, a
	// notification, a created session's replay and the relaunch's stored
	// selection all come here. A deselect does nothing, as whoever deselected
	// has shown a welcome or an Other tab. Null at first, which no selection
	// is, so the first run shows what there is (the app welcome before the
	// daemon's list) and it takes the focus.
	let shownSid: number | undefined | null = null;
	$effect(() => {
		const sid = $manager.selected;
		if (sid === shownSid) return;
		if (sid === undefined) {
			if (shownSid === null) void showTab(undefined);
			shownSid = undefined;
			return;
		}
		const row = $manager.sessions.find((r) => r.info.sid === sid);
		if (!row) return;
		shownSid = sid;
		untrack(() => {
			group = groupKey(row.info.cwd, $manager.repos);
			// Shown already when its tab was what selected it.
			if (active !== sessionTab(sid)) void showTab(sessionTab(sid));
		});
	});
	// A repo added or removed can move the selected session to another group,
	// which then shows, as does the repo list that comes after the session
	// list on a relaunch. Before the effects below, so that they see the group
	// it went to. A record of an earlier run has no tab to follow, and the
	// fallback below may leave its group. Its tab shown goes into the new
	// group's recent list, for closing a tab opened after it to come back to.
	$effect(() => {
		if (!$manager.reposListed || selectedRow === undefined) return;
		const sid = selectedRow.info.sid;
		const to = placed.get(sid);
		if (to === undefined || to === group) return;
		group = to;
		if (untrack(() => active) === sessionTab(sid)) recent.set(to, touch(recent.get(to) ?? [], sessionTab(sid)));
	});
	// A removed repo is no selection; the app welcome shows instead. Not before
	// the daemon's list, as the one the app starts with is empty.
	$effect(() => {
		if ($manager.reposListed && !selectedPlaced() && group !== undefined && group !== OTHER && !$manager.repos.includes(group)) group = undefined;
	});
	// What shows that is not of the shown group goes: a closed or killed
	// session's tab, a tab a repo added or removed moved away, the welcome of
	// a repo that went. Not before the lists, which would make every stored
	// session tab look gone.
	$effect(() => {
		if (!listed) return;
		const shows = active === undefined ? group === undefined : active === WELCOME ? root !== undefined : groupTabs.includes(active);
		if (!shows) showFallback();
	});

	// A session of this run with a tab is selected: a record of an earlier
	// run, selected through a daemon restart, holds no group.
	function selectedPlaced(): boolean {
		return $manager.selected !== undefined && placed.has($manager.selected);
	}

	// Where the shown group goes when what it showed is gone: the tab shown
	// most recently, else its first, else the repo's welcome; Other, which
	// has no welcome, is then no selection any more.
	function showFallback(): void {
		const next = fallback((group !== undefined && recent.get(group)) || [], groupTabs) ?? (root !== undefined ? WELCOME : undefined);
		if (next === undefined && group === OTHER) group = undefined;
		void showTab(next);
	}

	// The daemon sends the whole repo list on every change and does not say
	// which request it answers, so a repo new to the list is the sign that it
	// was added, here or by anyone else. The first list is what was already
	// there and opens nothing. Of several at once, as from a drop of many
	// folders, the last in the list opens, so one welcome shows.
	let knownRepos: string[] | undefined;
	$effect(() => {
		// Under the dialog nothing is consumed, so that its close, which reruns
		// this, still finds the additions that came meanwhile.
		if (!$manager.reposListed || dialogOpen) return;
		const repos = $manager.repos;
		if (repos === knownRepos) return;
		const prev = knownRepos;
		knownRepos = repos;
		if (prev === undefined) return;
		const added = newRepos(prev, repos).at(-1);
		if (added !== undefined) untrack(() => openWelcome(added));
	});

	// A repo's name in the sidebar shows its welcome. A session of that repo
	// stays selected, its terminal covered as by a file; any other is
	// deselected, so the repo is the selection. Not under the new-session
	// dialog, which keeps what it opened over, as showTab does.
	function openWelcome(repo: string): void {
		if (dialogOpen) return;
		if (selectedRow === undefined || groupKey(selectedRow.info.cwd, $manager.repos) !== repo) manager.deselect();
		group = repo;
		void showTab(WELCOME);
	}

	// The Other group's name, shown while it holds file tabs, selects them:
	// the way back to edits that moved there when their repo was removed. Its
	// most recent tab shows, as closing one would go; no welcome, it is no repo.
	function openOther(): void {
		if (dialogOpen) return;
		if (selectedRow === undefined || groupKey(selectedRow.info.cwd, $manager.repos) !== OTHER) manager.deselect();
		group = OTHER;
		const next = fallback(recent.get(OTHER) ?? [], groupTabs);
		if (next !== undefined) void showTab(next);
	}

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

	// A file's diff against HEAD, as a tab of the shown group: the repo the
	// changes were listed for, which Other is not.
	function openDiff(path: string, pin = false): void {
		if (group === undefined || group === OTHER) return;
		const r = openFileTab(groups, previews, group, diffTab(path), pin);
		groups = r.groups;
		previews = r.previews;
		// The preview it took the place of, a file tab's maybe.
		if (r.drop !== undefined) documents.dropDocument(r.drop);
		saveTabs(groups);
		void showTab(diffTab(path));
	}

	// The order a drag on the bar left the group's tabs in, kept across restarts.
	function reorderTabs(order: string[]): void {
		if (group === undefined) return;
		groups = setOrder(groups, group, order);
		saveTabs(groups);
	}

	// A file clicked in the tree goes through the gate a ⌘-click does, so what
	// the app does not show in a tab is opened or revealed the same way. Its tab
	// lands in the shown group, the tree's repo.
	function openFromTree(path: string, pin = false): void {
		const cwd = selectedRow?.info.cwd ?? root;
		if (cwd === undefined) return;
		void openPath(path, '', (m, tone) => manager.report(m, tone), (p) => openFile(cwd, p, pin));
	}

	// What shows takes the focus, so that typing never reaches a terminal
	// covered by a file or a welcome.
	function focusContent(): void {
		if (active === WELCOME) repoWelcome?.focus();
		else if (active === undefined) appWelcome?.focus();
		else if (isSessionTab(active)) selectedView()?.focus();
		else filePane?.focus();
	}

	// No file and no welcome under the new-session dialog: it gives the focus
	// back to what had it when it opened, which may be the terminal they would
	// cover. A session's tab can show, as when the session it creates is
	// selected; the dialog keeps the focus then.
	async function showTab(path: string | undefined): Promise<void> {
		if (dialogOpen && path !== undefined && !isSessionTab(path)) return;
		active = path;
		const sid = path === undefined ? undefined : tabSid(path);
		if (sid !== undefined && sid !== $manager.selected) manager.select(sid);
		// Every change of the shown tab ends here, so this one line keeps the
		// list. The welcome is no tab that closing one could go back to.
		if (group !== undefined && path !== undefined && path !== WELCOME) recent.set(group, touch(recent.get(group) ?? [], path));
		// The file pane is there to take the focus only once it has rendered.
		await tick();
		if (!dialogOpen) focusContent();
	}

	// Asked before unsaved edits or a working session are lost; false when the
	// user keeps them or the question could not be asked.
	async function mayLose(message: string, okLabel: string, about = 'unsaved changes'): Promise<boolean> {
		try {
			return await ask(message, okLabel);
		} catch (e) {
			manager.report(`asking about ${about} failed: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}

	// File keys and session keys: the files close, the sessions are killed.
	// Falling back from a killed session's tab is the fallback effect's, as
	// the session leaves the list only later.
	async function closeTabs(keys: string[]): Promise<void> {
		const files = keys.filter((k) => !isSessionTab(k));
		if (files.length > 0) await closeFileTabs(files);
		const sids = keys.flatMap((k) => tabSid(k) ?? []);
		if (sids.length > 0) await killSessions(sids);
	}

	// An agent mid-turn or waiting on a permission is asked about once; the
	// rest are killed at once, an exited one's record going with its kill.
	// Only the sessions that are still the same ones after the question: a sid
	// with another inc is another session, from a restarted daemon.
	async function killSessions(sids: number[]): Promise<void> {
		const rows = $manager.sessions.filter((r) => sids.includes(r.info.sid));
		// Session closes come one at a time, so the question names one session.
		const working = rows.find((r) => needsAsk(r.info));
		if (working && !(await mayLose(`${sessionTitle(working.info)} is working. Kill it?`, 'Kill', 'killing a working session'))) return;
		for (const r of rows) if ($manager.sessions.some((n) => n.info.sid === r.info.sid && n.info.inc === r.info.inc)) manager.kill(r.info.sid);
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
		if (active !== undefined && paths.includes(active) && group === key) showFallback();
	}

	// ⌘W: the tab shown; the welcome is set aside like a tab while the group
	// has tabs; otherwise the window, as the menu's Close Window did. A menu
	// key reaches the page under the new-session dialog too, where it closes
	// the dialog, as Escape does, and nothing behind it.
	function closeActive(): void {
		if (dialogOpen) dialogOpen = false;
		else if (active !== undefined && active !== WELCOME) void closeTabs([active]);
		else if (active === WELCOME && groupTabs.length > 0) void showTab(fallback((group !== undefined && recent.get(group)) || [], groupTabs));
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

	// A repo's welcome with no tabs has nothing to step to. Nothing switches
	// under the new-session dialog, which keeps what it opened over.
	function stepTab(step: number): void {
		if (dialogOpen) return;
		const next = neighbour(groupTabs, active, step);
		if (next !== undefined) void showTab(next);
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
		// The same session stays selected, so nothing else shows its tab.
		const same = target !== undefined && selectedRow?.info.sid === target.sid && selectedRow.info.inc === target.inc;
		manager.openNotified(target);
		if (same) void showTab(sessionTab(target.sid));
		const win = getCurrentWindow();
		win.show()
			.then(() => win.unminimize())
			.then(() => win.setFocus())
			.catch((e) => manager.report(`bringing the window up failed: ${e instanceof Error ? e.message : String(e)}`));
	}

	// A session's row in the sidebar, or a past conversation's open row, asks
	// for its tab: as openNotified, the same session staying selected, the
	// file or its repo's welcome covering it goes.
	function selectSession(sid: number): void {
		const same = sid === $manager.selected;
		manager.select(sid);
		if (same) void showTab(sessionTab(sid));
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

	// The dialog starts in the shown repo, else in the folder it last created
	// a session in, else in the home folder.
	function newSession() {
		if (dialogOpen) return;
		dialogCwd = (group !== OTHER ? group : undefined) ?? load(LAST_CWD) ?? '';
		dialogOpen = true;
	}

	// On the window in the capture phase, so it runs before xterm's handler on
	// its textarea and the terminal never sees the key. ⌃Tab and ⌃⇧Tab are
	// here and not in the menu, as AppKit would run its key-view loop on them;
	// ⌥⌘← and ⌥⌘→ are here beside them. The menu has ⌘⇧[ and ⌘⇧].
	function shortcut(e: KeyboardEvent) {
		const n = tabNumber(e);
		if (isNewSessionShortcut(e)) newSession();
		else if (isSidebarShortcut(e)) toggleSidebar();
		else if (isPrevTabShortcut(e)) stepTab(-1);
		else if (isNextTabShortcut(e)) stepTab(1);
		else if (n !== undefined) {
			if (!dialogOpen && n <= groupTabs.length) void showTab(groupTabs[n - 1]);
		} else if (isSaveShortcut(e)) {
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
	// With nothing selected the panel would have no repo to show, and the app
	// welcome is drawn without it; the stored choice is kept for later.
	const panelShown = $derived(!panelHidden && group !== undefined);

	// As toggleSidebar: the focus may be in the tree, which goes.
	function togglePanel() {
		panelHidden = !panelHidden;
		save(PANEL_HIDDEN, String(panelHidden));
		if (!dialogOpen) focusContent();
	}

	// The welcome's "All past conversations": the panel's Past view, shown.
	function showPast(): void {
		showView('past');
		if (panelHidden) togglePanel();
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
			const sid = $manager.selected;
			const view = selectedView();
			if (sid === undefined || !view) return;
			// The paths go to the terminal, so its tab shows.
			if (active !== sessionTab(sid)) void showTab(sessionTab(sid));
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
	// For the app welcome's corner; unknown in a plain browser, as home is.
	let version = $state<string>();
	if (isTauri()) {
		getVersion().then(
			(v) => (version = v),
			(e) => manager.report(`app version unavailable: ${e instanceof Error ? e.message : String(e)}`),
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

<main class:sidebar-hidden={sidebarHidden} class:files-hidden={!panelShown} style:--sidebar-width="{sidebarWidth}px" style:--panel-width="{panelWidth}px">
	<aside bind:this={aside}>
		<header>
			<span class="title">Repos</span>
			<AddRepo bind:this={addRepo} disabled={$manager.status !== 'connected'} onadd={(p) => manager.addRepo(p)} />
		</header>
		<SessionList
			sessions={$manager.sessions}
			selected={$manager.selected}
			selectedRepo={selectedRow ? undefined : group}
			otherTabs={(groups[OTHER] ?? []).some((k) => !isSessionTab(k))}
			onselect={selectSession}
			onselectrepo={(r) => (r === OTHER ? openOther() : openWelcome(r))}
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
		<!-- No bar with nothing in it: a repo's welcome alone starts at the top, as the app welcome does. -->
		{#if group !== undefined && groupTabs.length > 0}
			<TabBar
				sessions={$manager.sessions}
				tabs={groupTabs}
				{active}
				preview={previews[group]}
				{dirty}
				onselect={(p) => void showTab(p)}
				onclose={(ps) => void closeTabs(ps)}
				onpin={(p) => (previews = unpreview(previews, p))}
				onreorder={reorderTabs}
				onnew={newSession}
				report={(m) => manager.report(m)}
			/>
		{/if}
		<div class="stack">
			<TerminalPane sessions={$manager.sessions} selected={$manager.selected} />
			{#if active === WELCOME && root !== undefined}
				{@const repo = root}
				<!-- Keyed, so another repo's welcome reads its own changes and past conversations. -->
				{#key repo}
					<RepoWelcome
						bind:this={repoWelcome}
						{repo}
						{home}
						sessions={$manager.sessions.map((r) => r.info)}
						repos={$manager.repos}
						connected={$manager.status === 'connected'}
						creating={$manager.creating}
						onstart={(cmd) => manager.create(repo, cmd, '')}
						onallpast={showPast}
						onresume={(cwd, cmd) => void manager.create(cwd, cmd, '')}
						onselect={selectSession}
						onreopen={(sid) => manager.reopen(sid)}
						report={(m) => manager.report(m)}
					/>
				{/key}
			{:else if active !== undefined && !isSessionTab(active)}
				{@const path = active}
				<FilePane bind:this={filePane} {path} repo={root} {home} readOnly={updating} onclose={() => void closeTabs([path])} onopenfile={(p) => openFromTree(p)} report={(m) => manager.report(m)} />
			{/if}
			{#if group === undefined}
				<AppWelcome bind:this={appWelcome} {version} addDisabled={$manager.status !== 'connected'} onaddrepo={() => void addRepo?.open()} onnewsession={newSession} />
			{/if}
		</div>
	</section>
	<!-- Unmounted, not hidden, while it is off, so nothing of the tree or the
	     changes runs and no folder is watched. -->
	{#if panelShown}
		<aside class="files">
			<FilesPanel
				{root}
				cwd={selectedRow?.info.cwd}
				{home}
				connected={$manager.status === 'connected'}
				creating={$manager.creating}
				sessions={$manager.sessions.map((r) => r.info)}
				repos={$manager.repos}
				highlight={active === undefined || active === WELCOME || isSessionTab(active) ? undefined : tabFile(active)}
				onopen={openFromTree}
				onopendiff={openDiff}
				onaddrepo={(f) => manager.addRepo(f)}
				onresume={(cwd, cmd) => void manager.create(cwd, cmd, '')}
				onselect={selectSession}
				onreopen={(sid) => manager.reopen(sid)}
				onleave={() => {
					if (!dialogOpen) focusContent();
				}}
				report={(m) => manager.report(m)}
			/>
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
