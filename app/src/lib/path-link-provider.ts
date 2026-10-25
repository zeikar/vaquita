import type { IBufferCell, IBufferLine, ILink, ILinkProvider } from '@xterm/xterm';
import { findPaths, pathRun, resolvePath, type LinkText, type PathHit } from './file-links';

// Only getLine, so a headless terminal's buffer can stand in for xterm's.
export interface BufferLike {
	readonly active: { getLine(y: number): IBufferLine | undefined };
}

// Where one UTF-16 code unit of a logical line sits: 0-based row and column,
// and the width of its cell.
type CellPos = { row: number; x: number; width: number };

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
		// An astral character or a combining mark gives one cell several code units.
		for (let i = 0; i < chars.length; i++) cells.push({ row: r, x, width });
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
// A path that ends its line at the right edge, give or take the EDGE_SLACK
// cells such a wrap may leave, takes the run of path characters that begins the
// next line, and the next one's if that run fills its row in turn. Prose that
// happens to begin the next line makes a wrong guess, which costs the hover
// text only: the click falls back to the path that stood on its own on the
// clicked row, or else to the one on the first line.
const EDGE_SLACK = 2;
// The lines one path may take, which bounds how many more a hover reads.
const MAX_LINES = 3;

// A slice of a line's text: a path, or a run that continues it.
type Piece = { line: LineText; start: number; end: number };

// A path to link, by its first and last cells.
type Span = { first: CellPos; last: CellPos; path: string };

// A joined path also has the paths it replaces, the first line's one first,
// for a click to fall back to; taken is the last cell of the runs it took.
type Found = Span & { parts?: Span[]; taken?: CellPos };

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

// The run of path characters that begins a line, after its indent. A wrap
// indents what it carries over, so a path at column 0 is one of its own, as in
// a listing from find or ls.
function leadingRun(line: LineText): Piece | undefined {
	const start = line.text.search(/\S/);
	if (start < 0 || (start === 0 && /^~?\//.test(line.text))) return undefined;
	const end = pathRun(line.text, start);
	return end > start ? { line, start, end } : undefined;
}

// The path a hit makes with the runs that continue it on the next lines, when
// it ends its line at the edge. A file:// URI is left as it is.
function join(buffer: BufferLike, line: LineText, hit: PathHit, cwd: string): Found | undefined {
	if (hit.target.startsWith('file:')) return undefined;
	const pieces: Piece[] = [{ line, start: hit.start, end: hit.end }];
	for (let p = pieces[0]; pieces.length < MAX_LINES && atEdge(buffer, p); ) {
		const run = leadingRun(lineText(buffer, p.line.cells[p.end - 1].row + 1));
		if (!run) break;
		pieces.push((p = run));
	}
	if (pieces.length === 1) return undefined;
	const text = pieces.map((p) => p.line.text.slice(p.start, p.end)).join('');
	const got = findPaths(text)[0];
	if (got?.start !== 0) return undefined;
	const parts = [span(line, hit, cwd)];
	for (const p of pieces.slice(1)) {
		for (const h of findPaths(p.line.text)) {
			if (h.start >= p.end) break;
			parts.push(span(p.line, h, cwd));
		}
	}
	// What findPaths trims off the end, punctuation, is all in the last run, which
	// has a letter or a digit.
	const tail = pieces[pieces.length - 1];
	return {
		first: line.cells[hit.start],
		last: tail.line.cells[tail.end - (text.length - got.end) - 1],
		path: resolvePath(got.target, cwd),
		parts,
		taken: tail.line.cells[tail.end - 1],
	};
}

// The lines before here, in order, whose last path may run on into it: each
// line after the first begins with a run that may continue the one before.
function earlier(buffer: BufferLike, here: LineText): LineText[] {
	const lines: LineText[] = [];
	for (let line = here; lines.length < MAX_LINES - 1 && leadingRun(line); ) {
		const first = line.cells[0].row;
		// A wrapped first row is not where the line begins: lineText stopped inside it.
		if (first === 0 || buffer.active.getLine(first)?.isWrapped) break;
		line = lineText(buffer, first - 1);
		lines.unshift(line);
	}
	return lines;
}

// Links for paths in plain terminal text. Ranges follow WebLinksAddon: 1-based,
// end inclusive, and a wide last character ends on its right cell.
export function pathLinkProvider(buffer: BufferLike, cwd: string, handlers: LinkHandlers): ILinkProvider {
	return {
		provideLinks(y, callback) {
			const here = lineText(buffer, y - 1);
			const found: Found[] = [];
			// A joined path replaces the paths in the runs it took, up to this cell.
			let taken: CellPos | undefined;
			const free = (c: CellPos) => !taken || c.row > taken.row || (c.row === taken.row && c.x > taken.x);
			for (const line of earlier(buffer, here)) {
				const hit = findPaths(line.text).at(-1);
				const f = hit && free(line.cells[hit.start]) ? join(buffer, line, hit, cwd) : undefined;
				if (f) {
					found.push(f);
					taken = f.taken;
				}
			}
			const hits = findPaths(here.text).filter((hit) => free(here.cells[hit.start]));
			hits.forEach((hit, i) => {
				// Only the last path can end the line.
				const f = i === hits.length - 1 ? join(buffer, here, hit, cwd) : undefined;
				found.push(f ?? span(here, hit, cwd));
			});
			const links: ILink[] = [];
			for (const { first, last, path, parts } of found) {
				const range = {
					start: { x: first.x + 1, y: first.row + 1 },
					end: { x: last.x + last.width, y: last.row + 1 },
				};
				// xterm asks row by row; a link over several rows is given for each.
				if (range.start.y > y || range.end.y < y) continue;
				// xterm asks again for each row the pointer moves to, so a click opens this row's fallback.
				const part = parts && (parts.find((p) => p.first.row <= y - 1 && y - 1 <= p.last.row) ?? parts[0]);
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
