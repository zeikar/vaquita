import type { IBufferCell, IBufferLine, ILink, ILinkProvider } from '@xterm/xterm';
import {
	findPaths,
	hasExtension,
	pathRun,
	pathRunBefore,
	resolvePath,
	type LinkText,
	type Bounds,
	type PathHit,
} from './file-links';

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
// joined so from one that is not itself the rest of the line above, up to
// MAX_LINES of them. A wrong guess still underlines too much, so a click on it
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

// A path to link, by its first and last cells.
type Span = { first: CellPos; last: CellPos; path: string };

// A joined path also has the paths it replaces, for a click to fall back to, and
// lead among them when the first line's part is one; taken is its last cell,
// after which the lines' own paths link.
type Found = Span & { parts?: Span[]; lead?: Span; taken?: CellPos };

// Claude Code draws inline code, such as a path in backticks, in a colour of
// its own. Where a colour ends, a path ends (~/.zshrc을 links ~/.zshrc), and
// where one begins, a path may (see~/a.ts links ~/a.ts). A change next to a /
// is inside one path, as where a prompt colours its parts apart. The default
// colour begins and ends nothing, so plain text reads as before.
function colourBounds({ text, cells }: LineText): Bounds {
	const apart = (i: number) => i > 0 && i < cells.length && cells[i].fg !== cells[i - 1].fg && text[i] !== '/' && text[i - 1] !== '/';
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

function span(line: LineText, hit: PathHit, cwd: string): Span {
	return { first: line.cells[hit.start], last: line.cells[hit.end - 1], path: resolvePath(hit.target, cwd) };
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
// of it a path takes, when that run ends it.
function tail(line: LineText, rest: boolean): Opening | undefined {
	if (!rest) return opening(line);
	const run = leadingRun(line);
	return run && !/\S/.test(line.text.slice(run.end)) ? { start: run.start, end: run.end } : undefined;
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
function join(buffer: BufferLike, line: LineText, cwd: string): Found | undefined {
	let on = runsOn(buffer, line, false);
	if (!on) return undefined;
	const { start, end, target } = on[0];
	const pieces: Piece[] = [{ line, start, end }];
	for (; on && pieces.length < MAX_LINES; on = runsOn(buffer, on[1].line, true)) pieces.push(on[1]);
	const joined = {
		text: pieces.map((p) => p.line.text.slice(p.start, p.end)).join(''),
		cells: pieces.flatMap((p) => p.line.cells.slice(p.start, p.end)),
	};
	const got = findPaths(joined.text, colourBounds(joined))[0];
	if (got?.start !== 0) return undefined;
	const lead = target === undefined ? undefined : span(line, { start, end, target }, cwd);
	const parts = lead ? [lead] : [];
	for (const p of pieces.slice(1)) {
		for (const h of findPaths(p.line.text, colourBounds(p.line))) {
			if (h.start >= p.end) break;
			parts.push(span(p.line, h, cwd));
		}
	}
	const last = joined.cells[got.end - 1];
	return { first: line.cells[start], last, path: resolvePath(got.target, cwd), parts, lead, taken: last };
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

// Links for paths in plain terminal text. Ranges follow WebLinksAddon: 1-based,
// end inclusive, and a wide last character ends on its right cell.
export function pathLinkProvider(buffer: BufferLike, cwd: string, handlers: LinkHandlers): ILinkProvider {
	return {
		provideLinks(y, callback) {
			const lines = linesInto(buffer, lineText(buffer, y - 1));
			const here = lines[lines.length - 1];
			const found: Found[] = [];
			// A joined path replaces the paths in the runs it took, up to this cell.
			let taken: CellPos | undefined;
			const free = (c: CellPos) => !taken || c.row > taken.row || (c.row === taken.row && c.x > taken.x);
			// A path that reaches here starts at most MAX_LINES - 1 lines up.
			for (let k = Math.max(0, lines.length - MAX_LINES); k < lines.length; k++) {
				const f = isRest(buffer, lines, k) ? undefined : join(buffer, lines[k], cwd);
				// here's paths link on their own but for those an earlier path took and
				// the one here's own path starts from.
				if (k === lines.length - 1) {
					const own = (hit: PathHit) => free(here.cells[hit.start]) && f?.first !== here.cells[hit.start];
					found.push(...findPaths(here.text, colourBounds(here)).filter(own).map((hit) => span(here, hit, cwd)));
				}
				if (f) {
					found.push(f);
					taken = f.taken;
				}
			}
			const links: ILink[] = [];
			for (const { first, last, path, parts, lead } of found) {
				const range = {
					start: { x: first.x + 1, y: first.row + 1 },
					end: { x: last.x + last.width, y: last.row + 1 },
				};
				// xterm asks row by row; a link over several rows is given for each.
				if (range.start.y > y || range.end.y < y) continue;
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
			callback(links.length > 0 ? links : undefined);
		},
	};
}
