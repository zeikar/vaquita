<script lang="ts">
	import { onMount } from 'svelte';
	import { changeLists } from './changes.svelte';
	import { repoName } from './groups';
	import Icon from './Icon.svelte';
	import PastList from './PastList.svelte';
	import { tildePath } from './paths';
	import type { SessionInfo } from './protocol';
	import { changesText, repoSessions, sessionsText } from './welcome';

	let {
		repo,
		home,
		sessions,
		repos,
		connected,
		creating,
		onstart,
		onallpast,
		onresume,
		onselect,
		onreopen,
		report,
	}: {
		repo: string;
		home?: string;
		sessions: SessionInfo[];
		repos: string[];
		connected: boolean;
		creating: boolean;
		// '' is a plain shell.
		onstart: (cmd: 'claude' | 'codex' | '') => void;
		onallpast: () => void;
		onresume: (cwd: string, cmd: string) => void;
		onselect: (sid: number) => void;
		onreopen: (sid: number) => void;
		report: (message: string) => void;
	} = $props();

	let root: HTMLDivElement;

	// Takes the focus from any terminal underneath, so that typing never
	// reaches one the user cannot see.
	export function focus(): void {
		root.focus();
	}

	// A show, as the Changes view's: git runs once when the welcome appears,
	// then only on what refreshes the list anyway (a turn's end, a save).
	onMount(() => void changeLists.refresh(repo));

	const snap = $derived(changeLists.lists[repo]);
	const branch = $derived(snap?.list?.branch ?? null);
	const total = $derived(snap?.list?.total);
	const changes = $derived(changesText(total));
	const disabled = $derived(!connected || creating);

	const starts = [
		{ cmd: 'claude', kind: 'claude', label: 'Claude Code', icon: 'claude', sub: 'New conversation here' },
		{ cmd: 'codex', kind: 'codex', label: 'Codex', icon: 'openai', sub: 'New conversation here' },
		{ cmd: '', kind: 'shell', label: 'Shell', icon: 'command-line', sub: 'A plain terminal' },
	] as const;
</script>

<!-- The repo's name is the headline; the three starts are the point. -->
<div class="repo-hello" tabindex="-1" bind:this={root}>
	<div class="rh">
		<div class="crumb" title={repo}><Icon name="folder" />{tildePath(repo, home)}</div>
		<h1>{repoName(repo)}</h1>
		<div class="meta">
			{#if branch !== null}
				<span>on <em>{branch}</em></span>
			{/if}
			{#if changes !== undefined}
				<span class:chg={total !== undefined && total > 0}>{changes}</span>
			{/if}
			<span>{sessionsText(repoSessions(sessions, repos, repo))}</span>
		</div>
		{#if snap?.error !== undefined}
			<p class="error">{snap.error}</p>
		{/if}
		<div class="starts">
			{#each starts as s (s.kind)}
				<button type="button" class="start {s.kind}" {disabled} onclick={() => onstart(s.cmd)}>
					<span class="top"><b>{s.label}</b><Icon name={s.icon} /></span>
					<small>{s.sub}</small>
				</button>
			{/each}
		</div>
		<div class="sec">
			<h2>Pick up where you left off</h2>
			<button type="button" class="all" onclick={onallpast}>All past conversations</button>
		</div>
		<div class="list">
			<PastList root={repo} limit={5} {sessions} {repos} {disabled} {onresume} {onselect} {onreopen} {report} />
		</div>
	</div>
</div>

<style>
	.repo-hello {
		min-height: 0;
		overflow: auto;
		padding: 56px 64px;
		background: #1e1e1e;
		outline: none;
	}

	.rh {
		max-width: 640px;
	}

	.crumb {
		display: flex;
		align-items: center;
		gap: 8px;
		color: #8b8b8b;
		font-size: 12px;
	}

	.crumb :global(svg) {
		flex: none;
	}

	h1 {
		margin: 10px 0 0;
		font: 700 34px/1.1 -apple-system, 'SF Pro Display', system-ui, sans-serif;
		letter-spacing: -0.02em;
		color: #ececec;
		overflow-wrap: anywhere;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		margin-top: 8px;
		color: #9a9a9a;
		font-size: 12px;
	}

	.meta em {
		font-style: normal;
		color: #c9c9c9;
	}

	.meta .chg {
		color: #e2c08d;
	}

	/* PastList's error line. */
	.error {
		margin: 8px 0 0;
		color: #ccc;
		font-size: 12px;
		overflow-wrap: anywhere;
	}

	.starts {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
		margin-top: 28px;
	}

	.start {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		box-sizing: border-box;
		height: 76px;
		margin: 0;
		padding: 12px 14px;
		border: 1px solid #3a3a3c;
		border-radius: 8px;
		background: #232324;
		color: inherit;
		font: inherit;
		text-align: left;
	}

	.start.claude {
		border-color: #4a4a4c;
		background: #262627;
	}

	.start:hover:not(:disabled) {
		border-color: #555557;
		background: #2a2a2b;
	}

	.start:focus-visible {
		outline: 1px solid var(--neon);
		outline-offset: -1px;
	}

	.start:disabled {
		opacity: 0.5;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.start b {
		color: #eee;
		font-size: 14px;
		font-weight: 600;
	}

	.start small {
		color: #8b8b8b;
		font-size: 12px;
	}

	.start :global(svg) {
		flex: none;
		width: 18px;
		height: 18px;
	}

	.start.claude :global(svg) {
		color: #d97757;
	}

	.start.codex :global(svg) {
		color: #e8e8e8;
	}

	.start.shell :global(svg) {
		color: #9aa;
	}

	.sec {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-top: 36px;
	}

	h2 {
		margin: 0;
		color: #cfcfcf;
		font-size: 13px;
		font-weight: 600;
	}

	.all {
		padding: 0;
		border: none;
		background: none;
		color: var(--neon);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.all:hover {
		text-decoration: underline;
	}

	.all:focus-visible {
		outline: 1px solid var(--neon);
		outline-offset: 2px;
	}

	.list {
		margin-top: 8px;
		border-top: 1px solid #323233;
	}
</style>
