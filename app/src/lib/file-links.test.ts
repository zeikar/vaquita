import { describe, expect, it } from 'vitest';
import { activateUri, fileUrlToPath, findPaths, openPath, resolvePath, type Invoker } from './file-links';

describe('fileUrlToPath', () => {
	it('splits host and path', () => {
		expect(fileUrlToPath('file:///tmp/a.txt')).toEqual({ host: '', path: '/tmp/a.txt' });
		expect(fileUrlToPath('file://localhost/tmp/a.txt')).toEqual({ host: 'localhost', path: '/tmp/a.txt' });
		expect(fileUrlToPath('file://mac.local/tmp/a.txt')).toEqual({ host: 'mac.local', path: '/tmp/a.txt' });
	});

	it('decodes percent escapes, keeping the raw text when that fails', () => {
		expect(fileUrlToPath('file:///tmp/a%20b.txt')?.path).toBe('/tmp/a b.txt');
		expect(fileUrlToPath('file:///tmp/a%zz')?.path).toBe('/tmp/a%zz');
	});

	it('keeps # and ? in file names', () => {
		expect(fileUrlToPath('file:///tmp/a#1?.txt')?.path).toBe('/tmp/a#1?.txt');
	});

	it('refuses other shapes', () => {
		expect(fileUrlToPath('file://host')).toBeUndefined();
		expect(fileUrlToPath('https://x')).toBeUndefined();
	});
});

describe('resolvePath', () => {
	it('leaves absolute, home and file paths alone', () => {
		for (const t of ['/tmp/a', '~', '~/a', 'file:///tmp/a']) expect(resolvePath(t, '/tmp/repo')).toBe(t);
	});

	it('joins relative text to cwd with one slash', () => {
		expect(resolvePath('./a.ts', '/tmp/repo')).toBe('/tmp/repo/./a.ts');
		expect(resolvePath('../b.ts', '/tmp/repo/')).toBe('/tmp/repo/../b.ts');
		expect(resolvePath('src/a.ts', '/tmp/repo')).toBe('/tmp/repo/src/a.ts');
		expect(resolvePath('src/a.ts', '/')).toBe('/src/a.ts');
	});

	it('treats an empty cwd as home', () => {
		expect(resolvePath('src/a.ts', '')).toBe('~/src/a.ts');
	});
});

