<script lang="ts">
	import { onDestroy } from 'svelte';
	import { DaemonConnection } from './lib/connection';
	import { readEndpoint } from './lib/endpoint';
	import { SessionManager } from './lib/manager';

	const manager = new SessionManager({
		readEndpoint,
		connect: (endpoint, handlers) => new DaemonConnection(endpoint, handlers),
		createTerminal: () => {
			throw new Error('terminals are not wired yet');
		},
	});
	manager.start();
	onDestroy(() => manager.stop());

	const statusText = $derived.by(() => {
		switch ($manager.status) {
			case 'connected':
				return 'connected';
			case 'connecting':
				return 'connecting…';
			case 'not-running':
				return 'daemon not running';
			case 'version-mismatch':
				return `daemon restart needed (daemon v${$manager.daemonV}, app v1)`;
			case 'disconnected':
				return 'disconnected, retrying…';
		}
	});
</script>

<main>
	<footer>
		<span>{statusText}</span>
		<span>{$manager.sessions.length} sessions</span>
		{#if $manager.message}<span title={$manager.message}>{$manager.message}</span>{/if}
	</footer>
</main>
