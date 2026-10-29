import { isTauri } from './tauri';

export type FileKind = 'text' | 'markdown' | 'image' | 'audio' | 'video';

// A file's modification time and length when it was read; a save sends it back
// so that the app can tell the file changed in between.
export type Stamp = { secs: number; nanos: number; len: number };

export type Viewable = { path: string; kind: FileKind };

// files.rs's word for a save refused because the file is no longer the one read.
export const CHANGED_ON_DISK = 'changed on disk';

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
	if (!isTauri()) throw new Error('files open only in the app');
	const { invoke } = await import('@tauri-apps/api/core');
	try {
		return await invoke<T>(cmd, args);
	} catch (e) {
		// Rust errors arrive as plain strings.
		throw e instanceof Error ? e : new Error(String(e));
	}
}

// Judges the file afresh and, for media, lets the webview load it by URL.
export function viewPath(path: string): Promise<Viewable> {
	return call('view_path', { path });
}

export function readText(path: string): Promise<{ text: string; stamp: Stamp }> {
	return call('read_text', { path });
}

// With a stamp, the save is refused when the file changed since it was read.
export function writeText(path: string, text: string, stamp?: Stamp): Promise<Stamp> {
	return call('write_text', { path, text, expect: stamp ?? null });
}

// Only for a path view_path just judged: the asset scope allows no other.
export async function fileUrl(path: string): Promise<string> {
	const { convertFileSrc } = await import('@tauri-apps/api/core');
	return convertFileSrc(path);
}

export type TabAction = 'close' | 'terminal' | 'prev' | 'next' | 'files';

function isTabAction(v: unknown): v is TabAction {
	return v === 'close' || v === 'terminal' || v === 'prev' || v === 'next' || v === 'files';
}

// Runs run on each action the View menu sends (the tabs' and the file panel's); resolves to a function that
// stops listening.
export async function onTabAsked(run: (a: TabAction) => void): Promise<() => void> {
	if (!isTauri()) return () => {};
	const { listen } = await import('@tauri-apps/api/event');
	return listen<string>('tab', (e) => {
		if (isTabAction(e.payload)) run(e.payload);
	});
}

// `ignored` is whether git ignores the entry; false outside a repo.
export type Entry = { name: string; dir: boolean; ignored: boolean };

// `total` counts the folder's entries; `entries` holds at most the first 2000 of them.
// `canonical` is the folder with its links resolved, as a tab's path is.
export type Listing = { entries: Entry[]; total: number; canonical: string };

// A folder set_watched could not resolve, with the reason.
export type Refused = { path: string; error: string };

export function readFolder(path: string): Promise<Listing> {
	return call('read_folder', { path });
}

// The set is replaced whole, and Rust ignores a call whose generation is below the last one it
// applied, so a late answer to an older set can never undo a newer one.
export function setWatched(generation: number, folders: string[]): Promise<Refused[]> {
	return call('set_watched', { generation, folders });
}

// Runs run with the watched folders whose listing changed; resolves to a function that stops
// listening.
export async function onFolderChanged(run: (folders: string[]) => void): Promise<() => void> {
	if (!isTauri()) return () => {};
	const { listen } = await import('@tauri-apps/api/event');
	return listen<unknown>('folder-changed', (e) => {
		if (Array.isArray(e.payload) && e.payload.every((f) => typeof f === 'string')) run(e.payload);
	});
}

// `status` is U for untracked and C for a conflict. `path` is relative to the
// repo's toplevel, `abs` is the form a tab holds, `from` is a rename's old path. The counts are null for a
// binary or large file.
export type Change = {
	path: string;
	abs: string;
	status: 'M' | 'A' | 'D' | 'R' | 'U' | 'C';
	added: number | null;
	removed: number | null;
	from: string | null;
};

// `root` is the toplevel, canonical; `entries` holds at most the first 2000 of `total`.
export type ChangeList = { root: string; entries: Change[]; total: number };

// A side that does not exist is null: no HEAD version for a new file, no file on disk for a deleted one.
export type Sides = { head: string | null; work: string | null };

// The repo's uncommitted changes against HEAD.
export function gitChanges(root: string): Promise<ChangeList> {
	return call('git_changes', { root });
}

// The texts of one file at HEAD and on disk, or the reason they cannot be shown.
export function diffSides(root: string, path: string): Promise<Sides> {
	return call('diff_sides', { root, path });
}

// Like setWatched, one recursive watch of a repo (null: none), replaced whole under a generation.
export function watchRepo(generation: number, root: string | null): Promise<void> {
	return call('watch_repo', { generation, root });
}

// Runs run with the repo's root, as registered, when a change worth a new list happened in it;
// resolves to a function that stops listening.
export async function onRepoChanged(run: (root: string) => void): Promise<() => void> {
	if (!isTauri()) return () => {};
	const { listen } = await import('@tauri-apps/api/event');
	return listen<unknown>('repo-changed', (e) => {
		if (typeof e.payload === 'string') run(e.payload);
	});
}
