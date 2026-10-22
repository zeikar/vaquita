<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import type { SessionRow } from './manager';
	import type { TermView } from './term-view';

	let { sessions, selected }: { sessions: SessionRow<TermView>[]; selected?: number } = $props();

	const view = $derived(sessions.find((r) => r.info.sid === selected)?.view);

	// Views selected at least once. Only they get an element, so a terminal is
	// never opened before its session is first shown. Views rather than sids:
	// a reconnect to a restarted daemon gives a sid a new, unseen terminal.
	const shown = new SvelteSet<TermView>();
	const panes = $derived(sessions.flatMap((r) => (r.view && shown.has(r.view) ? [r.view] : [])));

	$effect(() => {
		if (view) shown.add(view);
	});
	// Disposed views go, along with their sessions.
	$effect(() => {
		for (const v of shown) if (!sessions.some((r) => r.view === v)) shown.delete(v);
	});

	let current: TermView | undefined;
	$effect(() => {
		if (view === current) return;
		current?.hide();
		current = view;
		view?.show();
	});

	function attach(node: HTMLElement, v: TermView) {
		v.attach(node);
	}
</script>

<div class="pane">
	{#each panes as v (v)}
		<div class="term" style:display={v === view ? null : 'none'} use:attach={v}></div>
	{/each}
</div>

<style>
	.pane {
		position: relative;
		overflow: hidden;
		background: #1e1e1e;
	}
	.term {
		position: absolute;
		inset: 4px;
	}
</style>
