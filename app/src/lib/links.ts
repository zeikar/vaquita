import { isTauri } from './tauri';

export type Opener = (uri: string) => void | Promise<void>;

const ALLOWED = new Set(['http:', 'https:', 'mailto:']);

const defaultOpener: Opener = async (uri) => {
	if (isTauri()) {
		const { openUrl } = await import('@tauri-apps/plugin-opener');
		await openUrl(uri);
	} else {
		window.open(uri, '_blank', 'noopener');
	}
};

// Terminal output is untrusted, so only web and mail links are opened.
export function openExternal(uri: string, onError: (e: unknown) => void, opener: Opener = defaultOpener): void {
	let protocol: string;
	try {
		protocol = new URL(uri).protocol;
	} catch {
		return;
	}
	if (!ALLOWED.has(protocol)) return;
	void Promise.resolve(opener(uri)).catch(onError);
}
