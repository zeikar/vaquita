import { repoOf } from './groups';
import { load, save } from './storage';

// Open file tabs per group: the repo path, or OTHER for sessions under no repo
// (the same key the session list uses for that group). Repo keys are absolute
// paths, so none can collide with OTHER.
export const TABS_KEY = 'vaquita.file-tabs';
export const OTHER = 'other';

export type TabGroups = Record<string, string[]>;

export function groupKey(cwd: string, repos: string[]): string {
	return repoOf(cwd, repos) ?? OTHER;
}

export function fileName(path: string): string {
	return path.split('/').filter((p) => p !== '').pop() ?? path;
}

export function openTab(groups: TabGroups, key: string, path: string): TabGroups {
	const tabs = groups[key] ?? [];
	return tabs.includes(path) ? { ...groups } : { ...groups, [key]: [...tabs, path] };
}

// The preview tab of each group, by key: the one the next opened file takes the
// place of. In memory for the app run only; a tab restored after a relaunch is
// a normal one, and the stored tabs keep their shape.
export type Previews = Record<string, string>;

// Replaced in place, so the tab stays where the file opened and the order of
// the group is not churned by every click in the tree.
export function openPreview(groups: TabGroups, previews: Previews, key: string, path: string): { groups: TabGroups; previews: Previews; replaced?: string } {
	const tabs = groups[key] ?? [];
	if (tabs.includes(path)) return { groups, previews };
	const old = previews[key];
	const at = old === undefined ? -1 : tabs.indexOf(old);
	if (at < 0) return { groups: { ...groups, [key]: [...tabs, path] }, previews: { ...previews, [key]: path } };
	return { groups: { ...groups, [key]: tabs.with(at, path) }, previews: { ...previews, [key]: path }, replaced: old };
}

// A pin, by an edit or a double-click, or a close: the path is no group's
// preview any more.
export function unpreview(previews: Previews, path: string): Previews {
	return Object.fromEntries(Object.entries(previews).filter(([, p]) => p !== path));
}

// Opens a file in a group, pinned or as its preview. drop is the replaced
// preview's path when no group has it as a tab any more, so its document can
// go: documents are shared by path across groups, and one still open elsewhere
// stays. The caller pins a path whose document is dirty, as it may hold
// another group's edits and a preview must have none.
export function openFileTab(groups: TabGroups, previews: Previews, key: string, path: string, pin: boolean): { groups: TabGroups; previews: Previews; drop?: string } {
	if (pin) return { groups: openTab(groups, key, path), previews: unpreview(previews, path) };
	const { replaced, ...r } = openPreview(groups, previews, key, path);
	if (replaced === undefined || Object.values(r.groups).some((tabs) => tabs.includes(replaced))) return r;
	return { ...r, drop: replaced };
}

// Closes paths among a group's tabs. drop is those no group has as a tab any
// more, whose documents go once unsaved edits in them are asked about; one
// still open in another group keeps its document, edits and all, reachable
// from there. Only this group's preview is unpinned: the path stays the
// preview of any other group that has it.
export function closeInGroup(groups: TabGroups, previews: Previews, key: string, paths: string[]): { groups: TabGroups; previews: Previews; drop: string[] } {
	const present = paths.filter((p) => groups[key]?.includes(p));
	const left = closeTabs(groups, key, present);
	const drop = present.filter((p) => !Object.values(left).some((tabs) => tabs.includes(p)));
	const { [key]: preview, ...rest } = previews;
	return { groups: left, previews: preview !== undefined && present.includes(preview) ? rest : previews, drop };
}

// A group left with no tabs is dropped so the stored JSON does not collect empties.
export function closeTabs(groups: TabGroups, key: string, paths: string[]): TabGroups {
	const { [key]: tabs, ...rest } = groups;
	const left = (tabs ?? []).filter((p) => !paths.includes(p));
	return left.length > 0 ? { ...rest, [key]: left } : rest;
}

export function moveTab(tabs: string[], path: string, to: number): string[] {
	if (!tabs.includes(path)) return tabs;
	const rest = tabs.filter((p) => p !== path);
	return [...rest.slice(0, to), path, ...rest.slice(to)];
}

// The order a drag reported, checked against the group's tabs as they are on
// release: a tab closed during the drag does not come back, and one opened
// meanwhile goes last instead of vanishing.
export function setOrder(groups: TabGroups, key: string, order: string[]): TabGroups {
	const tabs = groups[key];
	if (tabs === undefined) return groups;
	return { ...groups, [key]: [...order.filter((p) => tabs.includes(p)), ...tabs.filter((p) => !order.includes(p))] };
}

// The strip is the terminal (undefined) followed by the tabs, and wraps around.
export function neighbour(tabs: string[], active: string | undefined, step: number): string | undefined {
	const n = tabs.length + 1;
	const at = active === undefined ? 0 : tabs.indexOf(active) + 1;
	// An active path that is not in the list counts as the terminal.
	const next = (((at + step) % n) + n) % n;
	return next === 0 ? undefined : tabs[next - 1];
}

// The tabs of one group in the order they were last shown, most recent first;
// undefined is the terminal. Kept per group for the app run only. A closed
// path may stay in the list: fallback skips what is not open, and a reopened
// file is shown, which moves it to the front anyway.
export type Recent = (string | undefined)[];

export function touch(recent: Recent, shown: string | undefined): Recent {
	return [shown, ...recent.filter((p) => p !== shown)];
}

// Where closing the shown tab goes: the most recently shown tab still open,
// else the terminal.
export function fallback(recent: Recent, tabs: string[]): string | undefined {
	return recent.find((p) => p === undefined || tabs.includes(p));
}

// Tabs of a repo that is no longer registered would never be shown again, so
// they move to the group its sessions fall into now (a registered parent repo,
// else OTHER), where an unsaved edit in one is still reachable. The same object
// comes back when no repo went.
export function prune(groups: TabGroups, repos: string[]): TabGroups {
	const gone = Object.keys(groups).filter((key) => key !== OTHER && !repos.includes(key));
	if (gone.length === 0) return groups;
	const kept: TabGroups = Object.fromEntries(Object.entries(groups).filter(([key]) => !gone.includes(key)));
	for (const key of gone) {
		const to = groupKey(key, repos);
		let tabs = kept[to] ?? [];
		for (const p of groups[key]) if (!tabs.includes(p)) tabs = [...tabs, p];
		kept[to] = tabs;
	}
	return kept;
}

// Anything that is not an object of string arrays leaves no tabs open; stray
// non-string entries inside an array are dropped.
export function parseStored(json: string | null): TabGroups {
	if (json === null) return {};
	let v: unknown;
	try {
		v = JSON.parse(json);
	} catch (e) {
		console.warn(`${TABS_KEY} is not JSON:`, e);
		return {};
	}
	if (typeof v !== 'object' || v === null || Array.isArray(v)) {
		console.warn(`${TABS_KEY} is not an object`);
		return {};
	}
	const groups: TabGroups = {};
	for (const [key, tabs] of Object.entries(v)) {
		if (!Array.isArray(tabs)) continue;
		const paths = tabs.filter((p): p is string => typeof p === 'string');
		if (paths.length > 0) groups[key] = [...new Set(paths)];
	}
	return groups;
}

export function loadTabs(): TabGroups {
	return parseStored(load(TABS_KEY));
}

export function saveTabs(groups: TabGroups): void {
	save(TABS_KEY, JSON.stringify(groups));
}
