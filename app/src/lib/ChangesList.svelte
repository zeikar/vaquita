<script module lang="ts">
	import type { Change } from './files';

	// Shared by every mount, as the watch in Rust is one; from the clock, as
	// FileTree's is, since Rust keeps the last generation across page loads.
	let generation = Date.now();

	const tints: Record<Change['status'], string> = {
		M: '#e2c08d',
		A: '#81b88b',
		U: '#81b88b',
		D: '#c74e39',
		R: '#73c991',
		C: '#e4676b',
	};

	// Git's path cut into its folders and its name, as a path bar shows one; an
	// untracked nested repo keeps its trailing slash in the name.
	function split(path: string): { dir: string; name: string } {
		const cut = path.lastIndexOf('/', path.length - 2);
		return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
	}
</script>

<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { changeLists } from './changes.svelte';
	import { onRepoChanged, watchRepo } from './files';

	let {
		root,
		highlight,
		onopen,
		report,
	}: {
		root: string;
		// The shown tab's file.
		highlight?: string;
		// pin is set on a double-click, which keeps the tab; a click opens a preview.
		onopen: (path: string, pin?: boolean) => void;
		report: (message: string) => void;
	} = $props();

	let destroyed = false;
	let unlisten: (() => void) | undefined;

	const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

	onMount(async () => {
		// Installed before the watch is set, so no event of it goes unheard.
		let stop: (() => void) | undefined;
		try {
			stop = await onRepoChanged(changed);
		} catch (e) {
			if (!destroyed) report(`listening for repo changes failed: ${message(e)}`);
		}
		if (destroyed) return stop?.();
		unlisten = stop;
		// A watch no listener hears would only cost; the list still loads.
		if (stop !== undefined) {
			try {
				await watchRepo(++generation, root);
			} catch (e) {
				if (!destroyed) report(`watching the repo failed: ${message(e)}`);
			}
			if (destroyed) return;
		}
		// After the watch is set, so no change between the read and the watch goes unseen.
		void changeLists.refresh(root);
	});

	// Here and not in an effect's cleanup, which Svelte also runs before every rerun.
	onDestroy(() => {
		destroyed = true;
		unlisten?.();
		watchRepo(++generation, null).catch((e) => console.warn('unwatching the repo failed:', e));
	});

	// No timer: the Rust worker already gathered the batch.
	function changed(r: string) {
		if (!destroyed && r === root) void changeLists.refresh(root);
	}

	// Its errors go to the status line from the panel, which hears them where they happen.
	const snap = $derived(changeLists.lists[root]);
</script>

<div class="changes">
	{#if snap?.error !== undefined}
		<!-- Above the rows kept, so a failed refresh does not pass for a current list. -->
		<p class="error">{snap.error}</p>
	{/if}
	{#if snap?.list}
		{@const list = snap.list}
		{#each list.entries as c (c.path)}
			{@const at = split(c.path)}
			<button
				class="row"
				title={c.from !== null ? `from ${c.from}` : c.path}
				aria-current={highlight === c.abs || undefined}
				onclick={() => onopen(c.abs)}
				ondblclick={() => onopen(c.abs, true)}
			>
				<span class="letter" style:color={tints[c.status]}>{c.status}</span>
				<span class="path"><span class="dir">{at.dir}</span>{at.name}</span>
				{#if c.added !== null && c.removed !== null}
					<span class="added">+{c.added}</span>
					<span class="removed">−{c.removed}</span>
				{/if}
			</button>
		{:else}
			{#if snap.error === undefined}<p class="empty">No changes</p>{/if}
		{/each}
		{#if list.total > list.entries.length}
			<div class="row more">
				<span class="letter"></span>
				<span class="path">{list.total - list.entries.length} more not shown</span>
			</div>
		{/if}
	{/if}
</div>

<style>
	.changes {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 4px 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 4px;
		box-sizing: border-box;
		width: 100%;
		height: 22px;
		padding: 0 8px;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}
	button.row:hover {
		background: #2c2c2d;
	}
	button.row[aria-current] {
		background: #37373a;
	}
	button.row:focus-visible {
		outline: 1px solid var(--neon);
		outline-offset: -1px;
	}
	.letter {
		flex: none;
		width: 14px;
		font-weight: 600;
		text-align: center;
	}
	.path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dir {
		color: #999;
	}
	.added,
	.removed {
		flex: none;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	.added {
		color: #81b88b;
	}
	.removed {
		color: #c74e39;
	}
	.more {
		color: #999;
		cursor: default;
	}
	.empty,
	.error {
		margin: 8px;
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.empty {
		color: #999;
	}
	.error {
		color: #ccc;
	}
</style>
