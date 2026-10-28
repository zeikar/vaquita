<script lang="ts">
	import { onDestroy } from 'svelte';
	import { fileUrl, viewPath, type FileKind } from './files';
	import { fileName } from './tabs';

	let {
		path,
		onclose,
		report,
	}: {
		path: string;
		onclose: () => void;
		report: (message: string) => void;
	} = $props();

	type Shown = { state: 'loading' } | { state: 'error'; message: string } | { state: 'view'; kind: FileKind; src?: string };

	let shown = $state<Shown>({ state: 'loading' });
	let root: HTMLElement;

	// Takes the focus from the terminal underneath, so that typing never reaches it.
	export function focus(): void {
		root.focus();
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
				if (n === request) shown = s;
			},
			(e) => {
				if (n === request) shown = { state: 'error', message: e instanceof Error ? e.message : String(e) };
			},
		);
	});

	// view_path judges the file again, as a restored tab's may have changed;
	// text is read by its editor, the rest is loaded from the URL it allowed.
	async function load(asked: string): Promise<Shown> {
		const { path: canonical, kind } = await viewPath(asked);
		if (kind === 'text' || kind === 'markdown') return { state: 'view', kind };
		return { state: 'view', kind, src: await fileUrl(canonical) };
	}

	const failed = () => report(`${fileName(path)} could not be shown`);
</script>

<div class="file" tabindex="-1" bind:this={root}>
	{#if shown.state === 'error'}
		<div class="error">
			<p>{shown.message}</p>
			<button onclick={onclose}>Close</button>
		</div>
	{:else if shown.state === 'view' && shown.src !== undefined}
		{#if shown.kind === 'image'}
			<img src={shown.src} alt={fileName(path)} onerror={failed} />
		{:else if shown.kind === 'pdf'}
			<!-- An empty sandbox: whatever the frame shows runs no script and
			     cannot navigate the app. Only a file judged a PDF gets here. -->
			<iframe src={shown.src} sandbox="" title={fileName(path)}></iframe>
		{:else if shown.kind === 'audio'}
			<audio src={shown.src} controls onerror={failed}></audio>
		{:else if shown.kind === 'video'}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video src={shown.src} controls onerror={failed}></video>
		{/if}
	{/if}
</div>

<style>
	.file {
		display: grid;
		grid-template: minmax(0, 1fr) / minmax(0, 1fr);
		place-items: center;
		min-height: 0;
		overflow: auto;
		background: #1e1e1e;
		outline: none;
	}
	img,
	video {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}
	iframe {
		place-self: stretch;
		width: 100%;
		height: 100%;
		border: none;
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
