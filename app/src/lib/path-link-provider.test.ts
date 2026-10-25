import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/headless';
import type { ILink } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { activateUri, type Invoker } from './file-links';
import { lineText, pathLinkProvider, type LinkHandlers } from './path-link-provider';

const noop: LinkHandlers = { activate() {}, hover() {}, leave() {} };

async function term(cols: number, text: string): Promise<Terminal> {
	const t = new Terminal({ cols, rows: 24, allowProposedApi: true });
	// The app's terminals use Unicode 11 widths (see session-core).
	t.loadAddon(new Unicode11Addon());
	t.unicode.activeVersion = '11';
	await new Promise<void>((r) => t.write(text, r));
	return t;
}

function links(t: Terminal, y: number, cwd = '', handlers = noop): ILink[] | undefined {
	let got: ILink[] | undefined;
	pathLinkProvider(t.buffer, cwd, handlers).provideLinks(y, (l) => (got = l));
	return got;
}

function spans(l: ILink[] | undefined) {
	return l?.map(({ range, text }) => ({ start: range.start, end: range.end, text }));
}

// What a click on each link on row y hands the gate.
function clicked(t: Terminal, y: number, cwd = ''): unknown[] {
	const got: unknown[] = [];
	const handlers = { ...noop, activate: (_e: MouseEvent, text: unknown) => void got.push(text) };
	for (const l of links(t, y, cwd, handlers) ?? []) l.activate({} as MouseEvent, '');
	return got;
}

describe('pathLinkProvider', () => {
	it('links an absolute path and passes its text to the handlers', async () => {
		const t = await term(80, 'ls /tmp/a.txt');
		const calls: string[] = [];
		const handlers: LinkHandlers = {
			activate: (_e, text) => calls.push(`activate ${text}`),
			hover: (_e, text) => calls.push(`hover ${text}`),
			leave: (_e, text) => calls.push(`leave ${text}`),
		};
		const got = links(t, 1, '', handlers);
		expect(spans(got)).toEqual([{ start: { x: 4, y: 1 }, end: { x: 13, y: 1 }, text: '/tmp/a.txt' }]);
		const e = {} as MouseEvent;
		got![0].hover!(e, '');
		got![0].activate(e, '');
		got![0].leave!(e, '');
		expect(calls).toEqual(['hover /tmp/a.txt', 'activate /tmp/a.txt', 'leave /tmp/a.txt']);
	});

	it('counts wide characters as two cells', async () => {
		const t = await term(80, 'cat ~/문서/보고서.md');
		expect(spans(links(t, 1))).toEqual([{ start: { x: 5, y: 1 }, end: { x: 20, y: 1 }, text: '~/문서/보고서.md' }]);
	});

	it('skips the empty last cell a wide character leaves when it wraps', async () => {
		// 보 does not fit in column 12 and goes to the next row.
		const t = await term(12, 'cat ~/문서/보고서.md');
		const want = [{ start: { x: 5, y: 1 }, end: { x: 9, y: 2 }, text: '~/문서/보고서.md' }];
		expect(spans(links(t, 1))).toEqual(want);
		expect(spans(links(t, 2))).toEqual(want);
	});

	it('keeps a gap erased after the row wrapped', async () => {
		const t = await term(20, 'cat /tmp/abcdefghijklmnop.txt\x1b[A\x1b[13G\x1b[K');
		expect(t.buffer.active.getLine(1)?.isWrapped).toBe(true);
		expect(spans(links(t, 1))).toEqual([{ start: { x: 5, y: 1 }, end: { x: 12, y: 1 }, text: '/tmp/abc' }]);
		expect(links(t, 2)).toBeUndefined();
	});

	it('maps astral characters, two code units in one cell', async () => {
		const t = await term(80, 'echo 😀 /tmp/a/😀');
		expect(spans(links(t, 1))).toEqual([{ start: { x: 9, y: 1 }, end: { x: 17, y: 1 }, text: '/tmp/a/😀' }]);
	});

	it('resolves a relative path against the starting folder', async () => {
		const t = await term(80, 'edit src/a.ts:12');
		expect(spans(links(t, 1, '/tmp/repo'))).toEqual([
			{ start: { x: 6, y: 1 }, end: { x: 16, y: 1 }, text: '/tmp/repo/src/a.ts' },
		]);
	});

	it('gives a path over wrapped rows for each of them', async () => {
		const path = '/tmp/abcdefghijklmnopqrstuvwxy.txt';
		expect(path).toHaveLength(34);
		const t = await term(20, path);
		const want = [{ start: { x: 1, y: 1 }, end: { x: 14, y: 2 }, text: path }];
		expect(spans(links(t, 1))).toEqual(want);
		expect(spans(links(t, 2))).toEqual(want);
	});

	it('gives only the links that touch the row', async () => {
		const t = await term(20, '/tmp/a.txt word word /tmp/b.txt');
		expect(spans(links(t, 1))).toEqual([{ start: { x: 1, y: 1 }, end: { x: 10, y: 1 }, text: '/tmp/a.txt' }]);
		expect(spans(links(t, 2))).toEqual([{ start: { x: 2, y: 2 }, end: { x: 11, y: 2 }, text: '/tmp/b.txt' }]);
	});

	it('takes y as a buffer line, past the rows on screen', async () => {
		const lines = Array.from({ length: 39 }, (_, i) => `line ${i + 1}`);
		const t = await term(80, [...lines, 'ls /tmp/a.txt'].join('\r\n'));
		expect(t.buffer.active.baseY).toBeGreaterThan(0);
		expect(links(t, 24)).toBeUndefined();
		expect(spans(links(t, 40))).toEqual([{ start: { x: 4, y: 40 }, end: { x: 13, y: 40 }, text: '/tmp/a.txt' }]);
	});

	it('gives undefined for a row without paths', async () => {
		const t = await term(80, 'hello world');
		expect(links(t, 1)).toBeUndefined();
		expect(links(t, 2)).toBeUndefined();
	});
});

