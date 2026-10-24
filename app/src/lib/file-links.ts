import { isTauri } from './tauri';
import { openExternal, type Opener } from './links';

export type OpenResult = { action: 'opened' } | { action: 'revealed'; why: string };
export type Invoker = (path: string, host: string) => Promise<OpenResult>;

// start and end are string indices into the line; the link provider maps them to
// terminal cells, where a wide character takes two.
export type PathHit = { start: number; end: number; target: string };

const defaultInvoker: Invoker = async (path, host) => {
	if (!isTauri()) throw new Error('file links open only in the app');
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke<OpenResult>('open_path', { path, host });
};

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// Not `new URL`: it would cut a file name at a # or ?.
export function fileUrlToPath(uri: string): { host: string; path: string } | undefined {
	const m = /^file:\/\/([^/]*)(\/[\s\S]*)$/.exec(uri);
	if (!m) return undefined;
	let path = m[2];
	try {
		path = decodeURIComponent(path);
	} catch {
		// Keep the raw text: a stray % is more likely part of a name than an escape.
	}
	return { host: m[1], path };
}

// Relative text is resolved against the session's starting folder; an empty cwd
// is the home directory (see shortPath), and Rust expands the ~.
export function resolvePath(target: string, cwd: string): string {
	if (target === '~' || target.startsWith('/') || target.startsWith('~/') || target.startsWith('file:')) return target;
	if (cwd === '') return '~/' + target;
	return cwd.replace(/\/+$/, '') + '/' + target;
}

const SEG_CHARS = String.raw`\p{L}\p{N}\p{M}_.\-+@%#$`;
const SEG = `[${SEG_CHARS}]`;
const ANCHOR = /^(\/|~\/|\.\/|\.\.\/)([^/][\s\S]*)$/;
const RELATIVE = new RegExp(String.raw`^${SEG}+(?:\/${SEG}+)+$`, 'u');
const EXTENSION = /\.\p{L}[\p{L}\p{N}]*$/u;
const TOKEN_START = /[\s(["'`=,]/u;
const TOKEN_END = /[\s"'`)\]<>,]/u;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

function isPath(text: string): boolean {
	if (text === '~') return true;
	const m = ANCHOR.exec(text);
	if (m) {
		// A lone /word (/help, /model) is a slash command far more often than a file,
		// and // starts a comment; neither should be underlined all over the screen.
		return m[1] !== '/' || m[2].includes('/') || EXTENSION.test(m[2]);
	}
	// Without an extension, and/or, 2026/10/24 and TCP/IP would all look like paths.
	return RELATIVE.test(text) && EXTENSION.test(text);
}

export function findPaths(line: string): PathHit[] {
	const hits: PathHit[] = [];
	let i = 0;
	while (i < line.length) {
		if (i > 0 && !TOKEN_START.test(line[i - 1])) {
			i++;
			continue;
		}
		let end = i;
		while (end < line.length && !TOKEN_END.test(line[end])) end++;
		if (end === i) {
			i++;
			continue;
		}
		// Sentence punctuation goes first so that "a.ts:12." still ends in a line suffix.
		let stop = end;
		while (stop > i && '.,;:!?'.includes(line[stop - 1])) stop--;
		const token = line.slice(i, stop);
		const bare = token.replace(LINE_SUFFIX, '');
		let target: string | undefined;
		if (token.startsWith('file://')) {
			if (fileUrlToPath(bare)) target = bare;
		} else if (!token.includes('://') && isPath(bare)) {
			target = bare;
		}
		if (target !== undefined) {
			hits.push({ start: i, end: stop, target });
			i = end;
		} else {
			i++;
		}
	}
	return hits;
}

export async function openPath(
	path: string,
	host: string,
	report: (m: string) => void,
	invoker: Invoker = defaultInvoker,
): Promise<void> {
	try {
		const r = await invoker(path, host);
		if (r.action === 'revealed') report(`revealed in Finder, not opened: ${path} (${r.why})`);
	} catch (e) {
		report(`open ${path}: ${errText(e)}`);
	}
}

// The only place that decides whether a click on terminal text opens anything.
export function activateUri(
	e: MouseEvent,
	text: string,
	report: (m: string) => void,
	invoker: Invoker = defaultInvoker,
	opener?: Opener,
): void {
	if (!e.metaKey) return;
	if (text.startsWith('/') || text === '~' || text.startsWith('~/')) {
		void openPath(text, '', report, invoker);
		return;
	}
	const file = fileUrlToPath(text);
	if (file) {
		void openPath(file.path, file.host, report, invoker);
		return;
	}
	openExternal(text, (err) => report(`open ${text}: ${errText(err)}`), opener);
}
