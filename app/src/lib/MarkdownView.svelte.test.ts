// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Stamp } from './files';
import MarkdownView from './MarkdownView.svelte';

// The sanitizing is markdown.test.ts's, under a DOM DOMPurify can walk; here
// the text is shown as it comes, so the view's own rules can be seen.
vi.mock('./markdown', async (original) => ({ ...(await original<typeof import('./markdown')>()), renderMarkdown: async (text: string) => text }));

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => (resolve = res));
	return { promise, resolve };
}

const stamp: Stamp = { secs: 1, nanos: 0, len: 1 };

function setup(texts: Record<string, string> = {}) {
	const reads = new Map<string, ReturnType<typeof deferred<{ text: string; stamp: Stamp }>>>();
	const read = (p: string) => {
		if (!reads.has(p)) reads.set(p, deferred());
		return reads.get(p)!;
	};
	const documents = {
		textOf: vi.fn((p: string) => texts[p]),
		refresh: vi.fn(async (_p: string, _still: () => boolean) => {}),
	};
	const opener = vi.fn();
	const write = vi.fn(async (_text: string) => {});
	// Lets through what is under docs/, as the app does what is in the repo.
	const image = vi.fn(async (_file: string, src: string, _repo?: string) => {
		if (!src.startsWith('docs/')) throw new Error('outside the file\'s repo or folder');
		return `asset://localhost/${src}`;
	});
	return { read, readText: vi.fn((p: string) => read(p).promise), documents, opener, write, image };
}

type Setup = ReturnType<typeof setup>;

function show(s: Setup, path: string, repo?: string) {
	const props = $state({ path, repo, report: vi.fn(), documents: s.documents, read: s.readText, image: s.image, opener: s.opener, write: s.write });
	target = document.createElement('div');
	document.body.append(target);
	shown = mount(MarkdownView, { target, props });
	flushSync();
	return props;
}

async function settle() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	flushSync();
}

const body = () => target.querySelector('.body')?.innerHTML;

afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target?.remove();
});

