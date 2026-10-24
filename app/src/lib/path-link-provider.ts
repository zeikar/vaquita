import type { IBufferCell, IBufferLine, ILink, ILinkProvider } from '@xterm/xterm';
import { findPaths, resolvePath } from './file-links';

// Only getLine, so a headless terminal's buffer can stand in for xterm's.
export interface BufferLike {
	readonly active: { getLine(y: number): IBufferLine | undefined };
}

// Where one UTF-16 code unit of a logical line sits: 0-based row and column,
// and the width of its cell.
type CellPos = { row: number; x: number; width: number };

type LineText = { text: string; cells: CellPos[] };

export interface LinkHandlers {
	activate(e: MouseEvent, text: string): void;
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

// Links for paths in plain terminal text. Ranges follow WebLinksAddon: 1-based,
// end inclusive, and a wide last character ends on its right cell.
export function pathLinkProvider(buffer: BufferLike, cwd: string, handlers: LinkHandlers): ILinkProvider {
	return {
		provideLinks(y, callback) {
			const { text, cells } = lineText(buffer, y - 1);
			const links: ILink[] = [];
			for (const hit of findPaths(text)) {
				const first = cells[hit.start];
				const last = cells[hit.end - 1];
				const range = {
					start: { x: first.x + 1, y: first.row + 1 },
					end: { x: last.x + last.width, y: last.row + 1 },
				};
				// xterm asks row by row; a link over wrapped rows is given for each.
				if (range.start.y > y || range.end.y < y) continue;
				const path = resolvePath(hit.target, cwd);
				links.push({
					range,
					text: path,
					activate: (e) => handlers.activate(e, path),
					hover: (e) => handlers.hover(e, path),
					leave: (e) => handlers.leave(e, path),
				});
			}
			callback(links.length > 0 ? links : undefined);
		},
	};
}
