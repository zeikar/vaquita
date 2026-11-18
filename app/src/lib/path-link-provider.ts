import type { IBufferCell, IBufferLine, ILink, ILinkProvider } from '@xterm/xterm';
import {
	findAssignments,
	findPaths,
	gateTarget,
	hasExtension,
	pathRun,
	pathRunBefore,
	resolvePath,
	varPath,
	wholeValue,
	type LinkText,
	type Bounds,
	type PathHit,
} from './file-links';
import type { PathChecker } from './path-exists';

// Only getLine, so a headless terminal's buffer can stand in for xterm's.
export interface BufferLike {
	readonly active: { getLine(y: number): IBufferLine | undefined };
}

// Where one UTF-16 code unit of a logical line sits: 0-based row and column,
// the width of its cell, and its foreground colour (mode and value).
type CellPos = { row: number; x: number; width: number; fg: number };

// No colour mode is 0, so no other colour is this.
const DEFAULT_FG = 0;

type LineText = { text: string; cells: CellPos[] };

export interface LinkHandlers {
	activate(e: MouseEvent, text: LinkText): void;
	hover(e: MouseEvent, text: string): void;
	leave(e: MouseEvent, text: string): void;
}

// A path cannot cross whitespace, so lineText stops each way after a row that
// has some, as WebLinksAddon does. This cap, also WebLinksAddon's, is for a
// huge wrapped line without any (a minified bundle), which would otherwise be
// scanned whole on every hover.
const WINDOW = 2048;

const SPACE = /\s/;

function readRow(buffer: BufferLike, r: number, line: IBufferLine): LineText {
	let end = line.length;
	// A wide character that did not fit in the last column goes on the next row
	// and leaves that cell empty; it is not a space in the text. Other empty
	// cells, say from erasing the row after it wrapped, are.
	const next = buffer.active.getLine(r + 1);
	const pushed = next?.isWrapped && next.getCell(0)?.getWidth() === 2;
	if (pushed && end > 0 && line.getCell(end - 1)?.getChars() === '') end--;
	let text = '';
	const cells: CellPos[] = [];
	let cell: IBufferCell | undefined;
	for (let x = 0; x < end; x++) {
		cell = line.getCell(x, cell);
		if (!cell) break;
		const width = cell.getWidth();
		// The right half of a wide character.
		if (width === 0) continue;
		const chars = cell.getChars() || ' ';
		text += chars;
		const fg = cell.isFgDefault() ? DEFAULT_FG : cell.getFgColorMode() | cell.getFgColor();
		// An astral character or a combining mark gives one cell several code units.
		for (let i = 0; i < chars.length; i++) cells.push({ row: r, x, width, fg });
	}
	return { text, cells };
}

// The logical line around 0-based row: the rows it wraps across, as one string
// with the cell of every code unit.
export function lineText(buffer: BufferLike, row: number): LineText {
	const getLine = (y: number) => buffer.active.getLine(y);
	const line = getLine(row);
	if (!line) return { text: '', cells: [] };
	const rows = [readRow(buffer, row, line)];
	for (let r = row, n = 0; n < WINDOW && getLine(r)?.isWrapped; ) {
		const prev = getLine(--r);
		if (!prev) break;
		const got = readRow(buffer, r, prev);
		rows.unshift(got);
		n += got.text.length;
		if (SPACE.test(got.text)) break;
	}
	for (let r = row, n = 0; n < WINDOW; ) {
		const next = getLine(++r);
		if (!next?.isWrapped) break;
		const got = readRow(buffer, r, next);
		rows.push(got);
		n += got.text.length;
		if (SPACE.test(got.text)) break;
	}
	return { text: rows.map((g) => g.text).join(''), cells: rows.flatMap((g) => g.cells) };
}

