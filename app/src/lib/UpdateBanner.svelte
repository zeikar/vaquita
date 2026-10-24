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
	/* The status line's grey, set apart by a blue edge as a notice. */
	div {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px 4px 10px;
		border-top: 1px solid #333;
		background: #252526;
		box-shadow: inset 2px 0 #0e639c;
		color: #ccc;
		font-size: 12px;
	}
	span {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* The new-session dialog's primary button, smaller. */
	button {
		height: 22px;
		padding: 0 10px;
		border: 1px solid #0e639c;
		border-radius: 4px;
		background: #0e639c;
		color: #fff;
		font: inherit;
		cursor: pointer;
	}
	button:hover {
		background: #1177bb;
	}
	button:focus-visible {
		outline: 1px solid #4fc1ff;
		outline-offset: 1px;
	}
	button.armed {
		border-color: #f14c4c;
		background: #c72e2e;
	}
	button.armed:hover {
		background: #d63a3a;
	}
</style>
