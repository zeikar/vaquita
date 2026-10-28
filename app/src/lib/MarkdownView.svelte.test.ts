// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Stamp } from './files';
import MarkdownView from './MarkdownView.svelte';

// The sanitizing is markdown.test.ts's, under a DOM DOMPurify can walk; here
// the text is shown as it comes, so the view's own rules can be seen.
vi.mock('./markdown', () => ({ renderMarkdown: async (text: string) => text }));

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
	return { read, readText: vi.fn((p: string) => read(p).promise), documents, opener };
}

type Setup = ReturnType<typeof setup>;

function show(s: Setup, path: string) {
	const props = $state({ path, report: vi.fn(), documents: s.documents, read: s.readText, opener: s.opener });
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
});
