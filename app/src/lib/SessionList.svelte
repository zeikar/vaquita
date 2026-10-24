<script lang="ts">
	import { Confirm } from './confirm.svelte';
	import { groupRows, repoName } from './groups';
	import type { SessionRow } from './manager';
	import { sessionTitle } from './notify';
	import { STATE_EXITED } from './protocol';

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
	} = $props();

	const groups = $derived(groupRows(sessions, repos));

	// Kill, Dismiss and Remove take a second click.
	const twoClick = new Confirm();
</script>

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
			{@const s = r.info.status}
			{@const key = `${r.info.restorable ? 'dismiss' : 'kill'}:${r.info.sid}`}
			<li class:selected={r.info.sid === selected} onpointerleave={() => twoClick.armed === key && twoClick.disarm()}>
				<button class="row" onclick={() => onselect(r.info.sid)}>
					<!-- The dot and the status line keep their space when empty, so rows do not jump. -->
					<span class="title" class:unread={r.info.unread} title={sessionTitle(r.info)}>
						<span class="dot">{r.info.unread ? '•' : ''}</span>{sessionTitle(r.info)}
					</span>
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
				</button>
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
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.title.unread {
		font-weight: bold;
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
