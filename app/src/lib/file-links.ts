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
// The first character of every shape isPath accepts, and of a file:// URL.
const PATH_START = new RegExp(`[/~${SEG_CHARS}]`, 'u');
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
	// Every start inside one run of non-TOKEN_END characters shares the run's end,
	// its trimmed stop and its line suffix, so they are found once per run: terminal
	// output is untrusted, and a long run of "(" must not cost a scan per character.
	let runEnd = -1;
	let stopRun = 0;
	let suffixAt = 0;
	let i = 0;
	while (i < line.length) {
		if ((i > 0 && !TOKEN_START.test(line[i - 1])) || !PATH_START.test(line[i])) {
			i++;
			continue;
		}
		if (i >= runEnd) {
			runEnd = i;
			while (runEnd < line.length && !TOKEN_END.test(line[runEnd])) runEnd++;
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
