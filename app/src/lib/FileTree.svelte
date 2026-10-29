<script module lang="ts">
	// The expanded folders by root, for the app run: hiding the panel or
	// switching to a session of another repo unmounts the tree and must not
	// collapse what was opened, but nothing stays open across a restart, as
	// the repo may have changed meanwhile.
	const expandedByRoot = new Map<string, Set<string>>();

	// Shared by every mount, as the watcher in Rust is one. It starts from the
	// clock, not 0: Rust keeps the last generation it applied across page
	// loads, so after a reload or a hot update a count from 0 would be ignored.
	let generation = Date.now();
</script>

<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { writeClipboard } from './clipboard';
	import ContextMenu from './ContextMenu.svelte';
	import { onFolderChanged, readFolder, setWatched, type Listing, type Refused } from './files';
	import Icon from './Icon.svelte';
	import type { MenuAt, MenuItem } from './menu';
	import { canReveal, revealInFinder } from './reveal';
	import { fileName } from './tabs';
	import { joinPath, orderEntries, visibleExpanded } from './tree';

	let {
		root,
		highlight,
		onopen,
		report,
	}: {
		root: string;
		// The shown tab's path.
		highlight?: string;
		onopen: (path: string) => void;
		report: (message: string) => void;
	} = $props();

	// How long a folder's events are gathered into one read: an agent writing
	// a batch of files costs one listing.
	const DEBOUNCE_MS = 150;

	// The parent keys the tree by root, so the root a mount starts with is
	// the one it keeps.
	const expanded = new SvelteSet<string>(expandedByRoot.get(untrack(() => root)) ?? []);
	const listings = new SvelteMap<string, Listing | { error: string }>();
	// False until the listener is installed, and again once the tree failed:
	// nothing is watched or read while it is.
	let ready = $state(false);
	let destroyed = false;
	let unlisten: (() => void) | undefined;
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	// The number of each folder's read in flight; an answer is applied only
	// while its number is still the folder's, so dropping the entry discards it.
	const pending = new Map<string, number>();
	let reads = 0;

	const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const shown = (folder: string) => visibleExpanded(root, expanded).includes(folder);

	function toggle(folder: string) {
		if (!expanded.delete(folder)) expanded.add(folder);
		expandedByRoot.set(root, new Set(expanded));
	}

	function stopTimers() {
		for (const t of timers.values()) clearTimeout(t);
		timers.clear();
	}

	// For what the tree cannot work past (the listener, a rejected set): it
	// stops until it is mounted again, and a late read cannot put rows that
	// look live over a tree whose watches Rust has dropped.
	function failTree(what: string, e: unknown) {
		const text = `${what} failed: ${message(e)}`;
		ready = false;
		stopTimers();
		pending.clear();
		listings.set(root, { error: text });
		report(text);
	}

	onMount(async () => {
		// Installed before the first set is sent, so no change between a read
		// and its watch goes unseen.
		let stop;
		try {
			stop = await onFolderChanged(changed);
		} catch (e) {
			if (!destroyed) failTree('listening for folder changes', e);
			return;
		}
		if (destroyed) return stop();
		unlisten = stop;
		ready = true;
	});

	// Here and not in an effect's cleanup, which Svelte also runs before every
	// rerun of the effect.
	onDestroy(() => {
		destroyed = true;
		stopTimers();
		unlisten?.();
		setWatched(++generation, []).catch((e) => console.warn('unwatching the file tree failed:', e));
	});

	// Only reconciles: the visible expanded folders become the watched set.
	$effect(() => {
		if (!ready) return;
		const want = visibleExpanded(root, expanded);
		// Before any await, so a folder collapsed and expanded again before the
		// unwatch answered has no stale listing left to skip its read.
		untrack(() => {
			const keep = new Set(want);
			for (const folder of new Set([...listings.keys(), ...timers.keys(), ...pending.keys()])) {
				if (keep.has(folder)) continue;
				listings.delete(folder);
				clearTimeout(timers.get(folder));
				timers.delete(folder);
				pending.delete(folder);
			}
		});
		void sync(want);
	});

	async function sync(want: string[]) {
		const gen = ++generation;
		let refused: Refused[];
		try {
			refused = await setWatched(gen, want);
		} catch (e) {
			if (gen === generation && !destroyed) failTree('watching folders', e);
			return;
		}
		// A newer set, or the teardown, took over.
		if (destroyed || gen !== generation) return;
		// Left listed: its read, which follows, collapses it if it is gone.
		for (const r of refused) report(`watching ${fileName(r.path)} failed: ${r.error}`);
		// Every shown folder, not only a new one: the stream restarts from now
		// on each set change, so a change during the restart reached no watch.
		for (const folder of want) void load(folder);
	}

	async function load(folder: string) {
		if (!ready) return;
		const n = ++reads;
		pending.set(folder, n);
		let listing: Listing | { error: string };
		try {
			listing = await readFolder(folder);
		} catch (e) {
			listing = { error: message(e) };
		}
		if (pending.get(folder) !== n || !ready || destroyed || !shown(folder)) return;
		pending.delete(folder);
		if ('error' in listing && folder !== root) {
			// The effect turns the collapse into an unwatch.
			toggle(folder);
			report(`${fileName(folder)}: ${listing.error}`);
			return;
		}
		listings.set(folder, listing);
	}

	function changed(folders: string[]) {
		if (!ready) return;
		for (const folder of folders) {
			// A folder the tree no longer shows: its unwatch may not have landed yet.
			if (!shown(folder)) continue;
			clearTimeout(timers.get(folder));
			timers.set(
				folder,
				setTimeout(() => {
					timers.delete(folder);
					void load(folder);
				}, DEBOUNCE_MS),
			);
		}
	}

	// The one context menu; key changes on every open, as the menu takes its
	// opener and the focus when it mounts.
	let menu = $state<{ at: MenuAt; items: MenuItem[]; path: string; key: number }>();
	let opens = 0;

	const failed = (what: string) => (e: unknown) => report(`${what} failed: ${message(e)}`);

	// The focus call: WebKit focuses no clicked button, and the menu gives the
	// focus back to what had it when it opened.
	function context(e: MouseEvent & { currentTarget: HTMLButtonElement }, path: string) {
		e.preventDefault();
		e.currentTarget.focus();
		const items: MenuItem[] = [
			...(canReveal() ? [{ label: 'Reveal in Finder', run: () => void revealInFinder(path).catch(failed('reveal in Finder')) }] : []),
			{ label: 'Copy path', run: () => void writeClipboard(path).catch(failed('copy path')) },
		];
		menu = { at: { x: e.clientX, y: e.clientY }, items, path, key: ++opens };
	}

	const indent = (depth: number) => `${8 + depth * 12}px`;