describe('findPaths', () => {
	it('stays fast on a line of the length the provider sees', () => {
		for (const unit of ['(', '=', '.(', '[a', '=.', 'a(']) {
			const line = unit.repeat(Math.ceil(4300 / unit.length));
			const t0 = performance.now();
			findPaths(line);
			expect(performance.now() - t0, unit).toBeLessThan(20);
		}
		expect(findPaths('('.repeat(4300) + ' ls /tmp/a.txt')).toEqual([{ start: 4304, end: 4314, target: '/tmp/a.txt' }]);
	});

	it('finds an absolute path with offsets', () => {
		expect(findPaths('ls /tmp/a.txt')).toEqual([{ start: 3, end: 13, target: '/tmp/a.txt' }]);
	});

	it('finds home paths', () => {
		expect(findPaths('~')).toEqual([{ start: 0, end: 1, target: '~' }]);
		expect(findPaths('cat ~/docs/x.md')).toEqual([{ start: 4, end: 15, target: '~/docs/x.md' }]);
	});

	it('finds dot-relative paths', () => {
		expect(findPaths('./a.ts')[0].target).toBe('./a.ts');
		expect(findPaths('../b/c.ts')[0].target).toBe('../b/c.ts');
	});

	it('keeps a line and column suffix in the range but not the target', () => {
		const line = 'at src/lib/links.ts:12:3';
		expect(findPaths(line)).toEqual([{ start: 3, end: line.length, target: 'src/lib/links.ts' }]);
	});

	it('finds file URIs printed as text', () => {
		expect(findPaths('see file:///tmp/report.html')).toEqual([
			{ start: 4, end: 27, target: 'file:///tmp/report.html' },
		]);
	});

	it('skips things that only look like paths', () => {
		for (const l of ['and/or', '2026/10/24', 'TCP/IP', '1/2.5', '@xterm/addon-fit', 'https://example.com/a/b.ts']) {
			expect(findPaths(l)).toEqual([]);
		}
	});

	it('strips wrapping and trailing punctuation', () => {
		for (const l of ['(src/a.ts)', '"src/a.ts"', '`src/a.ts`', 'src/a.ts,', 'src/a.ts.', 'src/a.ts!', 'src/a.ts?']) {
			expect(findPaths(l).map((h) => h.target)).toEqual(['src/a.ts']);
		}
	});

	it('needs a token boundary before the path', () => {
		expect(findPaths('…/scratch.txt')).toEqual([]);
	});

	it('accepts Unicode names', () => {
		const hits = findPaths('~/문서/보고서.md');
		expect(hits).toHaveLength(1);
		expect(hits[0].target).toBe('~/문서/보고서.md');
	});

	it('accepts any characters in absolute paths', () => {
		for (const t of ['/tmp/a&b.txt', '/tmp/file~', '/tmp/x!y', '~/a&b', './a&b']) {
			expect(findPaths(`cat ${t}`).map((h) => h.target)).toEqual([t]);
		}
	});

	it('does not link comments or slash commands', () => {
		for (const l of ['// comment', 'a //b', '/help', '/model', '/clear', '~//x', './/x']) {
			expect(findPaths(l)).toEqual([]);
		}
		expect(findPaths('/tmp/x')).toHaveLength(1);
		expect(findPaths('/a.txt')).toHaveLength(1);
	});

	it('drops the line suffix from file URIs', () => {
		expect(findPaths('file:///tmp/a.ts:12:3')).toEqual([{ start: 0, end: 21, target: 'file:///tmp/a.ts' }]);
	});

	it('reports string offsets after wide characters', () => {
		expect(findPaths('한글 ~/a.md')).toEqual([{ start: 3, end: 9, target: '~/a.md' }]);
	});

	it('starts after = and splits at commas', () => {
		expect(findPaths('--out=/tmp/x.txt').map((h) => h.target)).toEqual(['/tmp/x.txt']);
		expect(findPaths('x/a.ts,y/b.ts').map((h) => h.target)).toEqual(['x/a.ts', 'y/b.ts']);
	});

	it('finds several paths in order', () => {
		expect(findPaths('cp /tmp/a.txt ./b.txt').map((h) => h.target)).toEqual(['/tmp/a.txt', './b.txt']);
	});
});

// One result per call, the last repeating.
function fakeInvoker(...results: (Awaited<ReturnType<Invoker>> | Error | string)[]) {
	const calls: { path: string; host: string }[] = [];
	const invoker: Invoker = async (path, host) => {
		const result = results[Math.min(calls.length, results.length - 1)];
		calls.push({ path, host });
		if (typeof result === 'string' || result instanceof Error) throw result;
		return result;
	};
	return { calls, invoker };
}

describe('openPath', () => {
	it('reports nothing when opened', async () => {
		const { invoker, calls } = fakeInvoker({ action: 'opened' });
		const said: string[] = [];
		await openPath('/tmp/a', '', (m) => said.push(m), () => {}, invoker);
		expect(calls).toEqual([{ path: '/tmp/a', host: '' }]);
		expect(said).toEqual([]);
	});

	it('reports a reveal, as no failure', async () => {
		const { invoker } = fakeInvoker({ action: 'revealed', why: 'it is a script' });
		const said: [string, string?][] = [];
		await openPath('/tmp/a.sh', '', (m, tone) => said.push([m, tone]), () => {}, invoker);
		expect(said).toEqual([['revealed in Finder, not opened: /tmp/a.sh (it is a script)', 'info']]);
	});

	it('hands a viewable file to onView and reports nothing', async () => {
		const { invoker } = fakeInvoker({ action: 'view', path: '/tmp/real/a.md' });
		const said: string[] = [];
		const viewed: string[] = [];
		await openPath('/tmp/a.md', '', (m) => said.push(m), (p) => viewed.push(p), invoker);
		expect(viewed).toEqual(['/tmp/real/a.md']);
		expect(said).toEqual([]);
	});

	it('reports a rejection, string or Error', async () => {
		const said: string[] = [];
		await openPath('/tmp/a', '', (m) => said.push(m), () => {}, fakeInvoker('no such file').invoker);
		await openPath('/tmp/b', '', (m) => said.push(m), () => {}, fakeInvoker(new Error('boom')).invoker);
		expect(said).toEqual(['open /tmp/a: no such file', 'open /tmp/b: boom']);
	});
});

