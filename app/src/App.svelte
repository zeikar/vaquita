<script lang="ts">
	import { getCurrentWebview } from '@tauri-apps/api/webview';
	import { onDestroy } from 'svelte';
	import CreateForm from './lib/CreateForm.svelte';
	import { DaemonConnection } from './lib/connection';
	import { readEndpoint, startDaemon } from './lib/endpoint';
	import { SessionManager } from './lib/manager';
	import SessionList from './lib/SessionList.svelte';
	import TerminalPane from './lib/TerminalPane.svelte';
	import { shellQuoteAll } from './lib/shellquote';
	import { isTauri } from './lib/tauri';
	import { createTerminal, TermView } from './lib/term-view';

	const manager = new SessionManager({
		readEndpoint,
		startDaemon,
		connect: (endpoint, handlers) => new DaemonConnection(endpoint, handlers),
		createTerminal: (cols, rows) => createTerminal(cols, rows, (m) => manager.report(m)),
		createView: (term, core) => new TermView(term, core, (m) => manager.report(m)),
	});
	manager.start();
	onDestroy(() => manager.stop());

	// The OS file drop only exists inside Tauri; the paths are typed into the selected session.
	if (isTauri()) {
		const unlisten = getCurrentWebview().onDragDropEvent((e) => {
			if (e.payload.type !== 'drop') return;
			const { sessions, selected } = $manager;
			sessions.find((r) => r.info.sid === selected)?.view?.sendInput(shellQuoteAll(e.payload.paths));
		});
		unlisten.catch((e) => manager.report(`file drop unavailable: ${e instanceof Error ? e.message : String(e)}`));
		onDestroy(() => void unlisten.then((f) => f(), () => {}));
	}

	const statusText = $derived.by(() => {
		switch ($manager.status) {
			case 'connected':
				return 'connected';
			case 'connecting':
				return 'connecting…';
			case 'starting':
				return 'starting daemon…';
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
