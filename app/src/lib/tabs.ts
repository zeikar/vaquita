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

// A group left with no tabs is dropped so the stored JSON does not collect empties.
export function closeTab(groups: TabGroups, key: string, path: string): TabGroups {
	const { [key]: tabs, ...rest } = groups;
	const left = (tabs ?? []).filter((p) => p !== path);
	return left.length > 0 ? { ...rest, [key]: left } : rest;
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
