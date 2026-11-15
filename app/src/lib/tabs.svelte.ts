import { getCurrentWindow } from '@tauri-apps/api/window';
import { tick } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import type AppWelcome from './AppWelcome.svelte';
import { ask as askUser } from './ask';
import { diffTab } from './changes';
import { documents as appDocuments, type Documents } from './documents';
import type FilePane from './FilePane.svelte';
import { openPath } from './file-links';
import type { ManagedTerm, ManagerState, SessionManager, ViewLike } from './manager';
import { LAST_CWD } from './NewSessionDialog.svelte';
import { sessionTitle, type Target } from './notify';
import type RepoWelcome from './RepoWelcome.svelte';
import { arrangeGroup, isSessionTab, needsAsk, placement, sessionTab, tabSid } from './session-tabs';
import { load } from './storage';
import { closeInGroup, fallback, fileName, groupKey, loadTabs, neighbour, openFileTab, OTHER, saveTabs, setOrder, touch, unpreview, WELCOME, type Previews, type Recent } from './tabs';
import type { TermView } from './term-view';

// What the tabs ask of a session's view beside what the manager does.
export type TabView = ViewLike & Pick<TermView, 'focus' | 'refit' | 'sendInput'>;
export type TabDocuments = Pick<Documents, 'isDirty' | 'dropDocument' | 'onDirtyChange' | 'saveDocument'>;

export type TabsDeps<T extends ManagedTerm, V extends TabView> = {
	manager: SessionManager<T, V>;
	documents?: TabDocuments;
	ask?: (message: string, okLabel: string) => Promise<boolean>;
	closeWindow?: () => Promise<void>;
};

// The tabs of every group and what shows, outside any component, so that the
// app's parts and their tests read and change one state.
export class Tabs<T extends ManagedTerm = ManagedTerm, V extends TabView = TabView> {
	// The manager's state as $manager reads it in a component: it publishes a
	// new object every time, so every publish invalidates. Set by the
	// constructor's subscribe, which calls back at once.
	private state = $state.raw<ManagerState<V>>(null!);
	// The tabs of every group, files and sessions in one order, and the one
	// shown. A session's tab shows its terminal, the selected session's: showing
	// one selects it. WELCOME is a repo's welcome, shown over its session's
	// terminal or alone; it is no tab of any group. Undefined shows nothing, as
	// under the app welcome.
	groups = $state(loadTabs());
	active = $state<string>();
	// The preview tab of each group, for the app run only.
	previews = $state<Previews>({});
	// What each group showed, most recent first, for where closing the shown
	// tab goes. Per group, as the tabs are, and for the app run only; plain,
	// since nothing renders it.
	readonly recent = new Map<string, Recent>();
	readonly dirty = new SvelteSet<string>();
	// Bound by the markup; each is there only while its pane is mounted.
	filePane?: ReturnType<typeof FilePane>;
	repoWelcome?: ReturnType<typeof RepoWelcome>;
	appWelcome?: ReturnType<typeof AppWelcome>;
	dialogOpen = $state(false);
	dialogCwd = $state('');

	// The group whose bar shows: the selected session's, or the repo chosen
	// by its name, for the app run only (a relaunch selects the stored
	// session, or nothing); undefined shows the app welcome.
	group = $state<string>();
	readonly selectedRow = $derived(this.state.sessions.find((r) => r.info.sid === this.state.selected));
	// Where each session's tab belongs. The repo list the app starts with is
	// empty, so until the daemon's the stored keys alone show; a session list
	// kept through a reconnect still shows its tabs.
	readonly placed = $derived(placement(this.state.sessions.map((r) => r.info), this.state.repos));
	// Whether the lists are the daemon's current ones, for what drops or
	// leaves a tab on their word.
	readonly listed = $derived(this.state.status === 'connected' && this.state.reposListed);
	readonly groupTabs = $derived.by(() => {
		if (this.group === undefined) return [];
		const sids = this.state.reposListed ? [...this.placed].flatMap(([sid, key]) => (key === this.group ? [sid] : [])) : [];
		return arrangeGroup(this.groups[this.group] ?? [], sids);
	});
	// The repo whose tree the file panel shows: the shown group, unless that
	// is no repo.
	readonly root = $derived(this.group !== OTHER ? this.group : undefined);