describe('pathLinkProvider across a line break', () => {
	// Claude Code wraps this list item itself: a newline, then an indent.
	const item = '  - 고친 원본: /private/tmp/example/d1c67ac3/scratchpad/\r\n    icon/fixed-shadow.png';
	const joined = '/private/tmp/example/d1c67ac3/scratchpad/icon/fixed-shadow.png';
	const fragment = '/private/tmp/example/d1c67ac3/scratchpad/';

	it('joins a path that fills its row with the run that begins the next one', async () => {
		// 15 cells before the path, 41 in it: the row is full at 56.
		const t = await term(56, item);
		expect(t.buffer.active.getLine(1)?.isWrapped).toBe(false);
		const hovered: string[] = [];
		const handlers: LinkHandlers = { ...noop, hover: (_e, text) => void hovered.push(text) };
		const want = [{ start: { x: 16, y: 1 }, end: { x: 25, y: 2 }, text: joined }];
		expect(spans(links(t, 1, '/tmp/repo'))).toEqual(want);
		const got = links(t, 2, '/tmp/repo', handlers);
		expect(spans(got)).toEqual(want);
		got![0].hover!({} as MouseEvent, '');
		expect(hovered).toEqual([joined]);
	});

	it('falls back to the path that stood on its own on the clicked row', async () => {
		const t = await term(56, item);
		const own = '/tmp/repo/icon/fixed-shadow.png';
		expect(clicked(t, 1, '/tmp/repo')).toEqual([[joined, fragment]]);
		expect(clicked(t, 2, '/tmp/repo')).toEqual([[joined, own]]);
		// Through the gate: the joined path is missing, so row 2's own path opens, not row 1's.
		const tried: string[] = [];
		const invoker: Invoker = async (path) => {
			tried.push(path);
			if (tried.length === 1) throw 'no such file';
			return { action: 'opened' };
		};
		const handlers: LinkHandlers = { ...noop, activate: (e, text) => activateUri(e, text, () => {}, invoker) };
		links(t, 2, '/tmp/repo', handlers)![0].activate({ metaKey: true } as MouseEvent, '');
		// The invoker settles in microtasks, all run before a timer.
		await new Promise((r) => setTimeout(r));
		expect(tried).toEqual([joined, own]);
	});

	it('does not join a path at column 0, as in a listing', async () => {
		for (const next of ['/tmp/other.txt', '~/other.txt']) {
			// The first path ends one cell short of the edge.
			const t = await term(20, `/tmp/abc/defg/hi.ts\r\n${next}`);
			expect(spans(links(t, 1)), next).toEqual([
				{ start: { x: 1, y: 1 }, end: { x: 19, y: 1 }, text: '/tmp/abc/defg/hi.ts' },
			]);
			expect(spans(links(t, 2)), next).toEqual([{ start: { x: 1, y: 2 }, end: { x: next.length, y: 2 }, text: next }]);
		}
	});

	it('joins an indented run that starts with a slash', async () => {
		const t = await term(20, 'see /tmp/abc/defghi\r\n    /j.ts');
		const want = [{ start: { x: 5, y: 1 }, end: { x: 9, y: 2 }, text: '/tmp/abc/defghi/j.ts' }];
		expect(spans(links(t, 1))).toEqual(want);
		expect(spans(links(t, 2))).toEqual(want);
		expect(clicked(t, 1)).toEqual([['/tmp/abc/defghi/j.ts', '/tmp/abc/defghi']]);
		expect(clicked(t, 2)).toEqual([['/tmp/abc/defghi/j.ts', '/j.ts']]);
	});

	it('allows two empty cells at the edge, not three', async () => {
		const want = [{ start: { x: 16, y: 1 }, end: { x: 25, y: 2 }, text: joined }];
		expect(spans(links(await term(58, item), 2))).toEqual(want);
		const t = await term(59, item);
		expect(spans(links(t, 1, '/tmp/repo'))).toEqual([{ start: { x: 16, y: 1 }, end: { x: 56, y: 1 }, text: fragment }]);
		expect(spans(links(t, 2, '/tmp/repo'))).toEqual([
			{ start: { x: 5, y: 2 }, end: { x: 25, y: 2 }, text: '/tmp/repo/icon/fixed-shadow.png' },
		]);
	});

	it('leaves a path that ends well before the edge alone', async () => {
		const t = await term(80, item);
		expect(spans(links(t, 1, '/tmp/repo'))).toEqual([{ start: { x: 16, y: 1 }, end: { x: 56, y: 1 }, text: fragment }]);
		expect(spans(links(t, 2, '/tmp/repo'))).toEqual([
			{ start: { x: 5, y: 2 }, end: { x: 25, y: 2 }, text: '/tmp/repo/icon/fixed-shadow.png' },
		]);
	});

	// 30 cells: the row is full at 30.
	const full = 'out: /tmp/example/aaaaaaaaaaa/';

	it('takes only the first run of the next line, whatever follows it', async () => {
		// The run replaces the path it is on its own; a guess wrong about prose is
		// undone by the click, which falls back to the first line's path.
		const t = await term(30, `${full}\r\n    src/a.ts and src/b.ts`);
		const first = { start: { x: 6, y: 1 }, end: { x: 12, y: 2 }, text: '/tmp/example/aaaaaaaaaaa/src/a.ts' };
		expect(spans(links(t, 1, '/tmp/repo'))).toEqual([first]);
		expect(spans(links(t, 2, '/tmp/repo'))).toEqual([
			first,
			{ start: { x: 18, y: 2 }, end: { x: 25, y: 2 }, text: '/tmp/repo/src/b.ts' },
		]);
	});

	it('keeps the line suffix out of the joined path and trailing punctuation out of its range', async () => {
		const t = await term(30, `${full}\r\n    src/a.ts:12.`);
		const want = [{ start: { x: 6, y: 1 }, end: { x: 15, y: 2 }, text: '/tmp/example/aaaaaaaaaaa/src/a.ts' }];
		expect(spans(links(t, 1))).toEqual(want);
		expect(spans(links(t, 2))).toEqual(want);
	});

	it('does not join a next line that begins with other text', async () => {
		const alone = [{ start: { x: 6, y: 1 }, end: { x: 30, y: 1 }, text: '/tmp/example/aaaaaaaaaaa/' }];
		for (const next of ['    (see notes)', '  - next item', '', '    ... more']) {
			const t = await term(30, `${full}\r\n${next}`);
			expect(spans(links(t, 1)), next).toEqual(alone);
			expect(links(t, 2), next).toBeUndefined();
		}
	});

	it('does not join a file URI', async () => {
		const t = await term(28, 'see file:///tmp/example/dir/\r\n    a/b.png');
		expect(spans(links(t, 1))).toEqual([
			{ start: { x: 5, y: 1 }, end: { x: 28, y: 1 }, text: 'file:///tmp/example/dir/' },
		]);
		expect(spans(links(t, 2, '/tmp/repo'))).toEqual([
			{ start: { x: 5, y: 2 }, end: { x: 11, y: 2 }, text: '/tmp/repo/a/b.png' },
		]);
	});

	// Rows of 24 cells, each full.
	const b = 'b'.repeat(19);
	const c = 'c'.repeat(19);

	it('joins a third line when the second run fills its row too', async () => {
		const t = await term(24, `out: /tmp/example/aaaaa/\r\n    ${b}/\r\n    c.png`);
		const want = [{ start: { x: 6, y: 1 }, end: { x: 9, y: 3 }, text: `/tmp/example/aaaaa/${b}/c.png` }];
		for (const y of [1, 2, 3]) expect(spans(links(t, y)), `row ${y}`).toEqual(want);
		// Rows 2 and 3 have no path of their own: a click falls back to row 1's.
		for (const y of [2, 3]) expect(clicked(t, y), `row ${y}`).toEqual([[want[0].text, '/tmp/example/aaaaa/']]);
	});

	it('joins at most three lines', async () => {
		const t = await term(24, `out: /tmp/example/aaaaa/\r\n    ${b}/\r\n    ${c}/\r\n    d/e.png`);
		const want = [{ start: { x: 6, y: 1 }, end: { x: 24, y: 3 }, text: `/tmp/example/aaaaa/${b}/${c}/` }];
		for (const y of [1, 2, 3]) expect(spans(links(t, y, '/tmp/repo')), `row ${y}`).toEqual(want);
		expect(spans(links(t, 4, '/tmp/repo'))).toEqual([
			{ start: { x: 5, y: 4 }, end: { x: 11, y: 4 }, text: '/tmp/repo/d/e.png' },
		]);
	});

	it('joins at the end of a line that wrapped on its own', async () => {
		// Rows 1 and 2 are one wrapped line, full at 20; row 3 follows a newline.
		const t = await term(20, `see /tmp/${'a'.repeat(30)}/\r\n    b.txt`);
		expect(t.buffer.active.getLine(1)?.isWrapped).toBe(true);
		const want = [{ start: { x: 5, y: 1 }, end: { x: 9, y: 3 }, text: `/tmp/${'a'.repeat(30)}/b.txt` }];
		for (const y of [1, 2, 3]) expect(spans(links(t, y)), `row ${y}`).toEqual(want);
	});

	it('joins a path that ends in a wide character', async () => {
		// 더 ends in column 21 of 22, leaving one cell.
		const t = await term(22, 'cat ~/문서/보고서폴더\r\n  /최종.md');
		const want = [{ start: { x: 5, y: 1 }, end: { x: 10, y: 2 }, text: '~/문서/보고서폴더/최종.md' }];
		expect(spans(links(t, 1))).toEqual(want);
		expect(spans(links(t, 2))).toEqual(want);
	});
});

