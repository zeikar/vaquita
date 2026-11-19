import type { LineCol } from './file-links';
import { fileName } from './tabs';
import { MONO_FONT } from './theme';

export type Monaco = typeof import('./monaco-setup');

let loading: Promise<Monaco> | undefined;

// What the text editor and the diff editor share.
export const EDITOR_OPTIONS = {
	theme: 'vs-dark',
	fontFamily: MONO_FONT,
	fontSize: 13,
	minimap: { enabled: false },
	// Long lines wrap, so there is no sideways scrolling.
	wordWrap: 'on',
	// WebKit has no EditContext, so typing goes through Monaco's hidden
	// textarea. With 'auto' it holds a page of text that WebKit scrolls a few
	// pixels off Monaco's alignment, which shakes the line while an IME
	// composes (monaco-editor#4796).
	accessibilitySupport: 'off',
} as const;

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

// Monaco's position for a link's line and column, kept within the file: a line
// past the last is the last, and a column past a line's end is its end.
export function cursorAt(at: LineCol, model: { getLineCount(): number; getLineMaxColumn(line: number): number }): { lineNumber: number; column: number } {
	const lineNumber = Math.min(at.line, model.getLineCount());
	return { lineNumber, column: Math.min(at.col ?? 1, model.getLineMaxColumn(lineNumber)) };
}