	private readonly manager: SessionManager<T, V>;
	private readonly documents: TabDocuments;
	private readonly ask: (message: string, okLabel: string) => Promise<boolean>;
	private readonly closeWindow: () => Promise<void>;
	private readonly stops: (() => void)[];

	constructor({ manager, documents = appDocuments, ask = askUser, closeWindow = () => getCurrentWindow().close() }: TabsDeps<T, V>) {
		this.manager = manager;
		this.documents = documents;
		this.ask = ask;
		this.closeWindow = closeWindow;
		this.stops = [
			manager.subscribe((s) => (this.state = s)),
			// An edit keeps a preview tab, in every group that has it.
			documents.onDirtyChange((path, d) => {
				if (d) {
					this.dirty.add(path);
					this.previews = unpreview(this.previews, path);
				} else this.dirty.delete(path);
			}),
		];
	}

	stop(): void {
		for (const s of this.stops) s();
	}

	// A session of this run with a tab is selected: a record of an earlier
	// run, selected through a daemon restart, holds no group.
	selectedPlaced(): boolean {
		return this.state.selected !== undefined && this.placed.has(this.state.selected);
	}

	selectedView(): V | undefined {
		const { sessions, selected } = this.state;
		return sessions.find((r) => r.info.sid === selected)?.view;
	}

	// Where the shown group goes when what it showed is gone: the tab shown
	// most recently, else its first, else the repo's welcome; Other, which
	// has no welcome, is then no selection any more.
	showFallback(): void {
		const next = fallback((this.group !== undefined && this.recent.get(this.group)) || [], this.groupTabs) ?? (this.root !== undefined ? WELCOME : undefined);
		if (next === undefined && this.group === OTHER) this.group = undefined;
		void this.show(next);
	}

	// A repo's name in the sidebar shows its welcome. A session of that repo
	// stays selected, its terminal covered as by a file; any other is
	// deselected, so the repo is the selection. Not under the new-session
	// dialog, which keeps what it opened over, as show does.
	openWelcome(repo: string): void {
		if (this.dialogOpen) return;
		if (this.selectedRow === undefined || groupKey(this.selectedRow.info.cwd, this.state.repos) !== repo) this.manager.deselect();
		this.group = repo;
		void this.show(WELCOME);
	}

	// The Other group's name, shown while it holds file tabs, selects them:
	// the way back to edits that moved there when their repo was removed. Its
	// most recent tab shows, as closing one would go; no welcome, it is no repo.
	openOther(): void {
		if (this.dialogOpen) return;
		if (this.selectedRow === undefined || groupKey(this.selectedRow.info.cwd, this.state.repos) !== OTHER) this.manager.deselect();
		this.group = OTHER;
		const next = fallback(this.recent.get(OTHER) ?? [], this.groupTabs);
		if (next !== undefined) void this.show(next);
	}

	// What shows takes the focus, so that typing never reaches a terminal
	// covered by a file or a welcome.
	focusContent = (): void => {
		if (this.active === WELCOME) this.repoWelcome?.focus();
		else if (this.active === undefined) this.appWelcome?.focus();
		else if (isSessionTab(this.active)) this.selectedView()?.focus();
		else this.filePane?.focus();
	};

	// Under the new-session dialog the dialog keeps the focus.
	refocus = (): void => {
		if (!this.dialogOpen) this.focusContent();
	};

	// No file and no welcome under the new-session dialog: it gives the focus
	// back to what had it when it opened, which may be the terminal they would
	// cover. A session's tab can show, as when the session it creates is
	// selected; the dialog keeps the focus then.
	async show(path: string | undefined): Promise<void> {
		if (this.dialogOpen && path !== undefined && !isSessionTab(path)) return;
		this.active = path;
		const sid = path === undefined ? undefined : tabSid(path);
		if (sid !== undefined && sid !== this.state.selected) this.manager.select(sid);
		// Every change of the shown tab ends here, so this one line keeps the
		// list. The welcome is no tab that closing one could go back to.
		if (this.group !== undefined && path !== undefined && path !== WELCOME) this.recent.set(this.group, touch(this.recent.get(this.group) ?? [], path));
		// The file pane is there to take the focus only once it has rendered.
		await tick();
		this.refocus();
	}

