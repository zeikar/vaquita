<script module lang="ts">
	import { SvelteSet } from 'svelte/reactivity';

	// The markdown files switched to Source, for the app run; the rest preview.
	const sources = new SvelteSet<string>();
</script>

<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { documents } from './documents';
	import { fileUrl, viewPath, type FileKind } from './files';
	import Icon from './Icon.svelte';
	import MarkdownView from './MarkdownView.svelte';
	import { barPath } from './paths';
	import { fileName } from './tabs';
	import TextEditor from './TextEditor.svelte';

	let {
		path,
		onclose,
		report,
		readOnly = false,
		repo,
		home,
	}: {
		path: string;
		// The repo of the tab's group, which the path bar goes from; none for Other.
		repo?: string;
		home?: string;
		onclose: () => void;
		report: (message: string) => void;
		readOnly?: boolean;
	} = $props();

	// A view keeps the path it was judged for: the path prop changes before the
	// effect below sets loading, and a view still mounted then must not take it.
	type Shown =
		| { state: 'loading' }
		| { state: 'error'; message: string }
		| { state: 'view'; path: string; kind: FileKind; src?: string; note?: string };

	let shown = $state<Shown>({ state: 'loading' });
	let root: HTMLElement;
	let editor = $state<ReturnType<typeof TextEditor>>();
	let preview = $state<ReturnType<typeof MarkdownView>>();
	// The last path shown in the editor. The editor stays mounted, hidden, while
	// other tabs show, so that one Monaco editor serves every text tab of the
	// pane, a markdown file's source included.
	let textPath = $state<string>();
	let textShown = $state(0);
	const markdown = $derived(shown.state === 'view' && shown.kind === 'markdown' ? shown.path : undefined);
	const source = $derived(markdown !== undefined && sources.has(markdown));
	const inEditor = (s: Shown) => s.state === 'view' && (s.kind === 'text' || (s.kind === 'markdown' && sources.has(s.path)));
	const showsEditor = $derived(inEditor(shown));
	const where = $derived(barPath(path, repo, home));

	function showEditor(p: string): void {
		textPath = p;
		textShown++;
	}

	// Takes the focus from the terminal underneath, so that typing never
	// reaches it: the editor's once it has the file, else the preview's or
	// the pane's.
	export function focus(): void {
		if (showsEditor && editor?.focus()) return;
		if (markdown !== undefined && !source && preview) preview.focus();
		else root.focus();
	}

	// After a panel edge's drag, which the editor sat out (layout-hold.ts).
	export function relayout(): void {
		editor?.relayout();
	}

	// Saving needs nothing here: it goes by path, and the document outlives the
	// editor, so a file edited in Source saves from Preview too.
	async function setSource(on: boolean): Promise<void> {
		if (markdown === undefined || on === source) return;
		if (on) {
			sources.add(markdown);
			showEditor(markdown);
		} else {
			sources.delete(markdown);
		}
		await tick();
		focus();
	}

	// Each request takes a number; an answer is applied only while its number
	// is the latest, so neither a path shown since nor an unmounted pane gets it.
	let request = 0;
	onDestroy(() => void request++);

	$effect(() => {
		const asked = path;
		const n = ++request;
		shown = { state: 'loading' };
		void load(asked).then(
			(s) => {
				if (n !== request) return;
				shown = s;
				if (inEditor(s)) showEditor(asked);
			},
			(e) => {
				if (n === request) shown = { state: 'error', message: e instanceof Error ? e.message : String(e) };
			},
		);
	});

	// view_path judges the file again, as a restored tab's may have changed;
	// text is read by its editor or preview, the rest is loaded from the URL
	// it allowed.
	// A document with unsaved edits stays in the editor when the file no longer
	// qualifies, as an agent may have deleted, renamed or grown it: the error
	// is shown beside the text, which is all that is left of the edits.
	async function load(asked: string): Promise<Shown> {
		let viewable;
		try {
			viewable = await viewPath(asked);
		} catch (e) {
			if (!documents.isDirty(asked)) throw e;
			return { state: 'view', path: asked, kind: 'text', note: `The file cannot be shown from disk: ${e instanceof Error ? e.message : String(e)}` };
		}
		const { path: canonical, kind } = viewable;
		if (kind === 'text' || kind === 'markdown') return { state: 'view', path: asked, kind };
		return { state: 'view', path: asked, kind, src: await fileUrl(canonical) };
	}

	const failed = () => report(`${fileName(path)} could not be shown`);