</script>

{#snippet rows(folder: string, depth: number)}
	{@const listing = listings.get(folder)}
	{#if listing && 'error' in listing}
		<p class="error">{listing.error}</p>
	{:else if listing}
		{#each orderEntries(listing.entries) as entry (entry.name)}
			{@const path = joinPath(folder, entry.name)}
			{#if entry.dir}
				{@const open = expanded.has(path)}
				<button
					class="row"
					class:menu={menu?.path === path}
					style:padding-left={indent(depth)}
					aria-expanded={open}
					onclick={() => toggle(path)}
					oncontextmenu={(e) => context(e, path)}
				>
					<Icon name={open ? 'chevron-down' : 'chevron-right'} />
					<span class="name">{entry.name}</span>
				</button>
				{#if open}{@render rows(path, depth + 1)}{/if}
			{:else}
				<button
					class="row"
					class:menu={menu?.path === path}
					style:padding-left={indent(depth)}
					aria-current={path === highlight || undefined}
					onclick={() => onopen(path)}
					oncontextmenu={(e) => context(e, path)}
				>
					<!-- Where a folder's chevron is, so the names line up. -->
					<span class="space"></span>
					<span class="name">{entry.name}</span>
				</button>
			{/if}
		{/each}
		{#if listing.total > listing.entries.length}
			<div class="row more" style:padding-left={indent(depth)}>
				<span class="space"></span>
				<span class="name">{listing.total - listing.entries.length} more not shown</span>
			</div>
		{/if}
	{/if}
{/snippet}

<div class="tree">
	{@render rows(root, 0)}
</div>
{#if menu}
	{#key menu.key}
		<ContextMenu at={menu.at} items={menu.items} onclose={() => (menu = undefined)} />
	{/key}
{/if}

<style>
	.tree {
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
		padding-right: 8px;
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
	/* The row a menu was opened on, as the menu covers the pointer. */
	button.row.menu {
		outline: 2px solid rgba(79, 193, 255, 0.5);
		outline-offset: -2px;
	}
	.row :global(svg),
	.space {
		flex: none;
		width: 14px;
		color: #999;
	}
	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.more {
		color: #999;
		cursor: default;
	}
	.error {
		margin: 8px;
		font-size: 12px;
		color: #ccc;
		overflow-wrap: anywhere;
	}
</style>
