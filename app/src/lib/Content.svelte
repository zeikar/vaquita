<script lang="ts">
	import { getApp } from './app-context';
	import AppWelcome from './AppWelcome.svelte';
	import FilePane from './FilePane.svelte';
	import RepoWelcome from './RepoWelcome.svelte';
	import { isSessionTab } from './session-tabs';
	import TabBar from './TabBar.svelte';
	import { WELCOME } from './tabs';
	import TerminalPane from './TerminalPane.svelte';

	const { manager, tabs, layout, startup } = getApp();
</script>

<section class="content">
	<!-- No bar with nothing in it: a repo's welcome alone starts at the top, as the app welcome does. -->
	{#if tabs.group !== undefined && tabs.groupTabs.length > 0}
		<TabBar
			sessions={$manager.sessions}
			tabs={tabs.groupTabs}
			active={tabs.active}
			preview={tabs.previews[tabs.group]}
			dirty={tabs.dirty}
			onselect={(p) => void tabs.show(p)}
			onclose={(ps) => void tabs.close(ps)}
			onpin={(p) => tabs.pin(p)}
			onreorder={tabs.reorder}
			onnew={tabs.newSession}
			report={(m) => manager.report(m)}
		/>
	{/if}
	<div class="stack">
		<TerminalPane sessions={$manager.sessions} selected={$manager.selected} />
		{#if tabs.active === WELCOME && tabs.root !== undefined}
			{@const repo = tabs.root}
			<!-- Keyed, so another repo's welcome reads its own changes and past conversations. -->
			{#key repo}
				<RepoWelcome
					bind:this={tabs.repoWelcome}
					{repo}
					home={startup.home}
					sessions={$manager.sessions.map((r) => r.info)}
					repos={$manager.repos}
					connected={$manager.status === 'connected'}
					creating={$manager.creating}
					onstart={(cmd) => manager.create(repo, cmd, '')}
					onallpast={layout.showPast}
					onresume={(cwd, cmd) => void manager.create(cwd, cmd, '')}
					onselect={tabs.selectSession}
					onreopen={(sid) => manager.reopen(sid)}
					report={(m) => manager.report(m)}
				/>
			{/key}
		{:else if tabs.active !== undefined && !isSessionTab(tabs.active)}
			{@const path = tabs.active}
			<FilePane bind:this={tabs.filePane} {path} repo={tabs.root} home={startup.home} readOnly={startup.updating} onclose={() => void tabs.close([path])} onopenfile={(p) => tabs.openFromTree(p)} report={(m) => manager.report(m)} reveal={tabs.reveal} onrevealed={tabs.revealed} />
		{/if}
		{#if tabs.group === undefined}
			<AppWelcome bind:this={tabs.appWelcome} version={startup.version} addDisabled={$manager.status !== 'connected'} onaddrepo={() => void layout.addRepo?.open()} onnewsession={tabs.newSession} />
		{/if}
	</div>
</section>
