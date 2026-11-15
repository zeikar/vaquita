import { SvelteSet } from 'svelte/reactivity';
import { documents as appDocuments, type Documents } from './documents';
import type { ManagedTerm, ManagerState, SessionManager, ViewLike } from './manager';
import { arrangeGroup, placement } from './session-tabs';
import { loadTabs, OTHER, unpreview, type Previews, type Recent } from './tabs';
import type { TermView } from './term-view';

// What the tabs ask of a session's view beside what the manager does.
export type TabView = ViewLike & Pick<TermView, 'focus' | 'refit' | 'sendInput'>;
export type TabDocuments = Pick<Documents, 'isDirty' | 'dropDocument' | 'onDirtyChange' | 'saveDocument'>;

export type TabsDeps<T extends ManagedTerm, V extends TabView> = {
	manager: SessionManager<T, V>;
	documents?: TabDocuments;
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

	private readonly stops: (() => void)[];

	constructor({ manager, documents = appDocuments }: TabsDeps<T, V>) {
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
}
