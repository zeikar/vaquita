<script module lang="ts">
	// How far each file's preview was scrolled, for the app run: the view
	// mounts on every show.
	const scrolls = new Map<string, number>();
	// The size of each image shown, by its file and src, for the app run: on
	// the next show the image has its room before it loads, or everything
	// under it would move down from the place the file was left at.
	const sizes = new Map<string, { width: number; height: number }>();
</script>

<script lang="ts">
	import { mount, onDestroy, unmount, untrack } from 'svelte';
	import CopyButton from './CopyButton.svelte';
	import { documents as shared, type Documents } from './documents';
	import { previewImage, readText } from './files';
	import { openExternal, type Opener } from './links';
	import { imageFile, renderMarkdown } from './markdown';
	import { fileName } from './tabs';

	let {
		path,
		repo,
		report,
		documents = shared,
		read = readText,
		image = previewImage,
		opener,
		write,
	}: {
		path: string;
		// The repo of the tab's group, which bounds the images shown (files.ts).
		repo?: string;
		report: (message: string) => void;
		documents?: Pick<Documents, 'textOf' | 'refresh'>;
		read?: typeof readText;
		image?: typeof previewImage;
		opener?: Opener;
		write?: (text: string) => Promise<void>;
	} = $props();

	let root: HTMLElement;
	let html = $state<string>();
	let error = $state<string>();

	const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

	export function focus(): void {
		root.focus();
	}

	// Each request takes a number; an answer is applied only while its number
	// is the latest, so neither a path shown since nor an unmounted view gets it.
	let request = 0;
	onDestroy(() => void request++);

	$effect(() => {
		const asked = path;
		const n = ++request;
		const still = () => n === request;
		html = undefined;
		error = undefined;
		textOf(asked, still)
			.then(renderMarkdown)
			.then(
				(h) => {
					if (still()) html = h;
				},
				(e) => {
					if (!still()) return;
					error = message(e);
					report(`${fileName(asked)} could not be shown: ${message(e)}`);
				},
			);
	});

	// Once the text is in the page. The buttons are added after the sanitizer,
	// which lets no file bring a button of its own, and beside each block, as
	// one inside it would scroll away with a long line.
	$effect(() => {
		if (html === undefined) return;
		const buttons = [...root.querySelectorAll('pre')].map((pre) => {
			const block = document.createElement('div');
			block.className = 'code';
			pre.replaceWith(block);
			block.append(pre);
			return mount(CopyButton, {
				target: block,
				props: {
					// The renderer ends every block with a newline nobody wrote.
					text: pre.textContent!.replace(/\n$/, ''),
					failed: (e: unknown) => report(`copying failed: ${message(e)}`),
					write,
				},
			});
		});
		const file = untrack(() => path);
		const group = untrack(() => repo);
		let shown = true;
		for (const img of root.querySelectorAll('img')) showImage(img, file, group, () => shown);
		root.scrollTop = scrolls.get(file) ?? 0;
		return () => {
			shown = false;
			buttons.forEach((b) => void unmount(b));
		};
	});

	// The sanitizer left what an img names in data-src (markdown.ts), so the
	// page has asked for nothing yet. A file inside the repo is loaded once
	// the app let it through; anything else, a web image included, shows as
	// its alt text, with the reason on hover. An image is that text until it
	// has loaded too, unless its size is known: what does not load then never
	// moves the text under it, on any show.
	function showImage(img: HTMLImageElement, file: string, group: string | undefined, still: () => boolean): void {
		const src = img.dataset.src ?? '';
		const named = imageFile(src);
		const key = `${file}\n${named}`;
		const size = named === undefined ? undefined : sizes.get(key);
		const text = document.createElement('span');
		text.textContent = img.alt;
		const unshown = (why: string) => {
			sizes.delete(key);
			text.title = `${src || 'The image'} is not shown: ${why}`;
			img.replaceWith(text);
		};
		if (named === undefined) return unshown('the preview shows only images from files');
		const sized = size !== undefined && !img.hasAttribute('width');
		if (size === undefined) {
			img.hidden = true;
			img.before(text);
		} else {
			if (sized) img.width = size.width;
			// Not `auto`, with which WebKit gives an image still loading another height.
			img.style.aspectRatio = `${size.width} / ${size.height}`;
		}
		img.addEventListener('load', () => {
			sizes.set(key, { width: img.naturalWidth, height: img.naturalHeight });
			// The file may hold another picture by now.
			if (sized) img.removeAttribute('width');
			img.style.aspectRatio = '';
			img.hidden = false;
			text.remove();
		});
		img.addEventListener('error', () => unshown('it could not be loaded'));
		image(file, named, group).then(
			(url) => {
				if (still()) img.src = url;
			},
			(e) => {
				if (still()) unshown(message(e));
			},
		);
	}

	// Not while the text is away: the empty view has scrolled to the top by itself.
	function scrolled(): void {
		if (html !== undefined) scrolls.set(path, root.scrollTop);
	}

	// The document's text when the file has one, so edits not saved yet show;
	// a clean one first takes what an agent wrote on disk since. Without one,
	// the file is read: the view mounts on every show, so each show reads it.
	async function textOf(asked: string, still: () => boolean): Promise<string> {
		if (documents.textOf(asked) !== undefined) {
			await documents.refresh(asked, still).catch((e) => {
				if (still()) report(`${fileName(asked)} could not be read again: ${message(e)}`);
			});
			const text = documents.textOf(asked);
			if (text !== undefined) return text;
		}
		return (await read(asked)).text;
	}

	const anchor = (e: Event) => (e.target instanceof Element ? e.target.closest('a, area') : null);

	// The preview lives in the app's own page, which a followed link would
	// replace: no link navigates, and web and mail links open in the browser.
	// The attribute as written, as a.href resolves a relative link against the
	// app's own URL, which is http under the dev server.
	function click(e: MouseEvent): void {
		const a = anchor(e);
		if (!a) return;
		e.preventDefault();
		const href = a.getAttribute('href');
		if (href) openExternal(href, (err) => report(`opening ${href} failed: ${message(err)}`), opener);
	}

	// A middle click would open the link in a new web view, and WebKit's own
	// menu on a link offers Open Link, which navigates this one.
	function block(e: MouseEvent): void {
		if (anchor(e)) e.preventDefault();
	}
