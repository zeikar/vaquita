<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { agentIcon } from './agent';
	import { ago, heldConversations, matchesTitle, resumeCommand } from './conversations';
	import { pastConversations, type Conversation, type ConversationList } from './files';
	import { repoName } from './groups';
	import Icon from './Icon.svelte';
	import { belongsToIME } from './keys';
	import type { SessionInfo } from './protocol';

	let {
		root,
		sessions,
		repos,
		disabled,
		onresume,
		onselect,
		onreopen,
		onleave,
		report,
	}: {
		root: string;
		sessions: SessionInfo[];
		repos: string[];
		// Creating a session or not connected: only selecting a running one works.
		disabled: boolean;
		onresume: (cwd: string, cmd: string) => void;
		onselect: (sid: number) => void;
		onreopen: (sid: number) => void;
		// Gives the focus back when Escape leaves the filter.
		onleave: () => void;
		report: (message: string) => void;
	} = $props();

	// Replaced whole, never edited in place: no deep proxy for up to 500 rows.
	let snap = $state.raw<{ list?: ConversationList; error?: string; busy: boolean }>({ busy: false });
	let query = $state('');
	// Taken when a list lands, so the times hold still until the next one and
	// a session update re-renders no dates.
	let stamp = $state.raw<{ now: number; dates: Map<string, string> }>({ now: 0, dates: new Map() });
	let destroyed = false;

	// The lock is this promise, not snap.busy, which is for display. Requests
	// during a run become one run after it, as changes.svelte.ts does.
	let running: Promise<void> | undefined;
	let again = false;

	const key = (c: Conversation) => `${c.agent}:${c.id}`;
	const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

	export function refresh(): Promise<void> {
		if (running) {
			again = true;
			return running;
		}
		running = loop().finally(() => (running = undefined));
		return running;
	}

	export function isBusy(): boolean {
		return snap.busy;
	}

	async function loop(): Promise<void> {
		do {
			again = false;
			snap = { ...snap, busy: true };
			try {
				// The repo list as of the call: a change of it is no trigger, the
				// rows are read again on the next show or Refresh.
				const list = await pastConversations(root, repos);
				if (destroyed) return;
				stamp = { now: Date.now(), dates: new Map(list.entries.map((c) => [key(c), new Date(c.last_active).toLocaleString()])) };
				snap = { list, busy: false };
			} catch (e) {
				if (destroyed) return;
				const error = message(e);
				const known = snap.error;
				// The last list stays: a failed refresh is not an answer.
				snap = { list: snap.list, error, busy: false };
				if (error !== known) report(`listing past conversations in ${repoName(root)} failed: ${error}`);
			}
		} while (again);
	}

	onMount(() => void refresh());
	onDestroy(() => (destroyed = true));

	const held = $derived(heldConversations(sessions));
	// No path test: Rust decided which conversations are this repo's.
	const rows = $derived(snap.list?.entries.filter((c) => matchesTitle(c, query)) ?? []);

	// What a click on the row does, undefined when it can do nothing.
	function action(c: Conversation): (() => void) | undefined {
		const h = held.get(c.id);
		if (h?.how === 'running') return () => onselect(h.sid);
		if (disabled || h?.how === 'orphans') return undefined;
		if (h?.how === 'record') return () => onreopen(h.sid);
		return () => onresume(c.cwd, resumeCommand(c.agent, c.id));
	}

	function tooltip(c: Conversation): string {
		const lines = [c.cwd, stamp.dates.get(key(c)) ?? ''];
		if (held.get(c.id)?.how === 'orphans') lines.push('its earlier session still has processes; kill them in the sidebar first');
		return lines.join('\n');
	}

	function filterKey(e: KeyboardEvent) {
		// An Escape that ends an IME composition is the IME's.
		if (e.key !== 'Escape' || belongsToIME(e)) return;
		e.preventDefault();
		query = '';
		onleave();
	}
</script>

<div class="filter">
	<input type="search" placeholder="Filter by title" aria-label="Filter past conversations by title" bind:value={query} onkeydown={filterKey} />
</div>
<div class="past">
	{#if snap.error !== undefined}
		<!-- Above the rows kept, so a failed refresh does not pass for a current list. -->
		<p class="error">{snap.error}</p>
	{/if}
	{#if snap.list}
		{@const list = snap.list}
		{#each rows as c (key(c))}
			{@const how = held.get(c.id)?.how}
			{@const act = action(c)}
			<button class="row" title={tooltip(c)} aria-disabled={act === undefined || undefined} onclick={() => act?.()}>
				<Icon name={agentIcon(c.agent)} />
				<span class="title">{c.title}</span>
				{#if how === 'running'}
					<span class="when open">open</span>
				{:else if how === 'orphans'}
					<span class="when">earlier run</span>
				{:else}
					<span class="when">{ago(c.last_active, stamp.now)}</span>
				{/if}
			</button>
		{:else}
			{#if list.entries.length > 0}
				<p class="empty">No titles match</p>
			{:else if snap.error === undefined}
				<p class="empty">No past conversations</p>
			{/if}
		{/each}
		{#if list.total > list.entries.length}
			<div class="row more">
				<span class="title">{list.total - list.entries.length} more not shown</span>
			</div>
		{/if}
	{/if}
</div>

<style>
	/* The rows' height, the input filling it. */
	.filter {
		flex: none;
		display: flex;
		height: 22px;
		border-bottom: 1px solid #333;
	}
	input {
		flex: 1;
		min-width: 0;
		box-sizing: border-box;
		height: 100%;
		padding: 0 8px;
		border: none;
		outline: none;
		background: #1e1e1e;
		color: #d4d4d4;
		font: inherit;
		font-size: 12px;
	}
	input:focus-visible {
		box-shadow: inset 0 0 0 1px var(--neon);
	}
	.past {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 4px 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 6px;
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
	button.row:hover:not([aria-disabled='true']) {
		background: #2c2c2d;
	}
	button.row:focus-visible {
		outline: 1px solid var(--neon);
		outline-offset: -1px;
	}
	/* As the Refresh button while it is busy. */
	button.row[aria-disabled='true'] {
		opacity: 0.5;
		cursor: default;
	}
	.row :global(svg) {
		flex: none;
		width: 12px;
		height: 12px;
		color: #999;
	}
	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.when {
		flex: none;
		color: #999;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		text-align: right;
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