// Claude Code wraps a long line itself, with a newline and an indent, so the
// rest of a path goes on the next line, which xterm does not mark as wrapped.
// One rule, runsOn, says whether a line goes on into the next: its tail ends
// it at the right edge (give or take the EDGE_SLACK cells such a wrap may
// leave), is no whole file name, and the next line begins with a run of path
// characters after an indent. A file name that ends a line is far likelier
// followed by a word than broken inside its extension. A path is the lines
// joined so from where it begins, up to MAX_LINES of them: a line that is not
// itself the rest of the line above, or one that is, after that rest, as when
// a list item names two long paths. A wrong guess the disk shows, a joined
// path that is not there, gives way to the paths the lines have on their own.
// One the disk could not confirm still underlines too much, so a click on it
// falls back, and says so, to the path that stood on its own on the clicked
// row, or else to the first line's.
const EDGE_SLACK = 2;
// The lines one path may take, which bounds how many more a hover reads.
const MAX_LINES = 3;

// A slice of a line's text: a path, or a run that continues it.
type Piece = { line: LineText; start: number; end: number };

// Where a path that may go on into the next line begins, with its target when
// it is a path by itself.
type Opening = { start: number; end: number; target?: string };

// A path to link, by its first and last cells; expanded when its text began
// with a shell variable the path stands for.
type Span = { first: CellPos; last: CellPos; path: string; expanded?: boolean };

// What a path is resolved by: a target and its first cell, which says which of
// its command's assignments came before it, to a path, or to nothing when the
// target names a variable that is not known there.
type Resolve = (target: string, at: CellPos) => string | undefined;

// What of a joined path wholeValue reads: its target, the joined text of its
// range, and the text after its last cell on the line it ends on.
type Raw = { target: string; covered: string; after: string };

// A joined path also has the paths it replaces, for a click to fall back to, and
// lead among them when the first line's part is one; taken is its last cell,
// after which the lines' own paths link.
type Found = Span & { parts?: Span[]; lead?: Span; taken?: CellPos; raw?: Raw };

// Claude Code draws inline code, such as a path in backticks, in a colour of
// its own. Where a colour ends, a path ends (~/.zshrc을 links ~/.zshrc), and
// where one begins, a path may (see~/a.ts links ~/a.ts). That holds beside a
// / too, so a folder (~/src/을) ends at its own; a prompt that colours the
// parts of one path apart has it cut, and is rarely clicked. The default
// colour begins and ends nothing, so plain text reads as before.
function colourBounds({ cells }: LineText): Bounds {
	const apart = (i: number) => i > 0 && i < cells.length && cells[i].fg !== cells[i - 1].fg;
	return {
		endsAt: (i) => apart(i) && cells[i - 1].fg !== DEFAULT_FG,
		startsAt: (i) => apart(i) && cells[i].fg !== DEFAULT_FG,
	};
}

// Whether a colour ends or begins between the last code unit of one piece of
// text and the first of the next, as at a line break.
function colourBreak(a: LineText, i: number, b: LineText, j: number): boolean {
	const pair = { text: a.text[i] + b.text[j], cells: [a.cells[i], b.cells[j]] };
	const bounds = colourBounds(pair);
	return bounds.endsAt(1) || bounds.startsAt(1);
}

function located(first: CellPos, last: CellPos, target: string, resolve: Resolve): Span | undefined {
	const path = resolve(target, first);
	if (path === undefined) return undefined;
	return varPath(target) ? { first, last, path, expanded: true } : { first, last, path };
}

function span(line: LineText, hit: PathHit, resolve: Resolve): Span | undefined {
	return located(line.cells[hit.start], line.cells[hit.end - 1], hit.target, resolve);
}

// Whether a piece ends its line at the right edge, before a hard break.
function atEdge(buffer: BufferLike, { line, end }: Piece): boolean {
	const last = line.cells[end - 1];
	const row = buffer.active.getLine(last.row);
	const next = buffer.active.getLine(last.row + 1);
	if (!row || !next || next.isWrapped || last.x + last.width < row.length - EDGE_SLACK) return false;
	return !/\S/.test(line.text.slice(end));
}

// The run of path characters that begins a line after an indent. A wrap
// indents what it carries over, so what starts at column 0 is a line of its
// own, as in a listing, a prompt or a log.
function leadingRun(line: LineText): Piece | undefined {
	const start = line.text.search(/\S/);
	if (start <= 0) return undefined;
	let end = pathRun(line.text, start);
	// A colour that ends ends the run, as it ends a path.
	const bounds = colourBounds(line);
	for (let i = start + 1; i < end; i++) {
		if (bounds.endsAt(i)) {
			end = i;
			break;
		}
	}
	return end > start && /[\p{L}\p{N}]/u.test(line.text.slice(start, end)) ? { line, start, end } : undefined;
}