	// A repo's welcome with no tabs has nothing to step to. Nothing switches
	// under the new-session dialog, which keeps what it opened over.
	step(by: number): void {
		if (this.dialogOpen) return;
		const next = neighbour(this.groupTabs, this.active, by);
		if (next !== undefined) void this.show(next);
	}

	// ⌘1-9: the group's tab at that place, counted from 1.
	showAt(n: number): void {
		if (!this.dialogOpen && n <= this.groupTabs.length) void this.show(this.groupTabs[n - 1]);
	}

	// The manager selects a notification's session only if that very session
	// is still there.
	openNotified(target?: Target): void {
		// The same session stays selected, so nothing else shows its tab.
		const same = target !== undefined && this.selectedRow?.info.sid === target.sid && this.selectedRow.info.inc === target.inc;
		this.manager.openNotified(target);
		if (same) void this.show(sessionTab(target.sid));
	}

	// A session's row in the sidebar, or a past conversation's open row, asks
	// for its tab: as openNotified, the same session staying selected, the
	// file or its repo's welcome covering it goes.
	selectSession = (sid: number): void => {
		const same = sid === this.state.selected;
		this.manager.select(sid);
		if (same) void this.show(sessionTab(sid));
	};

	// The dialog starts in the shown repo, else in the folder it last created
	// a session in, else in the home folder.
	newSession = (): void => {
		if (this.dialogOpen) return;
		this.dialogCwd = (this.group !== OTHER ? this.group : undefined) ?? load(LAST_CWD) ?? '';
		this.dialogOpen = true;
	};

	// A ⌘-clicked file in a session's terminal; cwd is its starting folder.
	// Unpinned, it opens as the group's preview. A dirty document opens pinned:
	// documents are shared by path across groups, so it may hold another
	// group's edits, and a preview, which the next file replaces, holds none.
	openFile(cwd: string, path: string, pin = false): void {
		const r = openFileTab(this.groups, this.previews, groupKey(cwd, this.state.repos), path, pin || this.documents.isDirty(path));
		this.groups = r.groups;
		this.previews = r.previews;
		if (r.drop !== undefined) this.documents.dropDocument(r.drop);
		saveTabs(this.groups);
		void this.show(path);
	}

	// A file's diff against HEAD, as a tab of the shown group: the repo the
	// changes were listed for, which Other is not.
	openDiff = (path: string, pin = false): void => {
		if (this.group === undefined || this.group === OTHER) return;
		const r = openFileTab(this.groups, this.previews, this.group, diffTab(path), pin);
		this.groups = r.groups;
		this.previews = r.previews;
		// The preview it took the place of, a file tab's maybe.
		if (r.drop !== undefined) this.documents.dropDocument(r.drop);
		saveTabs(this.groups);
		void this.show(diffTab(path));
	};

	// The order a drag on the bar left the group's tabs in, kept across restarts.
	reorder = (order: string[]): void => {
		if (this.group === undefined) return;
		this.groups = setOrder(this.groups, this.group, order);
		saveTabs(this.groups);
	};

	pin(path: string): void {
		this.previews = unpreview(this.previews, path);
	}

	// A file clicked in the tree goes through the gate a ⌘-click does, so what
	// the app does not show in a tab is opened or revealed the same way. Its tab
	// lands in the shown group, the tree's repo.
	openFromTree = (path: string, pin = false): void => {
		const cwd = this.selectedRow?.info.cwd ?? this.root;
		if (cwd === undefined) return;
		void openPath(path, '', (m, tone) => this.manager.report(m, tone), (p) => this.openFile(cwd, p, pin));
	};

	// By path, not through an editor, so a tab that shows no editor saves too.
	save(): void {
		if (this.active !== undefined) void this.documents.saveDocument(this.active, (m) => this.manager.report(m));
	}

