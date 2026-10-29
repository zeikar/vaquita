<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { documents as shared, type Documents } from './documents';
	import { layoutHeld } from './layout-hold';
	import { EDITOR_OPTIONS, loadMonaco, type Monaco } from './monaco';
	import { fileName } from './tabs';

	type Editor = import('./monaco-setup').editor.IStandaloneCodeEditor;

	let {
		path,
		shown,
		report,
		readOnly = false,
		loader = loadMonaco,
		documents = shared,
	}: {
		path: string;
		// Raised each time the path is shown, the same one again included: its
		// document may have been dropped, or its file changed, while hidden.
		shown: number;
		report: (message: string) => void;
		readOnly?: boolean;
		loader?: () => Promise<Monaco>;
		documents?: Pick<Documents, 'openDocument' | 'refresh'>;
	} = $props();

	let host: HTMLElement;
	let editor = $state.raw<Editor>();
	let error = $state<string>();
	// The path whose model the editor holds.
	let loaded: string | undefined;

	const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

	// False while there is nothing to type into yet, so the caller can focus
	// something else.
	export function focus(): boolean {
		if (!editor || loaded !== path || editor.getModel() === null) return false;
		editor.focus();
		return true;
	}

	// Lays the editor out to its host's size, as after a panel edge's drag.
	export function relayout(): void {
		editor?.layout();
	}

	$effect(() => editor?.updateOptions({ readOnly }));

	onMount(() => {
		let mounted = true;
		let observer: ResizeObserver | undefined;
		loader().then(
			(monaco) => {
				if (!mounted) return;
				editor = monaco.editor.create(host, {
					// No model of its own: every model is a document's.
					model: null,
					...EDITOR_OPTIONS,
				});
				// Not automaticLayout, which relays out at every step of a panel
				// edge's drag and flashes the scrollbars each time: the layout is
				// held then, as the terminal's fit is, and the host clips the
				// editor at its old size until the drag ends.
				observer = new ResizeObserver(() => {
					if (!layoutHeld()) editor?.layout();
				});
				observer.observe(host);
			},
			(e) => {
				if (!mounted) return;
				error = message(e);
				report(`the editor could not load: ${message(e)}`);
			},
		);
		// The models stay: they are the documents', which outlive the editor.
		return () => {
			mounted = false;
			observer?.disconnect();
			editor?.dispose();
		};
	});

	// Each request takes a number; an answer is applied only while its number
	// is the latest, so neither a path shown since nor an unmounted editor gets it.
	let request = 0;
	onDestroy(() => void request++);

	$effect(() => {
		const asked = path;
		void shown;
		const ed = editor;
		if (!ed) return;
		const n = ++request;
		// Not the last file's text under this one's tab while it is read.
		if (asked !== loaded) {
			ed.setModel(null);
			loaded = undefined;
		}
		error = undefined;
		// Before the open, so that only a document that was already there is
		// read again; a new one has just been read.
		documents.refresh(asked, () => n === request).catch((e) => {
			if (n === request) report(`${fileName(asked)} could not be read again: ${message(e)}`);
		});
		documents.openDocument(asked).then(
			(doc) => {
				if (n !== request) return;
				// Setting the model it has would reset the view.
				if (ed.getModel() !== doc.model) ed.setModel(doc.model);
				loaded = asked;
				// The pane took the focus while Monaco loaded or the file was read,
				// so that typing never reached the terminal; it belongs here now.
				const at = document.activeElement;
				if (at && at !== document.body && at.contains(host)) ed.focus();
			},
			(e) => {
				if (n !== request) return;
				error = message(e);
				report(`${fileName(asked)} could not be read: ${message(e)}`);
			},
		);
	});
</script>

<div class="text">
	<div class="editor" bind:this={host} hidden={error !== undefined}></div>
	{#if error !== undefined}
		<p class="error">{error}</p>
	{/if}
</div>

<style>
	.text {
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