// The line's last path when it ends the line, else the run of path characters
// with a / that ends it.
function opening(line: LineText): Opening | undefined {
	const end = line.text.trimEnd().length;
	const bounds = colourBounds(line);
	const last = findPaths(line.text, bounds).at(-1);
	if (last?.end === end) return last;
	let start = pathRunBefore(line.text, end);
	if (start < 0) return undefined;
	// A colour that ends in the run ends what came before it there.
	for (let i = end - 1; i > start; i--) {
		if (bounds.endsAt(i)) {
			start = i;
			break;
		}
	}
	return line.text.slice(start, end).includes('/') && pathRun(line.text, start) === end ? { start, end } : undefined;
}

// What of a line may go on into the next: its opening; or, when the line is
// itself the rest of the line above, the run it begins with, which is the part
// of it a path takes, when that run ends it, else an opening after that run.
function tail(line: LineText, rest: boolean): Opening | undefined {
	if (!rest) return opening(line);
	const run = leadingRun(line);
	if (run && !/\S/.test(line.text.slice(run.end))) return { start: run.start, end: run.end };
	const o = opening(line);
	return o && (!run || o.start >= run.end) ? o : undefined;
}

// Whether a line goes on into the next, and with which tail into which run.
// rest says whether the line is itself the rest of the line above.
function runsOn(buffer: BufferLike, line: LineText, rest: boolean): [Opening, Piece] | undefined {
	const t = tail(line, rest);
	if (!t) return undefined;
	const text = t.target ?? line.text.slice(t.start, t.end);
	if (text.startsWith('file:') || hasExtension(text) || !atEdge(buffer, { line, ...t })) return undefined;
	const run = leadingRun(lineText(buffer, line.cells[t.end - 1].row + 1));
	// A colour that ends with the line, or begins the next, ends the path there.
	return run && !colourBreak(line, t.end - 1, run.line, run.start) ? [t, run] : undefined;
}

// Whether lines[k] is the rest of the line above, worked out down from at most
// MAX_LINES lines up, the first taken as no rest: the answer is then the
// line's own, the same for every row that asks.
function isRest(buffer: BufferLike, lines: LineText[], k: number): boolean {
	let rest = false;
	for (let j = Math.max(0, k - MAX_LINES) + 1; j <= k; j++) rest = !!runsOn(buffer, lines[j - 1], rest);
	return rest;
}

// The path a line starts, with the runs that continue it on the next lines.
// rest says whether the line is itself the rest of the line above; going on
// by the run it begins with, it goes on with the path joined from above.
// Nothing when the joined path names a variable not known there.
function join(buffer: BufferLike, line: LineText, rest: boolean, resolve: Resolve): Found | undefined {
	let on = runsOn(buffer, line, rest);
	if (!on || (rest && on[0].start === leadingRun(line)?.start)) return undefined;
	const { start, end, target } = on[0];
	const pieces: Piece[] = [{ line, start, end }];
	while (on && pieces.length < MAX_LINES) {
		const run: Piece = on[1];
		pieces.push(run);
		on = runsOn(buffer, run.line, true);
		// Only a run that ends its line goes on; a path after it there is another.
		if (on?.[0].start !== run.start) break;
	}
	const joined = {
		text: pieces.map((p) => p.line.text.slice(p.start, p.end)).join(''),
		cells: pieces.flatMap((p) => p.line.cells.slice(p.start, p.end)),
	};
	const got = findPaths(joined.text, colourBounds(joined))[0];
	if (got?.start !== 0) return undefined;
	const last = joined.cells[got.end - 1];
	const whole = located(line.cells[start], last, got.target, resolve);
	if (!whole) return undefined;
	const lead = target === undefined ? undefined : span(line, { start, end, target }, resolve);
	const parts = lead ? [lead] : [];
	for (const p of pieces.slice(1)) {
		for (const h of findPaths(p.line.text, colourBounds(p.line))) {
			if (h.start >= p.end) break;
			const s = span(p.line, h, resolve);
			if (s) parts.push(s);
		}
	}
	// The piece the path ends in, for the text after it on that piece's line.
	let after = '';
	for (let i = 0, off = 0; i < pieces.length; off += pieces[i].end - pieces[i].start, i++) {
		const p = pieces[i];
		if (got.end <= off + p.end - p.start) {
			after = p.line.text.slice(p.start + got.end - off);
			break;
		}
	}
	const raw = { target: got.target, covered: joined.text.slice(0, got.end), after };
	return { ...whole, parts, lead, taken: last, raw };
}