</script>

<div class="file" tabindex="-1" bind:this={root}>
	<div class="bar" title={path}>
		<span class="where"><span class="dir">{where.dir}</span><span class="name">{where.name}</span></span>
		{#if markdown !== undefined}
			<div class="modes" role="group" aria-label="Markdown view">
				<button title="Preview" aria-label="Preview" aria-pressed={!source} onclick={() => void setSource(false)}><Icon name="eye" /></button>
				<button title="Source" aria-label="Source" aria-pressed={source} onclick={() => void setSource(true)}><Icon name="code-bracket-micro" /></button>
			</div>
		{/if}
	</div>
	{#if shown.state === 'view' && shown.note}
		<p class="note">{shown.note}</p>
	{/if}
	{#if textPath !== undefined}
		<div class="text" hidden={!showsEditor}>
			<TextEditor bind:this={editor} path={textPath} shown={textShown} {report} {readOnly} />
		</div>
	{/if}
	{#if markdown !== undefined && !source}
		<MarkdownView bind:this={preview} path={markdown} {report} />
	{/if}
	{#if shown.state === 'error'}
		<div class="error">
			<p>{shown.message}</p>
			<button onclick={onclose}>Close</button>
		</div>
	{:else if shown.state === 'view' && shown.src !== undefined}
		{#if shown.kind === 'image'}
			<img src={shown.src} alt={fileName(path)} onerror={failed} />
		{:else if shown.kind === 'audio'}
			<audio src={shown.src} controls onerror={failed}></audio>
		{:else if shown.kind === 'video'}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video src={shown.src} controls onerror={failed}></video>
		{/if}
	{/if}
</div>

<style>
	/* The path bar's row, then the note's, empty without one, above what the
	   file shows rather than over it, where Monaco's find widget opens. */
	.file {
		display: grid;
		grid-template: auto auto minmax(0, 1fr) / minmax(0, 1fr);
		place-items: center;
		min-height: 0;
		overflow: auto;
		background: #1e1e1e;
		outline: none;
	}
	.file > :global(*) {
		grid-area: 3 / 1;
	}
	.file > .bar {
		grid-area: 1 / 1;
		place-self: stretch;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 22px;
		padding: 0 4px 0 12px;
		border-bottom: 1px solid #333;
		background: #1e1e1e;
		color: #888;
		font-size: 12px;
		white-space: nowrap;
		-webkit-user-select: none;
		user-select: none;
	}
	/* The folders give way first: the name shrinks only once it alone is wider
	   than the bar. */
	.where {
		display: flex;
		min-width: 0;
	}
	.dir {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.name {
		flex: none;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		color: #ccc;
	}
	.modes {
		display: flex;
		flex: none;
		margin-left: auto;
		border: 1px solid #3c3c3c;
		border-radius: 4px;
		overflow: hidden;
	}
	.modes button {
		display: grid;
		place-items: center;
		width: 20px;
		height: 18px;
		padding: 0;
		border: none;
		background: transparent;
		color: #999;
		cursor: pointer;
	}
	.modes button + button {
		border-left: 1px solid #3c3c3c;
	}
	.modes button:hover {
		background: #2a2d2e;
		color: #d4d4d4;
	}
	.modes button[aria-pressed='true'] {
		background: #3a3d41;
		color: #e5e5e5;
	}
	.modes button:focus-visible {
		outline: 1px solid var(--neon);
		outline-offset: -1px;
	}
	.modes :global(svg) {
		width: 12px;
		height: 12px;
	}
	.file > .note {
		grid-area: 2 / 1;
		justify-self: start;
		margin: 6px 12px;
		color: #d7ba7d;
		font-size: 12px;
	}
	.text {
		place-self: stretch;
		position: relative;
	}
	img,
	video {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}
	audio {
		width: min(480px, 90%);
	}
	.error {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		max-width: 80%;
		color: #ccc;
		overflow-wrap: anywhere;
		text-align: center;
	}
	.error p {
		margin: 0;
	}
	.error button {
		height: 24px;
		padding: 0 12px;
		border: 1px solid #3c3c3c;
		border-radius: 4px;
		background: #3a3d41;
		color: #d4d4d4;
		font: inherit;
		cursor: pointer;
	}
	.error button:hover {
		background: #45494e;
	}
	.error button:focus-visible {
		outline: 1px solid var(--neon);
		outline-offset: 1px;
	}
</style>
