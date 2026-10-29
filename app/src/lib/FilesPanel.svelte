<script module lang="ts">
	// Files or Changes, for every repo and the app run: hiding the panel or
	// selecting a session of another repo keeps the view chosen.
	let view = $state<'files' | 'changes'>('files');
</script>

<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { endedTurns } from './changes';
	import { changeLists } from './changes.svelte';
	import ChangesList from './ChangesList.svelte';
	import { documents } from './documents';
	import FileTree from './FileTree.svelte';
	import { repoName, repoOf } from './groups';
	import Icon from './Icon.svelte';
	import { shortPath } from './paths';
	import type { SessionInfo } from './protocol';

	let {
		root,
		cwd,
		home,
		connected,
		sessions,
		repos,
		highlight,
		onopen,
		onopendiff,
		onaddrepo,
		report,
	}: {
		// The selected session's repo, undefined when it is in none.
		root?: string;
		// The selected session's folder; undefined while no session is selected.
		cwd?: string;
		home?: string;
		connected: boolean;
		sessions: SessionInfo[];
		repos: string[];
		// The shown tab's file.
		highlight?: string;
		onopen: (path: string, pin?: boolean) => void;
		onopendiff: (path: string, pin?: boolean) => void;
		onaddrepo: (folder: string) => void;
		report: (message: string) => void;
	} = $props();

	const snap = $derived(root === undefined ? undefined : changeLists.lists[root]);
	// The last count known in this app run; none before one was taken:
	// showing the badge never runs git, a turn's end or a save does, in either view.
	const badge = $derived.by(() => {
		const list = snap?.list;
		if (list === undefined || list.total === 0) return undefined;
		return list.total > list.entries.length ? `${list.entries.length}+` : String(list.total);
	});

	// A turn's end and a save count in either view, so the badge stays right
	// while the tree shows. Plain: the states are only compared, never shown.
	let prev = new Map<number, string | undefined>();
	let prevRoot: string | undefined;
	$effect(() => {
		// Before anything is read: with no root, repoOf(cwd) === root would
		// match every session outside a repo.
		if (root === undefined) {
			prevRoot = undefined;
			return;
		}
		const r = root;
		if (r !== prevRoot) {
			prev = new Map();
			prevRoot = r;
		}
		const turns = endedTurns(prev, sessions, (c) => repoOf(c, repos) === r);
		prev = turns.next;
		// Untracked: a refresh writes the lists at once, which this must not rerun on.
		if (turns.ended) untrack(() => void changeLists.refresh(r));
	});

	// No test of the path: a saved tab is in the selected session's group,
	// this root's, and documents hold canonical paths while a root may not be
	// (/private/tmp/repo/a under /tmp/repo).
	onDestroy(
		documents.onSaved(() => {
			if (root !== undefined) void changeLists.refresh(root);
		}),
	);

	// Mounted wherever a refresh can start, so each new failure, from any
	// trigger and in either view, reaches the status line once.
	onDestroy(changeLists.onFailed((r, error) => report(`listing changes in ${repoName(r)} failed: ${error}`)));
</script>

<header>
	{#if root !== undefined}
		{@const r = root}
		<div class="switch" role="group" aria-label="Files panel view">
			<button aria-pressed={view === 'files'} onclick={() => (view = 'files')}>Files</button>
			<button
				aria-pressed={view === 'changes'}
				aria-label={badge === undefined ? undefined : `Changes, ${badge} changed`}
				onclick={() => (view = 'changes')}
			>
				<span class="label">Changes</span>{#if badge !== undefined}<span class="badge">{badge}</span>{/if}
			</button>
		</div>
		<span class="repo" title={r}>{repoName(r)}</span>
		{#if view === 'changes'}
			<!-- Not disabled while busy, which would drop its keyboard focus; a
			     click then is one more run after this one. -->
			<button
				class="refresh"
				title="Refresh changes"
				aria-label="Refresh changes"
				aria-disabled={snap?.busy ?? false}
				onclick={() => void changeLists.refresh(r)}
			>
				<Icon name="arrow-path" />
			</button>
		{/if}
	{:else}
		<span class="title">Files</span>
	{/if}
</header>
{#if root !== undefined}
	{#key root}
		{#if view === 'files'}
			<FileTree {root} {highlight} {onopen} {report} />
		{:else}
			<ChangesList {root} {highlight} onopen={onopendiff} {report} />
		{/if}
	{/key}
{:else if cwd !== undefined}
	<!-- An empty cwd is the home folder, unknown in a plain browser. -->
	{@const folder = cwd || home}
	<div class="no-repo">
		<p>This session's folder is not a registered repo, so it has no file tree.</p>
		<button title={folder} disabled={!connected || folder === undefined} onclick={() => folder !== undefined && onaddrepo(folder)}>
			Add {shortPath(cwd, home)} as a repo
		</button>
	</div>
{/if}

<style>
	/* app.css lays the row out as the sidebar's (aside > header); this only
	   spaces what is in it. */
	header {
		gap: 8px;
	}
	/* At the panel's narrowest the repo name goes first, then the Changes
	   label is cut, so Refresh stays inside. */
	.switch {
		display: flex;
		min-width: 0;
		border: 1px solid #3c3c3c;
		border-radius: 4px;
		overflow: hidden;
	}
	.switch button,
	.refresh {
		display: flex;
		align-items: center;
		height: 18px;
		border: none;
		background: transparent;
		color: #999;
		font: inherit;
		cursor: pointer;
	}
	.switch button {
		gap: 5px;
		padding: 0 8px;
	}
	.switch button:first-child,
	.badge {
		flex: none;
	}
	.switch button:last-child {
		min-width: 0;
	}
	.label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.switch button + button {
		border-left: 1px solid #3c3c3c;
	}
	.switch button:hover,
	.refresh:hover:not([aria-disabled='true']) {
		background: #2a2d2e;
		color: #d4d4d4;
	}
	.switch button[aria-pressed='true'] {
		background: #3a3d41;
		color: #e5e5e5;
	}
	.switch button:focus-visible,
	.refresh:focus-visible {
		outline: 1px solid var(--neon);
		outline-offset: -1px;
	}
	.badge {
		padding: 0 5px;
		border-radius: 7px;
		background: #3a3d41;
		color: #999;
		font-size: 10px;
		line-height: 14px;
	}
	/* Lighter on the pressed button, whose background is the pill's. */
	button[aria-pressed='true'] .badge {
		background: #4b4f55;
		color: #ccc;
	}
	/* The header's other end, where the name stood beside the title; from a
	   basis of 0 it only fills the room left, so it gives way first. */
	.repo {
		flex: 1 1 0;
		text-align: right;
	}
	/* 18px inside its border, as the switch's buttons. */
	.refresh {
		flex: none;
		justify-content: center;
		box-sizing: content-box;
		width: 20px;
		padding: 0;
		border: 1px solid #3c3c3c;
		border-radius: 4px;
	}
	.refresh[aria-disabled='true'] {
		opacity: 0.5;
		cursor: default;
	}
	.refresh :global(svg) {
		width: 12px;
		height: 12px;
	}

	/* The offer for a session under no repo, in the middle of the panel; the
	   button's look is the dialogs', in app.css. */
	.no-repo {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 16px;
		color: #999;
		font-size: 12px;
		line-height: 1.4;
		text-align: center;
	}
	.no-repo p {
		margin: 0;
	}
	.no-repo button {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