describe('lineText', () => {
	it('reads at most about 2048 cells each way of a huge wrapped line', async () => {
		// No whitespace to stop at; the path is on row 101 of 200.
		const t = await term(80, 'x'.repeat(8000) + '(/tmp/a.txt)' + 'x'.repeat(8000 - 12));
		const { text, cells } = lineText(t.buffer, 100);
		expect(cells).toHaveLength(text.length);
		// Each way stops on the first row past 2048 cells.
		expect(text.length).toBeGreaterThan(2 * 2048);
		expect(text.length).toBeLessThanOrEqual(2 * (2048 + 80) + 80);
		expect(spans(links(t, 101))).toEqual([{ start: { x: 2, y: 101 }, end: { x: 11, y: 101 }, text: '/tmp/a.txt' }]);
	});

	it('stops each way after a row with whitespace', async () => {
		const rows = ['x'.repeat(10), 'xxxx yyyyy', 'y'.repeat(10), 'yyyy zzzzz', 'z'.repeat(10)];
		const t = await term(10, rows.join(''));
		const { text, cells } = lineText(t.buffer, 2);
		expect(text).toBe(rows.slice(1, 4).join(''));
		expect(cells[0].row).toBe(1);
	});

	it('keeps real spaces at the end of a row before a wrapped wide character', async () => {
		const t = await term(12, 'see /tmp/a  보.txt');
		expect(lineText(t.buffer, 0).text.trimEnd()).toBe('see /tmp/a  보.txt');
		expect(spans(links(t, 1))).toEqual([{ start: { x: 5, y: 1 }, end: { x: 10, y: 1 }, text: '/tmp/a' }]);
	});

	it('reads empty cells between words as spaces', async () => {
		const t = await term(80, 'a\x1b[3Cb');
		expect(lineText(t.buffer, 0).text.trimEnd()).toBe('a   b');
	});
});
