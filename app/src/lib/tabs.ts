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

// Tabs of a repo that is no longer registered would never be shown again.
export function prune(groups: TabGroups, repos: string[]): TabGroups {
	return Object.fromEntries(Object.entries(groups).filter(([key]) => key === OTHER || repos.includes(key)));
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