describe('MarkdownView', () => {
	it('shows the document’s text, unsaved edits and all, after refreshing a clean one', async () => {
		const s = setup({ '/tmp/repo/a.md': '<p>edited</p>' });
		show(s, '/tmp/repo/a.md');
		await settle();
		expect(s.documents.refresh).toHaveBeenCalledWith('/tmp/repo/a.md', expect.any(Function));
		expect(s.readText).not.toHaveBeenCalled();
		expect(body()).toBe('<p>edited</p>');
	});

	it('reads the file when it has no document', async () => {
		const s = setup();
		show(s, '/tmp/repo/a.md');
		s.read('/tmp/repo/a.md').resolve({ text: '<p>on disk</p>', stamp });
		await settle();
		expect(body()).toBe('<p>on disk</p>');
	});

	it('does not show a read for a path no longer shown', async () => {
		const s = setup();
		const props = show(s, '/tmp/repo/a.md');
		props.path = '/tmp/repo/b.md';
		flushSync();
		s.read('/tmp/repo/b.md').resolve({ text: '<p>b</p>', stamp });
		await settle();
		s.read('/tmp/repo/a.md').resolve({ text: '<p>a</p>', stamp });
		await settle();
		expect(body()).toBe('<p>b</p>');
	});

	it('follows no link, and opens only web and mail links outside', async () => {
		const s = setup({
			'/tmp/repo/a.md': '<a href="https://example.com/x">web</a><a href="other.md">relative</a><a href="file:///etc/hosts">file</a><a href="#top"><em>anchor</em></a>',
		});
		show(s, '/tmp/repo/a.md');
		await settle();
		const click = (a: Element, type = 'click') => {
			const e = new MouseEvent(type, { bubbles: true, cancelable: true });
			a.dispatchEvent(e);
			return e.defaultPrevented;
		};
		const links = [...target.querySelectorAll('a')];
		expect(click(links[0])).toBe(true);
		expect(click(links[1])).toBe(true);
		expect(click(links[2])).toBe(true);
		expect(click(links[3].querySelector('em')!)).toBe(true);
		expect(s.opener.mock.calls.map(([u]) => u)).toEqual(['https://example.com/x']);
		expect(click(links[0], 'contextmenu')).toBe(true);
		expect(click(links[0], 'auxclick')).toBe(true);
		expect(s.opener).toHaveBeenCalledTimes(1);
	});

	describe('copy buttons', () => {
		const icon = (b: Element) => b.querySelector('svg')?.getAttribute('data-icon');

		it('gives each code block one, which copies its text without the last newline', async () => {
			const s = setup({ '/tmp/repo/a.md': '<pre><code>one\ntwo\n</code></pre><p>x</p><pre>three</pre>' });
			show(s, '/tmp/repo/a.md');
			await settle();
			const buttons = [...target.querySelectorAll<HTMLElement>('.body .code > button.copy')];
			expect(buttons).toHaveLength(2);
			expect(target.querySelectorAll('.body .code > pre')).toHaveLength(2);
			expect(icon(buttons[0])).toBe('square-2-stack');
			buttons[0].click();
			await settle();
			expect(s.write).toHaveBeenCalledExactlyOnceWith('one\ntwo');
			expect(icon(buttons[0])).toBe('check');
			expect(icon(buttons[1])).toBe('square-2-stack');
		});

		it('reports a copy that failed and does not say it copied', async () => {
			const s = setup({ '/tmp/repo/a.md': '<pre>x</pre>' });
			s.write.mockRejectedValueOnce(new Error('denied'));
			const props = show(s, '/tmp/repo/a.md');
			await settle();
			const button = target.querySelector<HTMLElement>('button.copy')!;
			button.click();
			await settle();
			expect(props.report).toHaveBeenCalledWith('copying failed: denied');
			expect(icon(button)).toBe('square-2-stack');
		});

		it('does not follow a link around the block', async () => {
			const s = setup({ '/tmp/repo/a.md': '<a href="https://example.com/x"><pre>x</pre></a>' });
			show(s, '/tmp/repo/a.md');
			await settle();
			target.querySelector<HTMLElement>('button.copy')!.click();
			await settle();
			expect(s.write).toHaveBeenCalledTimes(1);
			expect(s.opener).not.toHaveBeenCalled();
		});
	});

	describe('images', () => {
		const img = () => target.querySelector<HTMLImageElement>('img');
		const texts = () => [...target.querySelectorAll('p span')].map((e) => [e.textContent, e.getAttribute('title')]);
		const loaded = (i: HTMLImageElement) => {
			Object.defineProperties(i, { naturalWidth: { value: 1200, configurable: true }, naturalHeight: { value: 800, configurable: true } });
			i.dispatchEvent(new Event('load'));
		};

		it('loads one the app lets through, asked by the file, what it names and the repo', async () => {
			const s = setup({ '/tmp/repo/README.md': '<p><img data-src="docs/a%20b.png?raw=1" alt="A shot"></p>' });
			show(s, '/tmp/repo/README.md', '/tmp/repo');
			await settle();
			expect(s.image).toHaveBeenCalledWith('/tmp/repo/README.md', 'docs/a b.png', '/tmp/repo');
			expect(img()?.getAttribute('src')).toBe('asset://localhost/docs/a b.png');
		});

		it('shows an image as its alt text until it has loaded', async () => {
			const s = setup({ '/tmp/repo/README.md': '<p><img data-src="docs/a.png" alt="A shot" loading="lazy"></p>' });
			show(s, '/tmp/repo/README.md', '/tmp/repo');
			await settle();
			expect([img()!.hidden, texts()]).toEqual([true, [['A shot', null]]]);
			// A hidden image a file marked lazy would never load.
			expect(img()!.getAttribute('loading')).toBe('eager');
			loaded(img()!);
			expect([img()!.hidden, texts()]).toEqual([false, []]);
		});

		it('shows a web image as its alt text, and asks the app nothing', async () => {
			const s = setup({ '/tmp/repo/README.md': '<p><a href="https://example.com"><img data-src="https://example.com/badge.svg" alt="build"></a></p>' });
			show(s, '/tmp/repo/README.md', '/tmp/repo');
			await settle();
			expect(img()).toBeNull();
			expect(s.image).not.toHaveBeenCalled();
			expect(target.querySelector('a span')).not.toBeNull();
			expect(texts()).toEqual([['build', 'https://example.com/badge.svg is not shown: the preview shows only images from files']]);
		});

		it('shows one the app refuses, or that does not load, as its alt text with the reason', async () => {
			const s = setup({ '/tmp/repo/README.md': '<p><img data-src="../out.png" alt="Out"><img data-src="docs/broken.png" alt="Broken"></p>' });
			show(s, '/tmp/repo/README.md', '/tmp/repo');
			await settle();
			img()!.dispatchEvent(new Event('error'));
			expect(img()).toBeNull();
			expect(texts()).toEqual([
				['Out', "../out.png is not shown: outside the file's repo or folder"],
				['Broken', 'docs/broken.png is not shown: it could not be loaded'],
			]);
		});

		it('gives an image its room when the file is shown again, until it has loaded', async () => {
			const text = '<p><img data-src="docs/a.png" alt="A shot"></p>';
			const s = setup({ '/tmp/repo/sized.md': text });
			show(s, '/tmp/repo/sized.md');
			await settle();
			loaded(img()!);
			unmount(shown!);
			target.remove();
			show(s, '/tmp/repo/sized.md');
			await settle();
			expect([img()!.hidden, img()!.getAttribute('width'), img()!.style.aspectRatio, texts()]).toEqual([false, '1200', '1200 / 800', []]);
			loaded(img()!);
			expect([img()!.hasAttribute('width'), img()!.style.aspectRatio]).toEqual([false, '']);

			// One that no longer loads is text again, on this show and the next.
			unmount(shown!);
			target.remove();
			show(s, '/tmp/repo/sized.md');
			await settle();
			img()!.dispatchEvent(new Event('error'));
			expect(texts()).toEqual([['A shot', 'docs/a.png is not shown: it could not be loaded']]);
			unmount(shown!);
			target.remove();
			show(s, '/tmp/repo/sized.md');
			await settle();
			expect([img()!.hidden, texts()]).toEqual([true, [['A shot', null]]]);
		});
	});

	describe('the place in the file', () => {
		const view = () => target.querySelector<HTMLElement>('.markdown')!;

		it('goes back to where the file was left when shown again, once its text is in', async () => {
			const s = setup({ '/tmp/repo/place.md': '<p>text</p>' });
			show(s, '/tmp/repo/place.md');
			await settle();
			view().scrollTop = 700;
			view().dispatchEvent(new Event('scroll'));
			unmount(shown!);
			target.remove();
			show(s, '/tmp/repo/place.md');
			expect(view().scrollTop).toBe(0);
			await settle();
			expect(view().scrollTop).toBe(700);
		});

		it('keeps a place per file', async () => {
			const s = setup({ '/tmp/repo/one.md': '<p>1</p>', '/tmp/repo/two.md': '<p>2</p>' });
			const props = show(s, '/tmp/repo/one.md');
			await settle();
			view().scrollTop = 300;
			view().dispatchEvent(new Event('scroll'));
			props.path = '/tmp/repo/two.md';
			flushSync();
			await settle();
			expect(view().scrollTop).toBe(0);
		});

		it('does not take the scroll of an empty view for the place', async () => {
			const s = setup();
			show(s, '/tmp/repo/waiting.md');
			flushSync();
			view().scrollTop = 40;
			view().dispatchEvent(new Event('scroll'));
			s.read('/tmp/repo/waiting.md').resolve({ text: '<p>x</p>', stamp });
			await settle();
			expect(view().scrollTop).toBe(0);
		});
	});
});
