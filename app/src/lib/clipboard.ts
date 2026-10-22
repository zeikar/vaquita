import { isTauri } from './tauri';

export type ClipboardWriter = (text: string) => Promise<void>;

// The plugin is loaded lazily so a plain-browser page never imports Tauri.
// Write only: the app has no clipboard read permission.
const defaultWriter: ClipboardWriter = async (text) => {
	if (isTauri()) {
		const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
		await writeText(text);
	} else {
		await navigator.clipboard.writeText(text);
	}
};

export function writeClipboard(text: string, writer: ClipboardWriter = defaultWriter): Promise<void> {
	return writer(text);
}
