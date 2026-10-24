<script lang="ts">
	import { Confirm } from './confirm.svelte';
	import { groupRows, repoName } from './groups';
	import { belongsToIME } from './keys';
	import type { SessionRow } from './manager';
	import { sessionTitle } from './notify';
	import { STATE_EXITED, type SessionInfo } from './protocol';

	let {
		sessions,
		selected,
		onselect,
		onkill,
		repos,
		disabled,
		onreopen,
		ondismiss,
		onstart,
		onremoverepo,
		onrename,
	}: {
		sessions: SessionRow<unknown>[];
		selected?: number;
		onselect: (sid: number) => void;
		onkill: (sid: number) => void;
		repos: string[];
		disabled: boolean;
		onreopen: (sid: number) => void;
		ondismiss: (sid: number) => void;
		onstart: (repo: string, cmd: 'claude' | 'codex') => void;
		onremoverepo: (path: string) => void;
		onrename: (sid: number, name: string) => void;
	} = $props();

	const groups = $derived(groupRows(sessions, repos));

	// Kill, Dismiss and Remove take a second click.
	const twoClick = new Confirm();

	// The row whose name is being edited, with the name it started from, and
	// the text typed so far. Kept here rather than read from the row, so that
	// a list update while typing changes neither.
	let editing = $state<{ sid: number; from: string }>();
	let draft = $state('');

	function startEdit(info: SessionInfo) {
		editing = { sid: info.sid, from: info.name };
		draft = info.name;
	}

	// Enter and the blur that follows both commit; the second finds nothing.
	function commit() {
		if (!editing) return;
		const { sid, from } = editing;
		editing = undefined;
		const name = draft.trim();
		if (name !== from) onrename(sid, name);
	}

	function editKey(e: KeyboardEvent) {
		// An Enter or Escape that ends an IME composition is the IME's.
		if (belongsToIME(e)) return;
		if (e.key === 'Enter') commit();
		else if (e.key === 'Escape') editing = undefined;
	}

	function focusInput(el: HTMLInputElement) {
		el.focus();
		el.select();
	}
</script>

