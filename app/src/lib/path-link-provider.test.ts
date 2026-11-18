import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/headless';
import type { ILink } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
import { activateUri, type Invoker } from './file-links';
import { createPathChecker, type ExistsInvoker } from './path-exists';
import { lineText, pathLinkProvider, type LinkHandlers } from './path-link-provider';

const noop: LinkHandlers = { activate() {}, hover() {}, leave() {} };

const write = (t: Terminal, text: string) => new Promise<void>((r) => t.write(text, r));

async function term(cols: number, text: string): Promise<Terminal> {
	const t = new Terminal({ cols, rows: 24, allowProposedApi: true });
	// The app's terminals use Unicode 11 widths (see session-core).
	t.loadAddon(new Unicode11Addon());
	t.unicode.activeVersion = '11';
	await write(t, text);
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

// What a Cmd+click on row y's first link tries through the gate, and what it
// reports, when missing is the one path that does not exist.
async function cmdClick(t: Terminal, y: number, cwd: string, missing: string) {
	const tried: string[] = [];
	const said: string[] = [];
	const invoker: Invoker = async (path) => {
		tried.push(path);
		if (path === missing) throw 'no such file';
		return { action: 'opened' };
	};
	const handlers: LinkHandlers = { ...noop, activate: (e, text) => activateUri(e, text, (m) => said.push(m), () => {}, invoker) };
	links(t, y, cwd, handlers)![0].activate({ metaKey: true } as MouseEvent, '');
	// The invoker settles in microtasks, all run before a timer.
	await new Promise((r) => setTimeout(r));
	return { tried, said };
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
		expect(await cmdClick(t, 2, '/tmp/repo', joined)).toEqual({
			tried: [joined, own],
			said: [`${joined}: no such file, opening ${own}`],
		});
	});

	it('opens the clicked row\'s own path when a listing\'s paths are joined by mistake', async () => {
		// The first path ends one cell short of the edge. open_path answers a path
		// through a file, as the joined one is, as missing.
		const t = await term(24, '  ⎿  /tmp/repo/bin/tool\r\n     /tmp/repo/src/c.ts');
		const joined = '/tmp/repo/bin/tool/tmp/repo/src/c.ts';
		for (const [y, own] of [
			[1, '/tmp/repo/bin/tool'],
			[2, '/tmp/repo/src/c.ts'],
		] as const) {
			expect(await cmdClick(t, y, '', joined), `row ${y}`).toEqual({
				tried: [joined, own],
				said: [`${joined}: no such file, opening ${own}`],
			});
		}
	});

	it('ends a path where its colour ends, and lets one begin where a colour does', async () => {
		// Claude Code's inline code colour in its dark theme.
		const code = (s: string) => `\x1b[38;2;177;185;249m${s}\x1b[39m`;
		const at = async (line: string) => spans(links(await term(80, line), 1))?.map((l) => l.text);
		expect(spans(links(await term(80, `${code('~/.zshrc')}을 만듭니다`), 1))).toEqual([
			{ start: { x: 1, y: 1 }, end: { x: 8, y: 1 }, text: '~/.zshrc' },
		]);
		expect(await at(`${code('~/a.ts')}(이제 고침)`)).toEqual(['~/a.ts']);
		// A relative path is resolved from the session's folder, here the home one.
		expect(await at(`${code('src/a.ts')}(이제 고침)`)).toEqual(['~/src/a.ts']);
		// A command in backticks: the path in it ends with it too.
		expect(await at(`${code('cat ~/a.ts')}를 실행`)).toEqual(['~/a.ts']);
		expect(await at(`파일은${code('~/a.ts')}입니다`)).toEqual(['~/a.ts']);
		// A folder's closing / ends nothing more than any other character does.
		expect(await at(`${code('~/src/app/')}을 보세요`)).toEqual(['~/src/app/']);
		expect(await at(`${code('~/src/app/')}foo bar`)).toEqual(['~/src/app/']);
		// Colour comes first, also beside a /: a prompt that colours the parts of
		// one path apart has it cut there.
		expect(await at(`\x1b[34m~/src\x1b[36m/a.ts\x1b[39m을 $`)).toEqual(['~/src', '/a.ts']);
		// A part that is no path by itself makes no link.
		expect(await at(`${code('src/a')}b.ts`)).toBeUndefined();
		// The default colour ends nothing: plain text, and a colour that only
		// begins inside a path, read as before.
		expect(await at('~/.zshrc을 만듭니다')).toEqual(['~/.zshrc을']);
		expect(await at(`/tmp/report\x1b[31m.txt\x1b[39m`)).toEqual(['/tmp/report.txt']);
	});

	it('ends a joined path where its colour ends', async () => {
		const code = (s: string) => `\x1b[38;2;177;185;249m${s}\x1b[39m`;
		// 5 + 25 cells fill the row; the rest of the path is indented on the next line.
		const t = await term(30, `out: ${code('/tmp/example/aaaaaaaaaaa/')}\r\n  ${code('src/a.ts')}을 고침`);
		const want = [{ start: { x: 6, y: 1 }, end: { x: 10, y: 2 }, text: '/tmp/example/aaaaaaaaaaa/src/a.ts' }];
		expect(spans(links(t, 1))).toEqual(want);
		expect(spans(links(t, 2))).toEqual(want);
		// A folder in its colour at the edge does not take plain text on the next line.
		const folder = await term(30, `out: ${code('/tmp/example/aaaaaaaaaaa/')}\r\n  src/b.ts here`);
		expect(spans(links(folder, 1))?.map((l) => l.text)).toEqual(['/tmp/example/aaaaaaaaaaa/']);
		expect(spans(links(folder, 2))?.map((l) => l.text)).toEqual(['~/src/b.ts']);
		// A path in another colour after the joined one links on its own.
		const two = await term(30, `out: ${code('/tmp/example/aaaaaaaaaaa/')}\r\n  ${code('src/a.ts')}\x1b[32m~/b.ts\x1b[39m`);
		expect(spans(links(two, 2))?.map((l) => l.text)).toEqual(['/tmp/example/aaaaaaaaaaa/src/a.ts', '~/b.ts']);
		// Lines in two colours are two paths: the second joins with the line after it.
		const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
		const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
		const apart = await term(20, `${red('out: /tmp/aaaaaaaaaa')}\r\n${green('    src/abcdefghijkl')}\r\n${green('    m.ts')}`);
		expect(spans(links(apart, 1))?.map((l) => l.text)).toEqual(['/tmp/aaaaaaaaaa']);
		expect(spans(links(apart, 2))?.map((l) => l.text)).toEqual(['~/src/abcdefghijklm.ts']);
		expect(spans(links(apart, 3))?.map((l) => l.text)).toEqual(['~/src/abcdefghijklm.ts']);
		// A path whose colour ends before the row does leaves the next lines theirs.
		const ended = await term(20, `out: ${code('/tmp/aaaa')}뿐이야\r\n    src/abcdefghijkl\r\n    m.ts`);
		expect(spans(links(ended, 1))?.map((l) => l.text)).toEqual(['/tmp/aaaa']);
		expect(spans(links(ended, 2))?.map((l) => l.text)).toEqual(['~/src/abcdefghijklm.ts']);
		// A colour that only begins inside a wrapped path leaves it whole.
		const begins = await term(20, `    src/abcdef${red('ghijkl')}\r\n${red('    m.ts')}`);
		expect(spans(links(begins, 1))?.map((l) => l.text)).toEqual(['~/src/abcdefghijklm.ts']);
		// A colour that ends with the first line joins nothing, and throws nothing.
		const own = await term(20, `out: ${code('/tmp/aaaaaaaaaa')}\r\n    가가가가가가가가\r\n    나`);
		expect(spans(links(own, 1))?.map((l) => l.text)).toEqual(['/tmp/aaaaaaaaaa']);
		expect(links(own, 2)).toBeUndefined();
	});

	it('does not join a line that starts at column 0, as in a listing', async () => {
		for (const [next, own] of [
			['/tmp/other.txt', '/tmp/other.txt'],
			['~/other.txt', '~/other.txt'],
			['./x/y.ts', '/tmp/repo/./x/y.ts'],
			['src/lib/x.ts', '/tmp/repo/src/lib/x.ts'],
		]) {
			// The first path ends one cell short of the edge.
			const t = await term(20, `/tmp/abc/defg/hijk/\r\n${next}`);
			expect(spans(links(t, 1, '/tmp/repo')), next).toEqual([
				{ start: { x: 1, y: 1 }, end: { x: 19, y: 1 }, text: '/tmp/abc/defg/hijk/' },
			]);
			expect(spans(links(t, 2, '/tmp/repo')), next).toEqual([
				{ start: { x: 1, y: 2 }, end: { x: next.length, y: 2 }, text: own },
			]);
		}
	});

	it('does not join a first part that already ends in a file name', async () => {
		// Each first line is full; the next begins with a word, a list number or a
		// status letter. Each row keeps its own links, on itself.
		const own = (t: Terminal, y: number) => spans(links(t, y, '/tmp/repo'))?.map((l) => [l.start.y, l.end.y, l.text]);
		const prose = await term(34, 'I updated /tmp/repo/src/lib/aa.ts\r\n  to handle the rest');
		expect(own(prose, 1)).toEqual([[1, 1, '/tmp/repo/src/lib/aa.ts']]);
		expect(own(prose, 2)).toBeUndefined();
		const list = await term(20, '  1. /tmp/ab/cdef.ts\r\n  2. /tmp/x/y.ts');
		expect(own(list, 1)).toEqual([[1, 1, '/tmp/ab/cdef.ts']]);
		expect(own(list, 2)).toEqual([[2, 2, '/tmp/x/y.ts']]);
		const status = await term(24, ' M app/src/lib/abcde.ts\r\n M app/src/b.ts');
		expect(own(status, 1)).toEqual([[1, 1, '/tmp/repo/app/src/lib/abcde.ts']]);
		expect(own(status, 2)).toEqual([[2, 2, '/tmp/repo/app/src/b.ts']]);
	});

	it('joins a relative path whose first part is no path by itself', async () => {
		// A folder, then a break inside a name. Neither part is a path alone, so a
		// click has nothing to fall back to.
		for (const [first, rest] of [
			['app/src/lib/abc/', 'file-links.ts'],
			['app/src/lib/file', '-links.ts'],
		]) {
			const t = await term(20, `  - ${first}\r\n    ${rest}`);
			const path = `/tmp/repo/${first}${rest}`;
			const want = [{ start: { x: 5, y: 1 }, end: { x: 4 + rest.length, y: 2 }, text: path }];
			for (const y of [1, 2]) {
				expect(spans(links(t, y, '/tmp/repo')), `${first} row ${y}`).toEqual(want);
				expect(clicked(t, y, '/tmp/repo'), `${first} row ${y}`).toEqual([path]);
			}
		}
	});

	it('falls back to the clicked row\'s own path, or to none, when the first part is no path', async () => {
		const t = await term(27, '  - the file is in app/src/\r\n    lib/file-links.ts');
		const joined = '/tmp/repo/app/src/lib/file-links.ts';
		const want = [{ start: { x: 20, y: 1 }, end: { x: 21, y: 2 }, text: joined }];
		expect(spans(links(t, 1, '/tmp/repo'))).toEqual(want);
		expect(spans(links(t, 2, '/tmp/repo'))).toEqual(want);
		expect(clicked(t, 1, '/tmp/repo')).toEqual([joined]);
		expect(clicked(t, 2, '/tmp/repo')).toEqual([[joined, '/tmp/repo/lib/file-links.ts']]);
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

	it('joins a path that begins a row below a full row that cannot go on', async () => {
		// Rows 2 and 3 are one path; row 1 ends at the edge in a whole file name, a
		// word of prose, or tool output.
		const joined = async (rows: string[], x0: number, x1: number, text: string) => {
			const t = await term(24, rows.join('\r\n'));
			const want = [{ start: { x: x0, y: 2 }, end: { x: x1, y: 3 }, text }];
			for (const y of [2, 3]) expect(spans(links(t, y, '/tmp/repo')), `${rows[1]} row ${y}`).toEqual(want);
			return spans(links(t, 1, '/tmp/repo'));
		};
		const listing = ['  ⎿  /tmp/repo/src/aa.ts', '     /tmp/repo/src/lib/b', '     b/c.ts'];
		expect(await joined(listing, 6, 11, '/tmp/repo/src/lib/bb/c.ts')).toEqual([
			{ start: { x: 6, y: 1 }, end: { x: 24, y: 1 }, text: '/tmp/repo/src/aa.ts' },
		]);
		const prose = ['* The fixed one is now', '  /tmp/repo/scratchpad/', '  icon/fixed-shadow.png'];
		expect(await joined(prose, 3, 23, '/tmp/repo/scratchpad/icon/fixed-shadow.png')).toBeUndefined();
		const tool = ['  ⎿  Wrote 3 files in a ', '     app/src/lib/aaaaaa/', '     file-links.ts'];
		expect(await joined(tool, 6, 18, '/tmp/repo/app/src/lib/aaaaaa/file-links.ts')).toBeUndefined();
	});

	it('goes on from a row that is the rest of the row above only by the run it begins with', async () => {
		// Row 2 is all one name, so the path goes on into row 3.
		const b = 'b'.repeat(20);
		const t = await term(24, `out: /tmp/example/aaaaa/\r\n    ${b}\r\n    c.png`);
		const want = [{ start: { x: 6, y: 1 }, end: { x: 9, y: 3 }, text: `/tmp/example/aaaaa/${b}c.png` }];
		for (const y of [1, 2, 3]) expect(spans(links(t, y)), `row ${y}`).toEqual(want);
	});

	it('joins a second path that ends the row the first goes on into', async () => {
		// How Claude Code wraps a before-and-after summary: row 2 is the rest of
		// row 1's path, then a path of its own that goes on into row 3.
		const t = await term(30, '  - new: /tmp/example/scratch/\r\n    icon/a.png, old: /tmp/exam\r\n    ple/scratch/icon/b.png');
		const a = { start: { x: 10, y: 1 }, end: { x: 14, y: 2 }, text: '/tmp/example/scratch/icon/a.png' };
		const b = { start: { x: 22, y: 2 }, end: { x: 26, y: 3 }, text: '/tmp/example/scratch/icon/b.png' };
		expect(spans(links(t, 1, '/tmp/repo'))).toEqual([a]);
		expect(spans(links(t, 2, '/tmp/repo'))).toEqual([a, b]);
		expect(spans(links(t, 3, '/tmp/repo'))).toEqual([b]);
		// Row 3's own text, a relative path, is only what a click falls back to.
		expect(clicked(t, 3, '/tmp/repo')).toEqual([[b.text, '/tmp/repo/ple/scratch/icon/b.png']]);
		// The first path ends at the comma; the second's rest does not go on with it.
		const u = await term(24, 'out: /tmp/example/aaaaa/\r\n    b.ts and /tmp/cc/dd/\r\n    e.ts');
		const first = { start: { x: 6, y: 1 }, end: { x: 8, y: 2 }, text: '/tmp/example/aaaaa/b.ts' };
		const second = { start: { x: 14, y: 2 }, end: { x: 8, y: 3 }, text: '/tmp/cc/dd/e.ts' };
		expect(spans(links(u, 1))).toEqual([first]);
		expect(spans(links(u, 2))).toEqual([first, second]);
		expect(spans(links(u, 3))).toEqual([second]);
	});

	it('stops a chain at a part that already ends in a file name', async () => {
		// A folder at the edge, then two whole entries of a listing.
		const rows = ['  ⎿  /tmp/repo/src/libxx', '     /tmp/repo/src/a.tsx', '     /tmp/repo/b.ts'];
		const t = await term(24, rows.join('\r\n'));
		const guess = { start: { x: 6, y: 1 }, end: { x: 24, y: 2 }, text: '/tmp/repo/src/libxx/tmp/repo/src/a.tsx' };
		expect(spans(links(t, 1))).toEqual([guess]);
		expect(spans(links(t, 2))).toEqual([guess]);
		expect(spans(links(t, 3))).toEqual([{ start: { x: 6, y: 3 }, end: { x: 19, y: 3 }, text: '/tmp/repo/b.ts' }]);
		expect(clicked(t, 2)).toEqual([[guess.text, '/tmp/repo/src/a.tsx']]);
	});

	it('starts nothing from a row inside a joined path, seen from any row', async () => {
		// Row 2's path would join rows 2 to 4, but row 2 continues row 1: row 4 is
		// past the cap and gets no link.
		const d = 'd'.repeat(15);
		const t = await term(20, ['out: /aa/aaaaaaaaaaa', '     /bbbbbbbb/cccc', `     ${d}`, '     eeee.ts'].join('\r\n'));
		const want = [{ start: { x: 6, y: 1 }, end: { x: 20, y: 3 }, text: `/aa/aaaaaaaaaaa/bbbbbbbb/cccc${d}` }];
		for (const y of [1, 2, 3]) expect(spans(links(t, y)), `row ${y}`).toEqual(want);
		expect(links(t, 4)).toBeUndefined();
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

// A provider over a real checker whose disk has the paths in exists and cannot
// tell about those in unsure. It records each batch the checker sends, each
// run of the callback and what each hover and click hands on; with hold, a
// batch is answered only when its function in held is called.
function checked(t: Terminal, cwd: string, disk: { exists?: string[]; unsure?: string[]; hold?: boolean } = {}) {
	const batches: string[][] = [];
	const held: (() => void)[] = [];
	const replies: (ILink[] | undefined)[] = [];
	const clicks: unknown[] = [];
	const hovers: string[] = [];
	const invoker: ExistsInvoker = (paths) => {
		batches.push(paths.map((q) => q.path));
		const answer = () => paths.map(({ path }) => (disk.unsure?.includes(path) ? null : !!disk.exists?.includes(path)));
		if (!disk.hold) return Promise.resolve(answer());
		return new Promise((resolve) => void held.push(() => resolve(answer())));
	};
	const handlers: LinkHandlers = {
		...noop,
		activate: (_e, text) => void clicks.push(text),
		hover: (_e, text) => void hovers.push(text),
	};
	const provider = pathLinkProvider(t.buffer, cwd, handlers, createPathChecker(invoker));
	return {
		batches,
		held,
		replies,
		provide: (y: number) => provider.provideLinks(y, (l) => void replies.push(l)),
		// What a click on each link of the reply hands the gate.
		click(reply: ILink[] | undefined) {
			clicks.length = 0;
			for (const l of reply ?? []) l.activate({} as MouseEvent, '');
			return [...clicks];
		},
		// What a hover on each link of the reply hands the hover handler.
		hover(reply: ILink[] | undefined) {
			hovers.length = 0;
			for (const l of reply ?? []) l.hover!({} as MouseEvent, '');
			return [...hovers];
		},
	};
}

// Lets an answer, and the callback that waits on it, run: all in microtasks,
// well before the checker's 250 ms.
const settle = () => new Promise((r) => setTimeout(r));

describe('pathLinkProvider with an existence check', () => {
	const montage = 'Bash(montage "in/battle_b_frames.png" /tmp/repo/out.png)';
	const frames = '/tmp/repo/in/battle_b_frames.png';
	const out = '/tmp/repo/out.png';
	const outSpan = { start: { x: 39, y: 1 }, end: { x: 55, y: 1 }, text: out };

	it('links only the paths that exist', async () => {
		const c = checked(await term(80, montage), '/tmp/repo', { exists: [out] });
		c.provide(1);
		await settle();
		expect(c.replies.map(spans)).toEqual([[outSpan]]);
	});

	it('gives undefined when no path on the row exists', async () => {
		const c = checked(await term(80, montage), '/tmp/repo');
		c.provide(1);
		await settle();
		expect(c.replies).toEqual([undefined]);
	});

	it('links a path the app could not tell about, as without the check', async () => {
		const c = checked(await term(80, montage), '/tmp/repo', { unsure: [frames, out] });
		c.provide(1);
		await settle();
		expect(c.replies.map((r) => spans(r)?.map((l) => l.text))).toEqual([[frames, out]]);
	});

	it('asks for all the row\'s candidates in one batch per call', async () => {
		const c = checked(await term(80, montage), '/tmp/repo', { exists: [out] });
		c.provide(1);
		await settle();
		expect(c.batches).toEqual([[frames, out]]);
	});

	it('answers before it returns, asking nothing, when every candidate is cached', async () => {
		const c = checked(await term(80, montage), '/tmp/repo', { exists: [out] });
		c.provide(1);
		await settle();
		c.provide(1);
		expect(c.replies.map(spans)).toEqual([[outSpan], [outSpan]]);
		expect(c.batches).toHaveLength(1);
	});

	it('answers once, after the disk does, when a candidate is not cached', async () => {
		const c = checked(await term(80, montage), '/tmp/repo', { exists: [out], hold: true });
		c.provide(1);
		await settle();
		expect(c.replies).toEqual([]);
		c.held[0]();
		await settle();
		await settle();
		expect(c.replies.map(spans)).toEqual([[outSpan]]);
	});

	it('drops the reply of a call a later one overtook', async () => {
		const t = await term(80, 'cat /tmp/repo/a.ts\r\ncat /tmp/repo/b.ts');
		const c = checked(t, '', { exists: ['/tmp/repo/a.ts', '/tmp/repo/b.ts'], hold: true });
		c.provide(1);
		c.provide(2);
		await settle();
		expect(c.held).toHaveLength(2);
		c.held[1]();
		await settle();
		expect(c.replies.map(spans)).toEqual([[{ start: { x: 5, y: 2 }, end: { x: 18, y: 2 }, text: '/tmp/repo/b.ts' }]]);
		c.held[0]();
		await settle();
		expect(c.replies).toHaveLength(1);
	});

	it('works the links out again from the row as output left it during the wait', async () => {
		const t = await term(80, 'cat /tmp/repo/a.ts');
		const c = checked(t, '', { exists: ['/tmp/repo/a.ts'], hold: true });
		c.provide(1);
		await write(t, '\r\x1b[2Kcat /tmp/repo/other.ts');
		c.held[0]();
		await settle();
		await settle();
		// other.ts was not asked, so it is not known and links as without the check.
		expect(c.replies.map(spans)).toEqual([[{ start: { x: 5, y: 1 }, end: { x: 22, y: 1 }, text: '/tmp/repo/other.ts' }]]);
		expect(c.click(c.replies[0])).toEqual(['/tmp/repo/other.ts']);
		expect(c.batches).toEqual([['/tmp/repo/a.ts']]);
	});

	it('gives undefined when output left the row with no path during the wait', async () => {
		const t = await term(80, 'cat /tmp/repo/a.ts');
		const c = checked(t, '', { exists: ['/tmp/repo/a.ts'], hold: true });
		c.provide(1);
		await write(t, '\r\x1b[2Kdone');
		c.held[0]();
		await settle();
		await settle();
		expect(c.replies).toEqual([undefined]);
		expect(c.batches).toHaveLength(1);
	});

	describe('across a line break', () => {
		// The fixture of the joining tests above, 56 cells wide.
		const item = '  - 고친 원본: /private/tmp/example/d1c67ac3/scratchpad/\r\n    icon/fixed-shadow.png';
		const joined = '/private/tmp/example/d1c67ac3/scratchpad/icon/fixed-shadow.png';
		const fragment = '/private/tmp/example/d1c67ac3/scratchpad/';
		const own = '/tmp/repo/icon/fixed-shadow.png';
		const whole = { start: { x: 16, y: 1 }, end: { x: 25, y: 2 }, text: joined };

		async function row(y: number, disk: Parameters<typeof checked>[2]) {
			const c = checked(await term(56, item), '/tmp/repo', disk);
			c.provide(y);
			await settle();
			expect(c.replies, `row ${y}`).toHaveLength(1);
			return { reply: spans(c.replies[0]), clicks: c.click(c.replies[0]), batches: c.batches };
		}

		it('links the joined path when it exists', async () => {
			for (const y of [1, 2]) expect((await row(y, { exists: [joined] })).reply, `row ${y}`).toEqual([whole]);
		});

		it('links each line\'s own path, on its own cells, when the joined one is missing', async () => {
			const disk = { exists: [fragment, own] };
			const first = await row(1, disk);
			expect(first.reply).toEqual([{ start: { x: 16, y: 1 }, end: { x: 56, y: 1 }, text: fragment }]);
			expect(first.clicks).toEqual([fragment]);
			const second = await row(2, disk);
			expect(second.reply).toEqual([{ start: { x: 5, y: 2 }, end: { x: 25, y: 2 }, text: own }]);
			expect(second.clicks).toEqual([own]);
			// The line's own path is asked with the joined one.
			expect(second.batches).toEqual([[joined, own]]);
		});

		it('links nothing when the joined path and the line\'s own are missing', async () => {
			for (const y of [1, 2]) expect((await row(y, {})).reply, `row ${y}`).toBeUndefined();
		});

		it('links the joined path, falling back on a click as before, when the app could not tell', async () => {
			const got = await row(2, { unsure: [joined], exists: [own] });
			expect(got.reply).toEqual([whole]);
			expect(got.clicks).toEqual([[joined, own]]);
		});
	});
});

describe('pathLinkProvider with shell variables', () => {
	// A Bash call as Claude Code shows it, 100 cells wide: it wraps B's value
	// itself, at the edge of row 1, and indents what it carries over.
	const call = [
		'⏺ Bash(B=/private/tmp/claude-501/-Users-example-Developer-Projects-example-guild/90c8101a-f0ca-43dd-',
		'      83df-d0a61ff61c10/scratchpad && S=$B/party-battle && R=/tmp/repo/Assets/_Game/Art && ls -la',
		'      "$S/battle_b_frames.png" "$B/web-screens-1/1920x1080_07_panel_forest_road.png"',
		'      "$R/Sprites/Battle/C002/C002_zoom.png" "$S/p_battle_b.txt")',
	].join('\r\n');
	const B = '/private/tmp/claude-501/-Users-example-Developer-Projects-example-guild/90c8101a-f0ca-43dd-83df-d0a61ff61c10/scratchpad';
	const S = `${B}/party-battle`;
	const frames = { start: { x: 8, y: 3 }, end: { x: 29, y: 3 }, text: `${S}/battle_b_frames.png` };
	const road = { start: { x: 33, y: 3 }, end: { x: 83, y: 3 }, text: `${B}/web-screens-1/1920x1080_07_panel_forest_road.png` };
	const zoom = { start: { x: 8, y: 4 }, end: { x: 43, y: 4 }, text: '/tmp/repo/Assets/_Game/Art/Sprites/Battle/C002/C002_zoom.png' };
	const txt = { start: { x: 47, y: 4 }, end: { x: 63, y: 4 }, text: `${S}/p_battle_b.txt` };
	const all = [frames, road, zoom, txt].map((l) => l.text);

	it('links each variable path as its expansion, through the assignments of its own command', async () => {
		for (const [y, want] of [
			[3, [frames, road]],
			[4, [zoom, txt]],
		] as const) {
			const c = checked(await term(100, call), '/tmp/repo', { exists: all });
			c.provide(y);
			await settle();
			expect(c.replies.map(spans), `row ${y}`).toEqual([want]);
			expect(c.batches, `row ${y}`).toEqual([want.map((l) => l.text)]);
			expect(c.hover(c.replies[0]), `row ${y}`).toEqual(want.map((l) => l.text));
			expect(c.click(c.replies[0]), `row ${y}`).toEqual(want.map((l) => l.text));
		}
	});

	it('links only the expansions the disk has', async () => {
		const c = checked(await term(100, call), '/tmp/repo', { exists: [road.text] });
		c.provide(3);
		await settle();
		expect(c.replies.map(spans)).toEqual([[road]]);
	});

	// What row y of text links once the disk answered, and every path it was asked.
	async function at(text: string, disk: Parameters<typeof checked>[2] = {}, y = 1, cols = 80) {
		const c = checked(await term(cols, text), '/tmp/repo', disk);
		c.provide(y);
		await settle();
		expect(c.replies).toHaveLength(1);
		return { links: spans(c.replies[0])?.map((l) => l.text), batch: c.batches.flat() };
	}
	const linked = async (text: string, exists: string[], y = 1, cols = 80) => (await at(text, { exists }, y, cols)).links;

	describe('assignments', () => {
		it('takes a double-quoted value of an export for ${NAME}', async () => {
			expect(await linked('export S="/tmp/a" && cat ${S}/x.png', ['/tmp/a/x.png'])).toEqual(['/tmp/a/x.png']);
		});

		it('takes the latest assignment before the use', async () => {
			const both = ['/tmp/a/x.png', '/tmp/b/x.png'];
			expect(await linked('S=/tmp/a && S=/tmp/b && cat "$S/x.png"', both)).toEqual(['/tmp/b/x.png']);
			expect(await linked('S=/tmp/a && cat "$S/x.png" && S=/tmp/b', both)).toEqual(['/tmp/a/x.png']);
		});

		it('expands a value that is itself a variable path', async () => {
			expect(await linked('B=/tmp/a && S=$B/c && cat "$S/x.png"', ['/tmp/a/c/x.png'])).toEqual(['/tmp/a/c/x.png']);
		});

		it('takes $HOME as ~ unless the command assigns it', async () => {
			expect(await linked('cat "$HOME/x.png"', ['~/x.png'])).toEqual(['~/x.png']);
			expect(await linked('HOME=/tmp/h && cat "$HOME/x.png"', ['~/x.png', '/tmp/h/x.png'])).toEqual(['/tmp/h/x.png']);
		});

		it('takes a relative value from the starting folder, and a ~ one from home', async () => {
			expect(await linked('S=./out && cat "$S/x.png"', ['/tmp/repo/./out/x.png'])).toEqual(['/tmp/repo/./out/x.png']);
			expect(await linked('S=~/out && cat "$S/x.png"', ['~/out/x.png'])).toEqual(['~/out/x.png']);
		});

		it('leaves a value alone for an option that only looks like an assignment', async () => {
			const both = ['/tmp/a/x.png', '/tmp/b/x.png'];
			expect(await linked('S=/tmp/a && tool --S=/tmp/b && cat "$S/x.png"', both)).toEqual(['/tmp/a/x.png']);
		});
	});

	describe('a value not fully read', () => {
		const disk = { exists: ['/tmp/a/x.png'] };

		it('hides an earlier value of its name', async () => {
			for (const v of ["S='/tmp/b'", 'S=$(pwd)', 'S=foo', 'S=$X/b', 'S+=/b']) {
				const got = await at(`S=/tmp/a && ${v} && cat "$S/x.png"`, disk);
				expect(got.links, v).toBeUndefined();
				expect(got.batch, v).not.toContain('/tmp/a/x.png');
			}
		});

		it('gives its name no value', async () => {
			for (const v of ['S="/tmp/a,b" && ', 'S="/tmp/a b" && ', 'S=/tmp/a:12 && ', 'S=/tmp/a&&']) {
				const got = await at(`${v}cat "$S/x.png"`, disk);
				expect(got.links, v).toBeUndefined();
				expect(got.batch, v).not.toContain('/tmp/a/x.png');
			}
		});

		it('leaves a quoted ~ as it is, and a single-quoted HOME unknown', async () => {
			const quoted = await at('S="~/out" && cat "$S/x.png"', { exists: ['~/out/x.png'] });
			expect(quoted.links).toBeUndefined();
			expect(quoted.batch).not.toContain('~/out/x.png');
			const home = await at('HOME=\'/tmp/h\' && cat "$HOME/x.png"', { exists: ['~/x.png'] });
			expect(home.links).toBeUndefined();
			expect(home.batch).not.toContain('~/x.png');
		});

		it('gives a value wrapped onto the next line only when it ends there', async () => {
			// B's value fills its row of 30 cells and goes on, indented, on the next.
			const full = '/tmp/example/aaaaaaaaaaaaaaabbb/x.png';
			const cut = '/tmp/example/aaaaaaaaaaaaaaa/x.png';
			const row = (next: string) => `B=/tmp/example/aaaaaaaaaaaaaaa\r\n    ${next} && cat "$B/x.png"`;
			expect(await linked(row('bbb'), [full, cut], 2, 30)).toEqual([full]);
			const got = await at(row('bbb,b'), { exists: [full, cut] }, 2, 30);
			expect(got.links).toBeUndefined();
			expect(got.batch).not.toContain(full);
			expect(got.batch).not.toContain(cut);
		});
	});

	describe('the command', () => {
		const exists = ['/tmp/a/x.png'];

		it('does not reach an assignment on a line of its own above', async () => {
			const got = await at('export S=/tmp/a\r\nls "$S/x.png"', { exists }, 2);
			expect(got.links).toBeUndefined();
			expect(got.batch).not.toContain('/tmp/a/x.png');
		});

		it('takes the rows a command soft-wraps over', async () => {
			expect(await linked('S=/tmp/a && cat "$S/x.png"', exists, 2, 16)).toEqual(['/tmp/a/x.png']);
			// Three rows, each with a space, which lineText stops after.
			for (const y of [2, 3]) expect(await linked('S=/tmp/a && cat "$S/x.png"', exists, y, 10), `row ${y}`).toEqual(['/tmp/a/x.png']);
		});

		it('takes the indented lines of the running view', async () => {
			expect(await linked('  ⎿  $ B=/tmp/a &&\r\n     ls "$B/x.png"', exists, 2)).toEqual(['/tmp/a/x.png']);
		});

		it('stays fast on a command of long lines full of assignments', async () => {
			// Each line wraps over 42 rows with no whitespace past its indent.
			const long = `  ${'a=$a/b|'.repeat(600)}`;
			const t = await term(100, [...Array(9).fill(long), '  cat "$a/x.png"'].join('\r\n'));
			const y = t.buffer.active.baseY + t.buffer.active.cursorY + 1;
			expect(t.buffer.active.getLine(y - 1)?.translateToString(true)).toBe('  cat "$a/x.png"');
			const t0 = performance.now();
			links(t, y);
			expect(performance.now() - t0).toBeLessThan(50);
		});

		it(`reads up to ${8} lines above the hovered one`, async () => {
			const command = (between: number) => ['S=/tmp/a &&', ...Array(between).fill('     echo x &&'), '     ls "$S/x.png"'];
			expect(await linked(command(7).join('\r\n'), exists, 9)).toEqual(['/tmp/a/x.png']);
			expect(await linked(command(8).join('\r\n'), exists, 10)).toBeUndefined();
		});
	});

	describe('the disk answer', () => {
		const line = 'S=/tmp/a && cat "$S/x.png" /tmp/b.txt';

		it('does not link an expansion the disk could not tell about', async () => {
			expect((await at(line, { unsure: ['/tmp/a/x.png', '/tmp/b.txt'] })).links).toEqual(['/tmp/b.txt']);
		});

		it('links only plain paths with no checker', async () => {
			expect(spans(links(await term(80, line), 1))?.map((l) => l.text)).toEqual(['/tmp/a', '/tmp/b.txt']);
		});

		it('asks nothing for a variable nothing assigns', async () => {
			expect((await at('cat "$S/x.png" /tmp/b.txt')).batch).toEqual(['/tmp/b.txt']);
		});

		it('does not link a missing expansion', async () => {
			const got = await at('S=/tmp/a && cat "$S/x.png"', { exists: ['/tmp/a'] });
			expect(got.links).toEqual(['/tmp/a']);
			expect(got.batch).toContain('/tmp/a/x.png');
		});
	});

	it('joins a variable path across a line break, its parts expanded for a click to fall back to', async () => {
		// $S/aaaaaaa/ fills its row of 26 cells and goes on, indented, on the next.
		const t = await term(26, 'S=/tmp/a && ls $S/aaaaaaa/\r\n    b/c.png');
		const joined = '/tmp/a/aaaaaaa/b/c.png';
		const want = [{ start: { x: 16, y: 1 }, end: { x: 11, y: 2 }, text: joined }];
		for (const [y, part] of [
			[1, '/tmp/a/aaaaaaa/'],
			[2, '/tmp/repo/b/c.png'],
		] as const) {
			const c = checked(t, '/tmp/repo', { exists: [joined] });
			c.provide(y);
			await settle();
			expect(c.replies.map(spans), `row ${y}`).toEqual([want]);
			expect(c.click(c.replies[0]), `row ${y}`).toEqual([[joined, part]]);
		}
	});

	it('ends a variable path where its colour ends', async () => {
		const code = (s: string) => `\x1b[38;2;177;185;249m${s}\x1b[39m`;
		const c = checked(await term(80, `S=/tmp/a && cat ${code('$S/x.png')}을`), '/tmp/repo', { exists: ['/tmp/a/x.png'] });
		c.provide(1);
		await settle();
		expect(c.replies.map(spans)).toEqual([[{ start: { x: 17, y: 1 }, end: { x: 24, y: 1 }, text: '/tmp/a/x.png' }]]);
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
