<script lang="ts">
	import { Confirm } from './confirm.svelte';
	import type { DaemonUpdate } from './daemon-update';

	let {
		update,
		running,
		onrestart,
	}: {
		update: DaemonUpdate;
		running: number;
		onrestart: () => void;
	} = $props();

	// A restart ends the running sessions, so it takes a second click.
	const twoClick = new Confirm();
	const text = $derived.by(() => {
		const daemon = update.daemon === undefined ? 'An older vaquitad' : `vaquitad ${update.daemon}`;
		const ends = running === 0 ? '' : ` — ${running} running session${running === 1 ? '' : 's'} will end and can be reopened`;
		const note = update.note === undefined ? '' : ` (${update.note})`;
		return `${daemon} is running; this app ships ${update.app}. Restart it to update${ends}.${note}`;
	});
</script>

<div role="status">
	<span title={text}>{text}</span>
	<button
		class:armed={twoClick.armed === 'restart'}
		onclick={() => twoClick.click('restart', onrestart)}
		onblur={() => twoClick.disarm()}
		onpointerleave={() => twoClick.disarm()}
	>
		{twoClick.armed === 'restart' ? 'Confirm restart?' : 'Restart daemon'}
	</button>
</div>

<style>
	div {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 8px;
		border-top: 1px solid #333;
		background: #3a3d41;
		font-size: 12px;
	}
	span {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	button {
		font-size: 11px;
		padding: 0 6px;
	}
	button.armed {
		background: #c72e2e;
		border-color: #f14c4c;
		color: #fff;
	}
</style>