{#snippet rowBody(r: SessionRow<unknown>)}
	{@const s = r.info.status}
	<!-- The dot and the status line keep their space when empty, so rows do not jump. -->
	{#if editing?.sid === r.info.sid}
		<span class="title editing">
			<span class="dot">{r.info.unread ? '•' : ''}</span><input
				aria-label="Session name"
				placeholder={sessionTitle({ ...r.info, name: '' })}
				bind:value={draft}
				onkeydown={editKey}
				onblur={commit}
				use:focusInput
			/>
		</span>
	{:else}
		<span class="title" class:unread={r.info.unread} title={sessionTitle(r.info)}>
			<span class="dot">{r.info.unread ? '•' : ''}</span>{sessionTitle(r.info)}
		</span>
	{/if}
	<span class="cwd">{r.info.cwd || '~'}</span>
	<span class="status {s?.state}" title={s?.msg}>
		{#if s?.state === 'working'}<span class="spinner"></span>
		{:else if s?.state === 'input'}⚠ {s.msg}
		{:else if s?.state === 'auth'}🔑
		{:else if s?.state === 'done'}✓
		{:else if s?.state === 'error'}✗
		{:else}&nbsp;{/if}
	</span>
	<span class="flags">
		{#if r.info.restorable}<span>from an earlier run</span>
		{:else if r.info.state === STATE_EXITED}<span>exited ({r.info.code})</span>{/if}
		{#if r.info.orphans?.length}<span>orphans: {r.info.orphans.join(', ')}</span>{/if}
		{#if r.ro}<span>read-only</span>{/if}
		{#if !r.info.restorable}
			<span>reports: {r.reports}</span>
			<span>resets: {r.resets}</span>
		{/if}
	</span>
{/snippet}

<ul>
	{#each groups as g (g.repo ?? '')}
		<li class="group" title={g.repo}>
			<span class="repo">{g.repo === undefined ? 'other' : repoName(g.repo)}</span>
			{#if g.repo !== undefined}
				{@const repo = g.repo}
				<button class="small" {disabled} title="Start claude in {repo}" onclick={() => onstart(repo, 'claude')}>claude</button>
				<button class="small" {disabled} title="Start codex in {repo}" onclick={() => onstart(repo, 'codex')}>codex</button>
				<button
					class="small"
					title="Remove {repo} from the list; its sessions keep running"
					class:armed={twoClick.armed === `repo:${repo}`}
					onclick={() => twoClick.click(`repo:${repo}`, () => onremoverepo(repo))}
					onblur={() => twoClick.armed === `repo:${repo}` && twoClick.disarm()}
					onpointerleave={() => twoClick.armed === `repo:${repo}` && twoClick.disarm()}
				>
					{twoClick.armed === `repo:${repo}` ? 'Confirm remove?' : 'remove'}
				</button>
			{/if}
		</li>
		{#each g.rows as r (r.info.sid)}
			{@const key = `${r.info.restorable ? 'dismiss' : 'kill'}:${r.info.sid}`}
			<li class:selected={r.info.sid === selected} onpointerleave={() => twoClick.armed === key && twoClick.disarm()}>
				<!-- While its name is edited a row is no button: a button may not hold
				     an input, and the input's clicks would select the row. -->
				{#if editing?.sid === r.info.sid}
					<div class="row">{@render rowBody(r)}</div>
				{:else}
					<!-- The button takes the double-click, as a span cannot without a role;
					     only one on the title renames. -->
					<button
						class="row"
						onclick={() => onselect(r.info.sid)}
						ondblclick={(e) => (e.target as Element).closest('.title') && startEdit(r.info)}
					>
						{@render rowBody(r)}
					</button>
				{/if}
				{#if r.info.restorable}
					<button class="kill" {disabled} onclick={() => onreopen(r.info.sid)}>Reopen</button>
				{/if}
				<button
					class="kill"
					class:armed={twoClick.armed === key}
					onclick={() => twoClick.click(key, () => (r.info.restorable ? ondismiss : onkill)(r.info.sid))}
					onblur={() => twoClick.armed === key && twoClick.disarm()}
				>
					{#if r.info.restorable}{twoClick.armed === key ? 'Confirm dismiss?' : 'Dismiss'}{:else}{twoClick.armed === key ? 'Confirm kill?' : 'Kill'}{/if}
				</button>
			</li>
		{/each}
	{/each}
</ul>

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		flex: 1;
	}
	li {
		display: flex;
		align-items: flex-start;
		border-bottom: 1px solid #333;
	}
	li.group {
		align-items: center;
		gap: 4px;
		padding: 4px 8px;
		font-size: 11px;
		color: #999;
	}
	.repo {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.small {
		font-size: 11px;
		padding: 0 6px;
	}
	.small.armed {
		background: #c72e2e;
		border-color: #f14c4c;
		color: #fff;
	}
	li.selected {
		background: #2a2d2e;
	}
	.row {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px 8px;
		text-align: left;
		background: none;
		border: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	div.row {
		cursor: auto;
	}
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.title.unread {
		font-weight: bold;
	}
	.title.editing {
		display: flex;
	}
	/* Its border sits in the margins, so the row keeps its height. */
	.title input {
		flex: 1;
		min-width: 0;
		margin: -1px 0;
		padding: 0 2px;
		border: 1px solid #4fc1ff;
		border-radius: 2px;
		outline: none;
		background: #1e1e1e;
		color: inherit;
		font: inherit;
	}
	.dot {
		display: inline-block;
		width: 12px;
		color: #4fc1ff;
	}
	.cwd,
	.status,
	.flags {
		font-size: 11px;
		color: #999;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.status {
		font-size: 12px;
		/* Fixed, so an emoji's taller font cannot change the row's height. */
		height: 16px;
		line-height: 16px;
		color: #d4d4d4;
	}
	.status.input {
		color: #cca700;
	}
	.status.done {
		color: #89d185;
	}
	.status.error {
		color: #f14c4c;
	}
	.spinner {
		display: inline-block;
		width: 8px;
		height: 8px;
		border: 2px solid #555;
		border-top-color: #4fc1ff;
		border-radius: 50%;
		vertical-align: middle;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
	.flags {
		display: flex;
		gap: 8px;
	}
	.kill {
		margin: 6px 8px;
	}
	.kill + .kill {
		margin-left: 0;
	}
	.kill.armed {
		background: #c72e2e;
		border-color: #f14c4c;
		color: #fff;
	}
</style>
