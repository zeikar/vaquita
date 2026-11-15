<script lang="ts">
	import { getApp } from './app-context';
	import AppUpdateBanner from './AppUpdateBanner.svelte';
	import { releaseUrl } from './app-update';
	import { runningCount } from './daemon-update';
	import { openExternal } from './links';
	import UpdateBanner from './UpdateBanner.svelte';

	const { manager, startup } = getApp();
	const { updater } = startup;

	// Closed for this app run: the restart can wait, and the notice covers the terminal.
	let daemonNoticeClosed = $state(false);
</script>

<div class="notices">
	{#if $updater.version !== undefined}
		{@const version = $updater.version}
		<AppUpdateBanner
			{version}
			installing={$updater.installing}
			error={$updater.error}
			oninstall={() => void startup.install()}
			ondismiss={() => updater.dismiss()}
			onnotes={() => openExternal(releaseUrl(version), (e) => manager.report(`opening the release notes failed: ${e instanceof Error ? e.message : String(e)}`))}
		/>
	{/if}
	{#if $manager.update && $manager.status === 'connected' && !daemonNoticeClosed}
		<UpdateBanner
			update={$manager.update}
			running={runningCount($manager.sessions.map((r) => r.info))}
			onrestart={() => manager.restartDaemon()}
			ondismiss={() => (daemonNoticeClosed = true)}
		/>
	{/if}
</div>
