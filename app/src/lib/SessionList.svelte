<script lang="ts">
	import type { SessionRow } from './manager';
	import { STATE_EXITED } from './protocol';

	let {
		sessions,
		selected,
		onselect,
		onkill,
	}: {
		sessions: SessionRow<unknown>[];
		selected?: number;
		onselect: (sid: number) => void;
		onkill: (sid: number) => void;
	} = $props();

	const CONFIRM_MS = 3000;
	// A double-click must not count as the confirming second click.
	const MIN_CONFIRM_MS = 400;

	const title = (r: SessionRow<unknown>) => r.info.name || r.info.cmd || 'shell';

	// Kill takes a second click: Tauri's WKWebView answers confirm() with
	// Cancel, as wry implements no JavaScript confirm panel.
	let armed = $state<number | undefined>();
	let armedAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function disarm() {
		clearTimeout(timer);
		armed = undefined;
	}

	function kill(sid: number) {
		if (armed === sid) {
			if (performance.now() - armedAt < MIN_CONFIRM_MS) return;
			disarm();
			onkill(sid);
			return;
		}
		disarm();
		armed = sid;
		armedAt = performance.now();
		timer = setTimeout(disarm, CONFIRM_MS);
	}
</script>

<ul>
	{#each sessions as r (r.info.sid)}
		<li class:selected={r.info.sid === selected} onpointerleave={() => armed === r.info.sid && disarm()}>
			<button class="row" onclick={() => onselect(r.info.sid)}>
				<span class="title">{r.info.sid} · {title(r)}</span>
				<span class="cwd">{r.info.cwd || '~'}</span>
				<span class="flags">
					{#if r.info.state === STATE_EXITED}<span>exited ({r.info.code})</span>{/if}
					{#if r.info.orphans?.length}<span>orphans: {r.info.orphans.join(', ')}</span>{/if}
					{#if r.ro}<span>read-only</span>{/if}
					<span>reports: {r.reports}</span>
					<span>resets: {r.resets}</span>
				</span>
			</button>
			<button
				class="kill"
				class:armed={armed === r.info.sid}
				onclick={() => kill(r.info.sid)}
				onblur={() => armed === r.info.sid && disarm()}
			>
				{armed === r.info.sid ? 'Confirm kill?' : 'Kill'}
			</button>
		</li>
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
	.cwd,
	.flags {
		font-size: 11px;
		color: #999;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.flags {
		display: flex;
		gap: 8px;
	}
	.kill {
		margin: 6px 8px;
	}
	.kill.armed {
		background: #c72e2e;
		border-color: #f14c4c;
		color: #fff;
	}
</style>
