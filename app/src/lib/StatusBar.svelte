<script lang="ts">
	import { getApp } from './app-context';
	import Icon from './Icon.svelte';

	const { manager, layout } = getApp();

	const statusText = $derived.by(() => {
		switch ($manager.status) {
			case 'connected':
				return 'connected';
			case 'connecting':
				return 'connecting…';
			case 'starting':
				return 'starting daemon…';
			case 'restarting':
				return 'restarting daemon…';
			case 'not-running':
				return 'daemon not running';
			case 'version-mismatch':
				return `daemon restart needed (daemon v${$manager.daemonV}, app v1)`;
			case 'disconnected':
				return 'disconnected, retrying…';
		}
	});
	// The status line is grey; only its dot says how the daemon is.
	const statusTone = $derived.by(() => {
		switch ($manager.status) {
			case 'connected':
				return 'ok';
			case 'not-running':
			case 'version-mismatch':
				return 'bad';
			default:
				return 'wait';
		}
	});
</script>

<footer>
	<button class="icon-btn sidebar-toggle" title="{layout.sidebarHidden ? 'Show' : 'Hide'} sidebar (⌘B)" onclick={layout.toggleSidebar}>
		<Icon name="sidebar" />
	</button>
	<span class="state"><span class="dot {statusTone}"></span>{statusText}</span>
	<span>{$manager.sessions.length} sessions</span>
	{#if $manager.message}<span class="message" title={$manager.message}>{$manager.message}</span>{/if}
	{#if $manager.report}
		{@const report = $manager.report}
		<button class="report {report.tone}" title={report.text} onclick={() => manager.dismissReport()}>{report.text}</button>
	{/if}
	<button class="icon-btn files-toggle" title="{layout.panelHidden ? 'Show' : 'Hide'} files (⌥⌘B)" onclick={layout.togglePanel}>
		<Icon name="sidebar-right" />
	</button>
</footer>