	// Asked before unsaved edits or a working session are lost; false when the
	// user keeps them or the question could not be asked.
	private async mayLose(message: string, okLabel: string, about = 'unsaved changes'): Promise<boolean> {
		try {
			return await this.ask(message, okLabel);
		} catch (e) {
			this.manager.report(`asking about ${about} failed: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}

	// File keys and session keys: the files close, the sessions are killed.
	// Falling back from a killed session's tab is the fallback effect's, as
	// the session leaves the list only later.
	async close(keys: string[]): Promise<void> {
		const files = keys.filter((k) => !isSessionTab(k));
		if (files.length > 0) await this.closeFileTabs(files);
		const sids = keys.flatMap((k) => tabSid(k) ?? []);
		if (sids.length > 0) await this.killSessions(sids);
	}

	// An agent mid-turn or waiting on a permission is asked about once; the
	// rest are killed at once, an exited one's record going with its kill.
	// Only the sessions that are still the same ones after the question: a sid
	// with another inc is another session, from a restarted daemon.
	private async killSessions(sids: number[]): Promise<void> {
		const rows = this.state.sessions.filter((r) => sids.includes(r.info.sid));
		// Session closes come one at a time, so the question names one session.
		const working = rows.find((r) => needsAsk(r.info));
		if (working && !(await this.mayLose(`${sessionTitle(working.info)} is working. Kill it?`, 'Kill', 'killing a working session'))) return;
		for (const r of rows) if (this.state.sessions.some((n) => n.info.sid === r.info.sid && n.info.inc === r.info.inc)) this.manager.kill(r.info.sid);
	}

	// One question for all the unsaved among them; declined, nothing closes,
	// so the bar is not left half-changed under the answer.
	// Only the documents that go are asked about: edits in a path another group
	// still has stay reachable from its tab there.
	private async closeFileTabs(paths: string[]): Promise<void> {
		const key = this.group;
		if (key === undefined) return;
		const unsaved = closeInGroup(this.groups, this.previews, key, paths).drop.filter((p) => this.documents.isDirty(p));
		if (unsaved.length > 0) {
			const question =
				unsaved.length === 1
					? `${fileName(unsaved[0])} has unsaved changes. Close it?`
					: `${unsaved.length} files have unsaved changes. Close them?`;
			if (!(await this.mayLose(question, 'Close'))) return;
		}
		// Again on the tabs as they are after the question, which a repo list
		// from the daemon may have moved; closing stops if that left an unsaved
		// document going that was not asked about, its tabs kept.
		const r = closeInGroup(this.groups, this.previews, key, paths);
		if (r.drop.some((p) => this.documents.isDirty(p) && !unsaved.includes(p))) {
			this.manager.report('The tabs changed while asking; nothing was closed.');
			return;
		}
		for (const p of r.drop) this.documents.dropDocument(p);
		this.groups = r.groups;
		this.previews = r.previews;
		saveTabs(this.groups);
		if (this.active !== undefined && paths.includes(this.active) && this.group === key) this.showFallback();
	}

	// ⌘W: the tab shown; the welcome is set aside like a tab while the group
	// has tabs; otherwise the window, as the menu's Close Window did. A menu
	// key reaches the page under the new-session dialog too, where it closes
	// the dialog, as Escape does, and nothing behind it.
	closeActive(): void {
		if (this.dialogOpen) this.dialogOpen = false;
		else if (this.active !== undefined && this.active !== WELCOME) void this.close([this.active]);
		else if (this.active === WELCOME && this.groupTabs.length > 0) void this.show(fallback((this.group !== undefined && this.recent.get(this.group)) || [], this.groupTabs));
		else this.closeWindow().catch((e) => this.manager.report(`closing the window failed: ${e instanceof Error ? e.message : String(e)}`));
	}

	// For what ends the app run: true at once when nothing is unsaved.
	async mayLoseAll(question: string, okLabel: string): Promise<boolean> {
		const n = this.dirty.size;
		return n === 0 || (await this.mayLose(`${n === 1 ? '1 file has' : `${n} files have`} unsaved changes. ${question}`, okLabel));
	}
}