// here and the lines above it, in order, while each begins with a run after an
// indent and so may be the rest of the one above: enough for a path from
// MAX_LINES - 1 lines up to reach here, and for isRest on each of those lines.
function linesInto(buffer: BufferLike, here: LineText): LineText[] {
	const lines = [here];
	while (lines.length < 2 * MAX_LINES && leadingRun(lines[0])) {
		const first = lines[0].cells[0].row;
		// A wrapped first row is not where the line begins: lineText stopped inside it.
		if (first === 0 || buffer.active.getLine(first)?.isWrapped) break;
		lines.unshift(lineText(buffer, first - 1));
	}
	return lines;
}

// A $NAME/ path is expanded from the command it stands in, as the app knows no
// shell's variables, only the text on the screen. The command is the hovered
// line and the lines above it while each is the rest of the one above: its
// first row is soft-wrapped, or it begins after an indent and the line above
// is full, as a TUI wraps a long command. There is no marker for where a
// command begins (a prompt, a Bash( call), so the first line that is neither
// is its first line. Lines past COMMAND_LINES above the hovered one are not
// read, and what they assign stays unknown.
const COMMAND_LINES = 8;

// Whether top can be the rest of the line above: a TUI wraps a line where its
// next word would not fit, so the first word of top could not have followed
// above on its last row. A short line above, such as another call, ends the
// command.
function wrapsInto(buffer: BufferLike, above: LineText, top: LineText): boolean {
	const end = above.text.trimEnd().length;
	const start = top.text.search(/\S/);
	if (end === 0 || start < 0) return false;
	const last = above.cells[end - 1];
	const width = buffer.active.getLine(last.row)?.length ?? 0;
	let stop = top.text.slice(start).search(/\s/);
	stop = stop < 0 ? top.text.length : start + stop;
	const a = top.cells[start];
	const b = top.cells[stop - 1];
	// A first word that runs over a row would not fit anywhere.
	if (a.row !== b.row) return true;
	return last.x + last.width + 1 + (b.x + b.width - a.x) > width;
}

// The command's lines, top to bottom, the last being here. A line whose first
// row is soft-wrapped is joined with the rows above it, read only once each,
// so that a value is never cut where lineText stopped.
function commandLines(buffer: BufferLike, here: LineText): LineText[] {
	const lines = [here];
	for (let n = 0; n < COMMAND_LINES; n++) {
		const top = lines[0];
		const first = top.cells[0]?.row;
		if (first === undefined || first === 0) break;
		const wrapped = buffer.active.getLine(first)?.isWrapped;
		if (!wrapped && top.text.search(/\S/) <= 0) break;
		const above = lineText(buffer, first - 1);
		if (!wrapped) {
			if (!wrapsInto(buffer, above, top)) break;
			lines.unshift(above);
			continue;
		}
		let cut = above.cells.findIndex((c) => c.row >= first);
		if (cut < 0) cut = above.cells.length;
		lines[0] = { text: above.text.slice(0, cut) + top.text, cells: [...above.cells.slice(0, cut), ...top.cells] };
	}
	return lines;
}

// An assignment in a command: where its value begins, and the path it gives,
// none when the app did not read all of the value.
type Listed = { at: Pick<CellPos, 'row' | 'x'>; path?: string };

function before(a: Pick<CellPos, 'row' | 'x'>, b: Pick<CellPos, 'row' | 'x'>): boolean {
	return a.row < b.row || (a.row === b.row && a.x < b.x);
}

