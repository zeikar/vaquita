import { isTauri } from './tauri';
import { openExternal, type Opener } from './links';

export type OpenResult = { action: 'opened' } | { action: 'revealed'; why: string };
export type Invoker = (path: string, host: string) => Promise<OpenResult>;

// start and end are string indices into the line; the link provider maps them to
// terminal cells, where a wide character takes two.
export type PathHit = { start: number; end: number; target: string };

// What a click on a link hands the gate: its text, or a path joined across a
// line break (see path-link-provider) with a path it replaced, the one on the
// clicked row, which opens instead when the joined path does not exist.
export type LinkText = string | readonly [path: string, fallback: string];

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
// The first character of every shape isPath accepts, and of a file:// URL.
const PATH_START = new RegExp(`[/~${SEG_CHARS}]`, 'u');
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
// What may continue a path a TUI wrapped onto the next line: the characters of
// a segment and of separators and line suffixes, so whitespace and prose
// punctuation such as ( or , end it.
const RUN = new RegExp(`[${SEG_CHARS}/~=:]+`, 'uy');

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

// Boundaries the text does not show, as colour in a terminal: endsAt(i) ends
// a path before i, and startsAt(i) lets one begin at i.
export type Bounds = { endsAt(i: number): boolean; startsAt(i: number): boolean };
const NO_BOUNDS: Bounds = { endsAt: () => false, startsAt: () => false };

export function findPaths(line: string, bounds: Bounds = NO_BOUNDS): PathHit[] {
	const hits: PathHit[] = [];
	// Every start inside one run of non-TOKEN_END characters shares the run's end,
	// its trimmed stop and its line suffix, so they are found once per run: terminal
	// output is untrusted, and a long run of "(" must not cost a scan per character.
	let runEnd = -1;
	let stopRun = 0;
	let suffixAt = 0;
	let i = 0;
	while (i < line.length) {
		if ((i > 0 && !TOKEN_START.test(line[i - 1]) && !bounds.startsAt(i)) || !PATH_START.test(line[i])) {
			i++;
			continue;
		}
		if (i >= runEnd) {
			runEnd = i;
			while (runEnd < line.length && !TOKEN_END.test(line[runEnd]) && !(runEnd > i && bounds.endsAt(runEnd))) runEnd++;
			// Sentence punctuation goes first so that "a.ts:12." still ends in a line suffix.
			stopRun = runEnd;
			while (stopRun > i && '.,;:!?'.includes(line[stopRun - 1])) stopRun--;
			const m = LINE_SUFFIX.exec(line.slice(i, stopRun));
			suffixAt = m ? i + m.index : stopRun;
		}
		if (stopRun <= i) {
			i++;
			continue;
		}
		const token = line.slice(i, stopRun);
		// A suffix that begins before this start is not this token's: it finds its own.
		const bare = suffixAt >= i ? line.slice(i, suffixAt) : token.replace(LINE_SUFFIX, '');
		let target: string | undefined;
		if (token.startsWith('file://')) {
			if (fileUrlToPath(bare)) target = bare;
		} else if (!token.includes('://') && isPath(bare)) {
			target = bare;
		}
		if (target !== undefined) {
			hits.push({ start: i, end: stopRun, target });
			i = runEnd;
		} else {
			i++;
		}
	}
	return hits;
}

// Where the run of path characters that starts at from ends; from when there is
// none, or when it has no letter or digit, as a list's - or an ellipsis has not.
export function pathRun(text: string, from: number): number {
	RUN.lastIndex = from;
	const m = RUN.exec(text);
	return m && /[\p{L}\p{N}]/u.test(m[0]) ? from + m[0].length : from;
}

// Where the run of path characters that ends text at end begins, when it is a
// token of its own (after whitespace, a TOKEN_START character or nothing), has
// a / and does not end in sentence punctuation, as a relative folder (src/lib/)
// that is no path by itself; -1 when there is none.
export function pathRunBefore(text: string, end: number): number {
	let start = end;
	while (start > 0 && !TOKEN_START.test(text[start - 1])) start--;
	if (start === end || !text.slice(start, end).includes('/') || '.,;:!?'.includes(text[end - 1])) return -1;
	return pathRun(text, start) === end ? start : -1;
}

// Whether a path ends in a file name with an extension.
export function hasExtension(path: string): boolean {
	return EXTENSION.test(path);
}

export async function openPath(
	path: string,
	host: string,
	report: (m: string) => void,
	invoker: Invoker = defaultInvoker,
	fallback?: string,
): Promise<void> {
	try {
		const r = await invoker(path, host);
		if (r.action === 'revealed') report(`revealed in Finder, not opened: ${path} (${r.why})`);
	} catch (e) {
		// open_path's word for a path that does not exist, the one failure that
		// says a joined path was a wrong guess. The fallback may be another file
		// than the one the hover named, so the switch is told.
		if (fallback !== undefined && errText(e) === 'no such file') {
			report(`${path}: no such file, opening ${fallback}`);
			return openPath(fallback, host, report, invoker);
		}
		report(`open ${path}: ${errText(e)}`);
	}
}

// The only place that decides whether a click on terminal text opens anything.
export function activateUri(
	e: MouseEvent,
	text: LinkText,
	report: (m: string) => void,
	invoker: Invoker = defaultInvoker,
	opener?: Opener,
): void {
	if (!e.metaKey) return;
	const [uri, fallback] = typeof text === 'string' ? [text, undefined] : text;
	if (uri.startsWith('/') || uri === '~' || uri.startsWith('~/')) {
		void openPath(uri, '', report, invoker, fallback);
		return;
	}
	const file = fileUrlToPath(uri);
	if (file) {
		void openPath(file.path, file.host, report, invoker);
		return;
	}
	openExternal(uri, (err) => report(`open ${uri}: ${errText(err)}`), opener);
}