describe('activateUri', () => {
	function click(text: string, metaKey: boolean) {
		const { invoker, calls } = fakeInvoker({ action: 'opened' });
		const opened: string[] = [];
		activateUri({ metaKey } as MouseEvent, text, () => {}, () => {}, invoker, (u) => void opened.push(u));
		return { calls, opened };
	}

	it('does nothing without Cmd', () => {
		for (const t of ['file:///tmp/a', '/tmp/a', '~/a', 'https://example.com', 'javascript:alert(1)']) {
			expect(click(t, false)).toEqual({ calls: [], opened: [] });
		}
	});

	it('opens file URIs through the invoker', () => {
		expect(click('file:///tmp/a', true).calls).toEqual([{ path: '/tmp/a', host: '' }]);
		expect(click('file://mac.local/x', true).calls).toEqual([{ path: '/x', host: 'mac.local' }]);
	});

	it('opens absolute and home paths through the invoker', () => {
		expect(click('/tmp/a', true).calls).toEqual([{ path: '/tmp/a', host: '' }]);
		expect(click('~/a', true).calls).toEqual([{ path: '~/a', host: '' }]);
	});

	it('ignores ~user paths', () => {
		expect(click('~foo', true)).toEqual({ calls: [], opened: [] });
	});

	it('opens web and mail links through the opener', () => {
		expect(click('https://example.com', true)).toEqual({ calls: [], opened: ['https://example.com'] });
		expect(click('mailto:a@example.com', true).opened).toEqual(['mailto:a@example.com']);
	});

	it('ignores other schemes', () => {
		for (const t of ['javascript:alert(1)', 'ssh://host']) expect(click(t, true)).toEqual({ calls: [], opened: [] });
	});
});

describe('activateUri with a fallback', () => {
	const pair = ['/tmp/example/dir/icon/a.png', '/tmp/example/dir/'] as const;

	async function click(metaKey: boolean, ...results: Parameters<typeof fakeInvoker>) {
		const { invoker, calls } = fakeInvoker(...results);
		// Only a report that is no failure passes a tone.
		const said: string[] = [];
		activateUri({ metaKey } as MouseEvent, pair, (m, tone) => said.push(tone ? `${tone}: ${m}` : m), () => {}, invoker);
		// The invoker settles in microtasks, all run before a timer.
		await new Promise((r) => setTimeout(r));
		return { tried: calls.map((c) => c.path), said };
	}

	it('does nothing without Cmd', async () => {
		expect(await click(false, 'no such file')).toEqual({ tried: [], said: [] });
	});

	it('opens the joined path when it exists', async () => {
		expect(await click(true, { action: 'opened' })).toEqual({ tried: [pair[0]], said: [] });
	});

	const switched = `info: ${pair[0]}: no such file, opening ${pair[1]}`;

	it('opens the fallback, saying so, when the joined path does not exist', async () => {
		expect(await click(true, 'no such file', { action: 'opened' })).toEqual({ tried: [...pair], said: [switched] });
		expect(await click(true, new Error('no such file'), { action: 'opened' })).toEqual({
			tried: [...pair],
			said: [switched],
		});
	});

	it('reports when neither exists', async () => {
		expect(await click(true, 'no such file')).toEqual({
			tried: [...pair],
			said: [switched, `open ${pair[1]}: no such file`],
		});
	});

	it('does not try again after any other failure', async () => {
		expect(await click(true, 'not an absolute path')).toEqual({
			tried: [pair[0]],
			said: [`open ${pair[0]}: not an absolute path`],
		});
	});

	it('does not try again after a reveal', async () => {
		expect(await click(true, { action: 'revealed', why: 'it is a script' })).toEqual({
			tried: [pair[0]],
			said: [`info: revealed in Finder, not opened: ${pair[0]} (it is a script)`],
		});
	});
});
