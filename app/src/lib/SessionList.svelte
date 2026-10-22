<script lang="ts">
	import type { SessionRow } from './manager';
	import { sessionTitle } from './notify';
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
		{@const s = r.info.status}
		<li class:selected={r.info.sid === selected} onpointerleave={() => armed === r.info.sid && disarm()}>
			<button class="row" onclick={() => onselect(r.info.sid)}>
				<!-- The dot and the status line keep their space when empty, so rows do not jump. -->
				<span class="title" class:unread={r.info.unread}>
					<span class="dot">{r.info.unread ? '•' : ''}</span>{r.info.sid} · {sessionTitle(r.info)}
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
	.kill.armed {
		background: #c72e2e;
		border-color: #f14c4c;
		color: #fff;
	}
</style>
