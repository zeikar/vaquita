import { fileName } from './tabs';

export type Monaco = typeof import('./monaco-setup');

let loading: Promise<Monaco> | undefined;

// The one way into Monaco: a dynamic import, so its chunk loads with the first
// text tab and not before.
export function loadMonaco(): Promise<Monaco> {
	loading ??= import('./monaco-setup');
	return loading;
}

// By file name (Dockerfile, Makefile …), else by the longest extension the
// name ends with.
export function languageFor(monaco: Pick<Monaco, 'languages'>, path: string): string {
	const name = fileName(path);
	const lower = name.toLowerCase();
	let best = { id: 'plaintext', length: 0 };
	for (const l of monaco.languages.getLanguages()) {
		if (l.filenames?.includes(name)) return l.id;
		for (const ext of l.extensions ?? []) {
			if (ext.length > best.length && lower.endsWith(ext.toLowerCase())) best = { id: l.id, length: ext.length };
		}
	}
	return best.id;
}