// Every NAME= in the command, by name, in the order they stand. A value is
// taken only when the provider already finds a path where it begins that is
// all of it (wholeValue), through a plain =; the disk cannot tell a cut or
// stale value from the right one, so anything else, a single-quoted value
// included, leaves the name unknown from there on. A line's join is made after
// its own assignments, as the variable it begins with may be one of them, and
// when it begins at a value it is that value, wrapped onto the next lines.
function listAssignments(buffer: BufferLike, lines: LineText[], resolve: Resolve, listed: Map<string, Listed[]>) {
	lines.forEach((line, k) => {
		const hits = new Map(findPaths(line.text, colourBounds(line)).map((h) => [h.start, h]));
		const atValue = new Map<CellPos, { entry: Listed; quoted: boolean; plain: boolean }>();
		for (const a of findAssignments(line.text)) {
			const cell = line.cells[a.value];
			// A value that ends the line's text has no cell; it begins just past the =.
			const eq = line.cells[a.value - (a.quoted ? 2 : 1)];
			const entry: Listed = { at: cell ?? { row: eq.row, x: eq.x + eq.width } };
			const hit = hits.get(a.value);
			const covered = hit ? line.text.slice(hit.start, hit.end) : '';
			if (!a.append && hit && wholeValue(hit.target, covered, line.text.slice(hit.end), a.quoted)) {
				entry.path = resolve(hit.target, cell);
			}
			const list = listed.get(a.name);
			if (list) list.push(entry);
			else listed.set(a.name, [entry]);
			if (cell) atValue.set(cell, { entry, quoted: a.quoted, plain: !a.append });
		}
		const f = join(buffer, line, isRest(buffer, lines, k), resolve);
		const v = f && atValue.get(f.first);
		if (v) {
			const { target, covered, after } = f.raw!;
			v.entry.path = v.plain && wholeValue(target, covered, after, v.quoted) ? f.path : undefined;
		}
	});
}

