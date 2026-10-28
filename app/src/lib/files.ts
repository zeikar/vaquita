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

export type TabAction = 'close' | 'terminal' | 'prev' | 'next';

function isTabAction(v: unknown): v is TabAction {
	return v === 'close' || v === 'terminal' || v === 'prev' || v === 'next';
}

// Runs run on each tab command of the app menu; resolves to a function that
// stops listening.
export async function onTabAsked(run: (a: TabAction) => void): Promise<() => void> {
	if (!isTauri()) return () => {};
	const { listen } = await import('@tauri-apps/api/event');
	return listen<string>('tab', (e) => {
		if (isTabAction(e.payload)) run(e.payload);
	});
}
