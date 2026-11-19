import { isTauri } from './tauri';
import { openExternal, type Opener } from './links';
import type { Tone } from './manager';

// opened: handed to the default app. revealed: shown in Finder, not opened.
// view: a file the app shows in a tab itself; path is the canonical one.
export type OpenResult = { action: 'opened' } | { action: 'revealed'; why: string } | { action: 'view'; path: string };
export type Invoker = (path: string, host: string) => Promise<OpenResult>;

// A line and column in a file, both counted from 1, as a :line[:col] suffix
// gives them.
export type LineCol = { line: number; col?: number };

// start and end are string indices into the line; the link provider maps them to
// terminal cells, where a wide character takes two. name marks a bare file name,
// which names no place by itself: the app looks up which file it is. at is
// what a line suffix in the range says, for the editor to go to.
export type PathHit = { start: number; end: number; target: string; name?: true; at?: LineCol };

// What a click on a link hands the gate: its text, or a path joined across a
// line break (see path-link-provider) with a path it replaced, the one on the
// clicked row, which opens instead when the joined path does not exist. A join
// the hover's check found missing is not given, so this is for one it could
// not confirm (or one removed since).
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

// A segment's characters but $, which in a shell value starts another variable.
const PLAIN_CHARS = String.raw`\p{L}\p{N}\p{M}_.\-+@%#`;
const SEG_CHARS = PLAIN_CHARS + '$';
const SEG = `[${SEG_CHARS}]`;
const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const ANCHOR = new RegExp(String.raw`^(\/|~\/|\.\/|\.\.\/|\$${NAME}\/|\$\{${NAME}\}\/)([^/][\s\S]*)$`);
const VAR_PATH = new RegExp(String.raw`^\$(?:(${NAME})|\{(${NAME})\})(\/[\s\S]*)$`);
const RELATIVE = new RegExp(String.raw`^${SEG}+(?:\/${SEG}+)+$`, 'u');
const EXTENSION = /\.\p{L}[\p{L}\p{N}]*$/u;
// A bare name has no $, which a shell would expand, so $X.ts is no file's name.
const PLAIN_NAME = new RegExp(`^[${PLAIN_CHARS}]+$`, 'u');
const TOKEN_START = /[\s(["'`=,]/u;
const TOKEN_END = /[\s"'`)\]<>,]/u;
// The first character of every shape isPath accepts, and of a file:// URL.
const PATH_START = new RegExp(`[/~${SEG_CHARS}]`, 'u');
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
// What may continue a path a TUI wrapped onto the next line: the characters of
// a segment and of separators and line suffixes, so whitespace and prose
// punctuation such as ( or , end it.
const RUN = new RegExp(`[${SEG_CHARS}/~=:]+`, 'uy');

// Terminal output is untrusted, so a number no file has, 0 or one past a safe
// integer, gives no line, and no column beside a line; the editor keeps the
// rest within the file.
function lineCol(suffix: string): LineCol | undefined {
	const [line, col] = suffix.slice(1).split(':').map(Number);
	if (!(line >= 1 && Number.isSafeInteger(line))) return undefined;
	return col >= 1 && Number.isSafeInteger(col) ? { line, col } : { line };
}

function isPath(text: string): boolean {
	if (text === '~') return true;
	const m = ANCHOR.exec(text);
	if (m) {
		// A lone /word (/help, /model) is a slash command far more often than a file,
		// and // starts a comment; neither should be underlined all over the screen.
		// A $NAME/ path asks for no extension either: the provider links it only
		// once its command's own assignment expands it and the disk has the result.
		return m[1] !== '/' || m[2].includes('/') || EXTENSION.test(m[2]);
	}
	// Without an extension, and/or, 2026/10/24 and TCP/IP would all look like paths.
	return RELATIVE.test(text) && EXTENSION.test(text);
}

// Boundaries the text does not show, as colour in a terminal: endsAt(i) ends
// a path before i, and startsAt(i) lets one begin at i.
export type Bounds = { endsAt(i: number): boolean; startsAt(i: number): boolean };
const NO_BOUNDS: Bounds = { endsAt: () => false, startsAt: () => false };

// With names, a token that is no path but a bare file name is found too: only
// plain segment characters, so no / and no ://, and an extension, without which
// Makefile-like words and v0.1.30 would be asked about all over the screen.
export function findPaths(line: string, bounds: Bounds = NO_BOUNDS, names = false): PathHit[] {
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
		let name = false;
		if (token.startsWith('file://')) {
			if (fileUrlToPath(bare)) target = bare;
		} else if (!token.includes('://') && isPath(bare)) {
			target = bare;
		} else if (names && PLAIN_NAME.test(bare) && EXTENSION.test(bare)) {
			target = bare;
			name = true;
		}
		if (target !== undefined) {
			const hit: PathHit = name ? { start: i, end: stopRun, target, name: true } : { start: i, end: stopRun, target };
			const at = token.length > bare.length ? lineCol(token.slice(bare.length)) : undefined;
			if (at) hit.at = at;
			hits.push(hit);
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

// The variable a $NAME/ or ${NAME}/ target begins with, and the rest of it
// from the slash on.
export function varPath(target: string): { name: string; rest: string } | undefined {
	const m = VAR_PATH.exec(target);
	return m ? { name: m[1] ?? m[2], rest: m[3] } : undefined;
}

// A NAME= or NAME+= in a line: value is where its value begins, past an opening
// " when quoted.
export type Assignment = { name: string; value: number; quoted: boolean; append: boolean };

// A token start is where a shell begins a word that may assign, so export, local
// and env need no rule of their own and Bash(B=… counts, while --B=/x is an
// option, not B. A name can only be entered from the character before it, so
// this stays linear on untrusted output.
const ASSIGNMENT = new RegExp(String.raw`(?<=^|[\s;&|(])(${NAME})(\+?)=("?)`, 'g');

// Every assignment in text, in order.
export function findAssignments(text: string): Assignment[] {
	return [...text.matchAll(ASSIGNMENT)].map((m) => ({
		name: m[1],
		value: m.index + m[0].length,
		quoted: m[3] === '"',
		append: m[2] === '+',
	}));
}

const LEAD_VAR = new RegExp(String.raw`^\$(?:${NAME}|\{${NAME}\})`);
const PLAIN_VALUE = new RegExp(`^[${PLAIN_CHARS}/]*$`, 'u');
const VALUE_END = /^(?:$|[\s;&|)])/;

// Whether a path found where a value begins is all of the value: no line
// suffix cut off (target is all of covered, the text of its range); nothing a
// shell would expand or split past a leading variable, or a leading ~ when
// unquoted (a shell leaves a quoted ~ as it is); and the value ends where the
// path does, at the closing " when quoted. Anything less may name another path
// than the one the command meant, and the disk cannot tell.
export function wholeValue(target: string, covered: string, after: string, quoted: boolean): boolean {
	if (target !== covered) return false;
	const lead = LEAD_VAR.exec(target)?.[0] ?? (!quoted && target.startsWith('~') ? '~' : '');
	if (!PLAIN_VALUE.test(target.slice(lead.length))) return false;
	if (quoted) {
		if (after[0] !== '"') return false;
		after = after.slice(1);
	}
	return VALUE_END.test(after);
}

// at goes only to a file the app shows: a file another app opens, or Finder
// reveals, has no place in it the app could go to.
export async function openPath(
	path: string,
	host: string,
	report: (m: string, tone?: Tone) => void,
	onView: (path: string, at?: LineCol) => void,
	invoker: Invoker = defaultInvoker,
	fallback?: string,
	at?: LineCol,
): Promise<void> {
	try {
		const r = await invoker(path, host);
		if (r.action === 'revealed') report(`revealed in Finder, not opened: ${path} (${r.why})`, 'info');
		else if (r.action === 'view') onView(r.path, at);
	} catch (e) {
		// open_path's word for a path that does not exist, the one failure that
		// says a joined path was a wrong guess. The fallback may be another file
		// than the one the hover named, so the switch is told, and opens at no
		// line: the line was the joined path's.
		if (fallback !== undefined && errText(e) === 'no such file') {
			report(`${path}: no such file, opening ${fallback}`, 'info');
			return openPath(fallback, host, report, onView, invoker);
		}
		report(`open ${path}: ${errText(e)}`);
	}
}

// What open_path is asked with for a link's text, or undefined when the text is
// no file (a web URL). The existence check and the click share it, so the
// check answers about the very path a click would open.
export function gateTarget(text: string): { path: string; host: string } | undefined {
	if (text.startsWith('/') || text === '~' || text.startsWith('~/')) return { path: text, host: '' };
	return fileUrlToPath(text);
}

// The only place that decides whether a click on terminal text opens anything.
// at is where in the file the link's text pointed, from a line suffix.
export function activateUri(
	e: MouseEvent,
	text: LinkText,
	at: LineCol | undefined,
	report: (m: string, tone?: Tone) => void,
	onView: (path: string, at?: LineCol) => void,
	invoker: Invoker = defaultInvoker,
	opener?: Opener,
): void {
	if (!e.metaKey) return;
	const [uri, fallback] = typeof text === 'string' ? [text, undefined] : text;
	const target = gateTarget(uri);
	if (target) {
		// The fallback is another path on the clicked row; a file URL has none.
		void openPath(target.path, target.host, report, onView, invoker, uri.startsWith('file:') ? undefined : fallback, at);
		return;
	}
	openExternal(uri, (err) => report(`open ${uri}: ${errText(err)}`), opener);
}
