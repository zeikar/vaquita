import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/headless';
import type { ILink } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';
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
