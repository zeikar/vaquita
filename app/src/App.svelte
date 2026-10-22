<script lang="ts">
	import { onDestroy } from 'svelte';
	import CreateForm from './lib/CreateForm.svelte';
	import { DaemonConnection } from './lib/connection';
	import { readEndpoint } from './lib/endpoint';
	import { SessionManager } from './lib/manager';
	import SessionList from './lib/SessionList.svelte';
	import TerminalPane from './lib/TerminalPane.svelte';
	import { createTerminal, TermView } from './lib/term-view';

	const manager = new SessionManager({
		readEndpoint,
		connect: (endpoint, handlers) => new DaemonConnection(endpoint, handlers),
		createTerminal,
		createView: (term, core) => new TermView(term, core),
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
	<aside>
		<SessionList
			sessions={$manager.sessions}
			selected={$manager.selected}
			onselect={(sid) => manager.select(sid)}
			onkill={(sid) => manager.kill(sid)}
		/>
		<CreateForm
			disabled={$manager.creating || $manager.status !== 'connected'}
			oncreate={(cwd, cmd, name) => manager.create(cwd, cmd, name)}
		/>
	</aside>
	<TerminalPane sessions={$manager.sessions} selected={$manager.selected} />
	<footer>
		<span>{statusText}</span>
		<span>{$manager.sessions.length} sessions</span>
		{#if $manager.message}<span title={$manager.message}>{$manager.message}</span>{/if}
	</footer>
</main>
