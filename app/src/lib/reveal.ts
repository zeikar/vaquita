import { isTauri } from './tauri';

export type Revealer = (path: string) => Promise<void>;

// The plugin is loaded lazily so a plain-browser page never imports Tauri.
const defaultReveal: Revealer = async (path) => {
	const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
	await revealItemInDir(path);
};

// A plain browser has no way to Finder.
export function canReveal(): boolean {
	return isTauri();
}

export function revealInFinder(path: string, reveal: Revealer = defaultReveal): Promise<void> {
	return reveal(path);
}
