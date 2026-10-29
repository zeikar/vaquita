<script lang="ts">
	import { onMount } from 'svelte';
	import { diffSides } from './files';
	import { layoutHeld } from './layout-hold';
	import { EDITOR_OPTIONS, languageFor, loadMonaco, type Monaco } from './monaco';
	import { fileName } from './tabs';

	type DiffEditor = import('./monaco-setup').editor.IStandaloneDiffEditor;

	let {
		repo,
		path,
		sideBySide,
		report,
		loader = loadMonaco,
		read = diffSides,
	}: {
		// The repo of the tab's group, which git reads HEAD from; none for Other.
		repo?: string;
		// The file's absolute path.
		path: string;
		sideBySide: boolean;
		report: (message: string) => void;
		loader?: () => Promise<Monaco>;
		read?: typeof diffSides;
	} = $props();

	let host: HTMLElement;
	let editor = $state.raw<DiffEditor>();
	// Set once both models are in: an editor made before a later step threw
	// is kept only for the cleanup to dispose.
	let ready = false;
	let error = $state<string>();

	const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

	// What git or the file itself rules out, shown in the pane on every show
	// of such a tab and not worth a report each time (changes.rs, files.rs).
	const EXPECTED = new Set(['binary', 'a symlink', 'a submodule', 'larger than 2 MiB', 'not UTF-8 text', 'outside the repo']);

	// False until both sides are in, so the caller can focus something else.
	export function focus(): boolean {
		if (!editor || !ready) return false;
		editor.getModifiedEditor().focus();
		return true;
	}

	// Lays the editor out to its host's size, as after a panel edge's drag.
	export function relayout(): void {
		editor?.layout();
	}

	$effect(() => editor?.updateOptions({ renderSideBySide: sideBySide }));

	// Read once per mount: the pane mounts the view on each show, so a diff
	// tab shown again reads again, as an unedited file tab does.
	onMount(() => {
		let mounted = true;
		let observer: ResizeObserver | undefined;
		const models: { dispose(): void }[] = [];
		const asked = repo;
		if (asked === undefined) {
			error = 'cannot show diff: the file is in no registered repo';
		} else {
			Promise.all([loader(), read(asked, path)])
				.then(([monaco, sides]) => {
					// Nothing of Monaco is made for a view already gone, as its
					// cleanup has run and would never dispose it.
					if (!mounted) return;
					// Kept as each is made, so that the cleanup disposes what a
					// later step's throw left.
					const ed = (editor = monaco.editor.createDiffEditor(host, {
						...EDITOR_OPTIONS,
						readOnly: true,
						renderSideBySide: sideBySide,
						useInlineViewWhenSpaceIsLimited: true,
						// A long file reads as its hunks.
						hideUnchangedRegions: { enabled: true },
					}));
					// No URI of their own, so they never clash with a document's
					// file: model; a missing side (an untracked or deleted file, a
					// new submodule) is empty.
					const language = languageFor(monaco, path);
					const original = monaco.editor.createModel(sides.head ?? '', language);
					models.push(original);
					const modified = monaco.editor.createModel(sides.work ?? '', language);
					models.push(modified);
					ed.setModel({ original, modified });
					ready = true;
					// Not automaticLayout: a panel edge's drag holds the layout, as
					// TextEditor's does.
					observer = new ResizeObserver(() => {
						if (!layoutHeld()) ed.layout();
					});
					observer.observe(host);
					// The pane took the focus while this loaded, so that typing never
					// reached the terminal; it belongs here now.
					const at = document.activeElement;
					if (at && at !== document.body && at.contains(host)) ed.getModifiedEditor().focus();
				})
				.catch((e) => {
					if (!mounted) return;
					const why = message(e);
					error = `cannot show diff: ${why}`;
					if (!EXPECTED.has(why)) report(`${fileName(path)}'s diff could not be shown: ${why}`);
				});
		}
		// The models are the view's own, so they go with it, after the editor
		// that shows them.
		return () => {
			mounted = false;
			observer?.disconnect();
			editor?.dispose();
			for (const m of models) m.dispose();
		};
	});
</script>

<div class="diff-view">
	<div class="editor" bind:this={host} hidden={error !== undefined}></div>
	{#if error !== undefined}
		<p class="error">{error}</p>
	{/if}
</div>

<style>
	.diff-view {
		position: absolute;
		inset: 0;
		display: grid;
		grid-template: minmax(0, 1fr) / minmax(0, 1fr);
		place-items: center;
	}
	.editor {
		place-self: stretch;
		min-height: 0;
		overflow: hidden;
	}
	.error {
		max-width: 80%;
		margin: 0;
		color: #ccc;
		overflow-wrap: anywhere;
		text-align: center;
	}
</style>