</script>

<!-- Clicks are delegated for the links of the rendered HTML, which are
     reachable by keyboard themselves and fire click on Enter. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="markdown" tabindex="-1" bind:this={root} onclick={click} onauxclick={block} oncontextmenu={block} onscroll={scrolled}>
	{#if error !== undefined}
		<p class="error">{error}</p>
	{:else if html !== undefined}
		<!-- Sanitized by renderMarkdown. -->
		<div class="body">{@html html}</div>
	{/if}
</div>

<style>
	.markdown {
		place-self: stretch;
		min-height: 0;
		overflow: auto;
		outline: none;
		font-size: 14px;
		line-height: 1.6;
		color: #d4d4d4;
	}
	.error {
		margin: 24px auto;
		max-width: 80%;
		color: #ccc;
		overflow-wrap: anywhere;
		text-align: center;
	}
	.body {
		max-width: 860px;
		margin: 0 auto;
		padding: 16px 32px 48px;
		overflow-wrap: break-word;
	}
	.body :global(:is(h1, h2, h3, h4, h5, h6)) {
		margin: 1.4em 0 0.6em;
		color: #e5e5e5;
		font-weight: 600;
		line-height: 1.25;
	}
	.body :global(:is(h1, h2)) {
		padding-bottom: 0.3em;
		border-bottom: 1px solid #3c3c3c;
	}
	.body :global(h1) {
		font-size: 1.9em;
	}
	.body :global(h2) {
		font-size: 1.5em;
	}
	.body :global(h3) {
		font-size: 1.25em;
	}
	.body :global(h6) {
		color: #999;
	}
	.body :global(:is(p, ul, ol, pre, table, blockquote)) {
		margin: 0 0 1em;
	}
	.body :global(:is(ul, ol)) {
		padding-left: 2em;
	}
	.body :global(li + li) {
		margin-top: 0.25em;
	}
	.body :global(a) {
		color: var(--neon);
		text-decoration: none;
	}
	.body :global(a:hover) {
		text-decoration: underline;
	}
	.body :global(code) {
		padding: 0.15em 0.35em;
		border-radius: 4px;
		background: #2d2d2d;
		font-family: 'SF Mono', Menlo, monospace;
		font-size: 0.88em;
	}
	.body :global(pre) {
		padding: 12px 16px;
		border-radius: 6px;
		background: #252526;
		overflow-x: auto;
		line-height: 1.45;
	}
	.body :global(pre code) {
		padding: 0;
		background: none;
		font-size: 0.86em;
	}
	/* Files have no classes (markdown.ts), so this is only ever the app's. */
	.body :global(.code) {
		position: relative;
	}
	.body :global(img) {
		max-width: 100%;
		height: auto;
	}
	.body :global(blockquote) {
		padding: 0 1em;
		border-left: 3px solid #4a4a4a;
		color: #a0a0a0;
	}
	.body :global(table) {
		display: block;
		width: max-content;
		max-width: 100%;
		overflow-x: auto;
		border-collapse: collapse;
	}
	.body :global(:is(th, td)) {
		padding: 6px 12px;
		border: 1px solid #3c3c3c;
	}
	.body :global(th) {
		background: #252526;
		font-weight: 600;
	}
	.body :global(tr:nth-child(2n) td) {
		background: #232323;
	}
	.body :global(hr) {
		height: 1px;
		margin: 1.5em 0;
		border: none;
		background: #3c3c3c;
	}
	.body > :global(:first-child) {
		margin-top: 0;
	}
</style>
