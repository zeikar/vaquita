<script lang="ts">
	import { Confirm } from './confirm.svelte';
	import { groupRows, repoName } from './groups';
	import type { SessionRow } from './manager';
	import SessionItem from './SessionItem.svelte';

	let {
		sessions,
		selected,
		onselect,
		onkill,
		repos,
		home,
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
		// Known only inside Tauri; without it paths stay absolute. Required, so
		// that a caller cannot forget it.
		home: string | undefined;
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

	// The sid of the row whose name is being edited.
	let editing = $state<number>();
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
			{@const sid = r.info.sid}
			<SessionItem
				row={r}
				{home}
				selected={sid === selected}
				{disabled}
				editing={editing === sid}
				{twoClick}
				onselect={() => onselect(sid)}
				onedit={() => (editing = sid)}
				onrename={(name) => onrename(sid, name)}
				onclose={() => editing === sid && (editing = undefined)}
				onkill={() => onkill(sid)}
				onreopen={() => onreopen(sid)}
				ondismiss={() => ondismiss(sid)}
			/>
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
	li.group {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px;
		border-bottom: 1px solid #333;
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
</style>