// Text that makes a command's assignments uncertain: a substitution, whose own
// quotes are not followed, a backtick, or a single quote, in which $ is
// literal. A command with any of them fills in no variable.
const UNSURE = /\$\(|`|'/;

// The resolver of a hovered line: a plain target from the starting folder, a
// $NAME/ one from its command when that is sure. A guess is only made where
// there is no doubt, as the disk cannot tell a stale or cut value from the
// right one: no UNSURE text in the command, and NAME= written once in all of
// it, quoted, in an option or anywhere, as a plain assignment before the use
// whose value was read in full. HOME written nowhere is ~; no environment
// variable is read. The command is read the first time a variable needs it,
// so a row with none costs nothing more.
function resolver(buffer: BufferLike, cwd: string, here: LineText): Resolve {
	let command: { text: string; listed: Map<string, Listed[]> } | undefined;
	const resolve: Resolve = (target, at) => {
		const v = varPath(target);
		if (!v) return resolvePath(target, cwd);
		if (!command) {
			const lines = commandLines(buffer, here);
			// Set first: the walk resolves its own values through this, against
			// what it has listed so far.
			command = { text: lines.map((l) => l.text).join('\n'), listed: new Map() };
			listAssignments(buffer, lines, resolve, command.listed);
		}
		if (UNSURE.test(command.text)) return undefined;
		const written = command.text.match(new RegExp(`(?<![A-Za-z0-9_])${v.name}\\+?=`, 'g'))?.length ?? 0;
		if (written === 0) return v.name === 'HOME' ? '~' + v.rest : undefined;
		const list = command.listed.get(v.name);
		const a = list?.length === 1 ? list[0] : undefined;
		if (written !== 1 || !a || !before(a.at, at) || a.path === undefined) return undefined;
		return a.path.replace(/\/+$/, '') + v.rest;
	};
	return resolve;
}

// A path that may link on the hovered row, with the joined path that replaced
// it, if any: it links only once the disk says that one is not there.
type Entry = Found & { by?: Found };

// The paths that reach 1-based row y: the joined ones that do and the row's own.
function rowEntries(buffer: BufferLike, cwd: string, y: number): Entry[] {
	const lines = linesInto(buffer, lineText(buffer, y - 1));
	const here = lines[lines.length - 1];
	const resolve = resolver(buffer, cwd, here);
	const found: Entry[] = [];
	// A joined path replaces the paths in the runs it took, up to its taken cell.
	let taker: Found | undefined;
	const free = (c: CellPos) => {
		const t = taker?.taken;
		return !t || c.row > t.row || (c.row === t.row && c.x > t.x);
	};
	// A path that reaches here starts at most MAX_LINES - 1 lines up.
	for (let k = Math.max(0, lines.length - MAX_LINES); k < lines.length; k++) {
		const f = join(buffer, lines[k], isRest(buffer, lines, k), resolve);
		// here's paths link on their own but for those an earlier path took and
		// the one here's own path starts from, which wait on that path's answer.
		if (k === lines.length - 1) {
			for (const hit of findPaths(here.text, colourBounds(here))) {
				const s = span(here, hit, resolve);
				if (!s) continue;
				found.push({ ...s, by: !free(s.first) ? taker : f?.first === s.first ? f : undefined });
			}
		}
		if (f) {
			found.push(f);
			taker = f;
		}
	}
	// xterm asks row by row; a link over several rows is given for each.
	return found.filter(({ first, last }) => first.row <= y - 1 && y - 1 <= last.row);
}

// The links of row y by the disk's answers: true, false, or undefined when not
// known, which links as without a check. A path that is not there is dropped,
// and a path a join replaced links only when the join is not there. An
// expanded path links only on a true: it is a guess that stands nowhere on the
// screen, so unconfirmed it would underline, and report missing on a click, a
// file the user never read. Its answer is kept when it lands late, and the
// next hover links it.
function rowLinks(
	entries: Entry[],
	y: number,
	answer: (path: string) => boolean | undefined,
	handlers: LinkHandlers,
): ILink[] | undefined {
	const links: ILink[] = [];
	for (const { first, last, path, parts, lead, by, expanded } of entries) {
		const known = answer(path);
		if (known === false || (expanded && known !== true) || (by && answer(by.path) !== false)) continue;
		const range = {
			start: { x: first.x + 1, y: first.row + 1 },
			end: { x: last.x + last.width, y: last.row + 1 },
		};
		// xterm asks again for each row the pointer moves to, so a click opens this row's fallback.
		const part = parts?.find((p) => p.first.row <= y - 1 && y - 1 <= p.last.row) ?? lead;
		const text: LinkText = !part || part.path === path ? path : [path, part.path];
		links.push({
			range,
			text: path,
			activate: (e) => handlers.activate(e, text),
			hover: (e) => handlers.hover(e, path),
			leave: (e) => handlers.leave(e, path),
		});
	}
	return links.length > 0 ? links : undefined;
}

// Links for paths in plain terminal text. Ranges follow WebLinksAddon: 1-based,
// end inclusive, and a wide last character ends on its right cell. With a
// checker, a path the disk says is not there is not given.
export function pathLinkProvider(
	buffer: BufferLike,
	cwd: string,
	handlers: LinkHandlers,
	checker?: PathChecker,
): ILinkProvider {
	const answer = (path: string) => checker?.known(path);
	// Only the latest call replies: xterm's Linkifier puts a reply in the map of
	// whichever row is active when it lands, so a late answer for one row would
	// replace the links of the row the pointer has moved to.
	let latest = 0;
	return {
		provideLinks(y, callback) {
			const call = ++latest;
			const entries = rowEntries(buffer, cwd, y);
			// A text that is no gate target has nothing to ask and reads as not known.
			const asked = [...new Set(entries.flatMap((e) => (e.by ? [e.path, e.by.path] : [e.path])))].filter(
				(p) => gateTarget(p) && answer(p) === undefined,
			);
			if (!checker || asked.length === 0) {
				callback(rowLinks(entries, y, answer, handlers));
				return;
			}
			void checker.ask(asked).then(() => {
				if (call !== latest) return;
				// Output may have rewritten the row during the wait, so links built
				// before it could put the old path and its range on new text. They are
				// worked out again from the buffer as it is now, and a path the new
				// text brings that was not asked reads by the cache, else as not known.
				callback(rowLinks(rowEntries(buffer, cwd, y), y, answer, handlers));
			});
		},
	};
}
