<script lang="ts">
	import { Confirm } from './confirm.svelte';
	import { shownBuild, type DaemonUpdate } from './daemon-update';

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
		const daemon = update.daemon === undefined ? 'An older vaquitad' : `vaquitad ${shownBuild(update.daemon)}`;
		const ends = running === 0 ? '' : ` — ${running} running session${running === 1 ? '' : 's'} will end and can be reopened`;
		const note = update.note === undefined ? '' : ` (${update.note})`;
		return `${daemon} is running; this app ships ${shownBuild(update.app)}. Restart it to update${ends}.${note}`;
	});
</script>

<div class="notice" role="status">
	<span title={text}>{text}</span>
	<button
		class="primary"
		class:armed={twoClick.armed === 'restart'}
		onclick={() => twoClick.click('restart', onrestart)}
		onblur={() => twoClick.disarm()}
		onpointerleave={() => twoClick.disarm()}
	>
		{twoClick.armed === 'restart' ? 'Confirm restart?' : 'Restart daemon'}
	</button>
</div>

<style>
	/* .primary as well, so these outrank the shared .notice button.primary
	   rules rather than tie with them and depend on stylesheet order. */
	.notice button.primary.armed {
		border-color: #f14c4c;
		background: #c72e2e;
	}
	.notice button.primary.armed:hover {
		background: #d63a3a;
	}
</style>
