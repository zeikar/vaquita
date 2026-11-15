<script lang="ts">
	import AddRepo from './AddRepo.svelte';
	import { getApp } from './app-context';
	import Icon from './Icon.svelte';
	import { holdLayout } from './layout-hold';
	import { isSessionTab } from './session-tabs';
	import SessionList from './SessionList.svelte';
	import SidebarEdge from './SidebarEdge.svelte';
	import { OTHER } from './tabs';

	const { manager, tabs, layout, startup } = getApp();
</script>

<aside bind:this={layout.sidebar}>
	<header>
		<span class="title">Repos</span>
		<AddRepo bind:this={layout.addRepo} disabled={$manager.status !== 'connected'} onadd={(p) => manager.addRepo(p)} />
	</header>
	<SessionList
		sessions={$manager.sessions}
		selected={$manager.selected}
		selectedRepo={tabs.selectedRow ? undefined : tabs.group}
		otherTabs={(tabs.groups[OTHER] ?? []).some((k) => !isSessionTab(k))}
		onselect={tabs.selectSession}
		onselectrepo={(r) => (r === OTHER ? tabs.openOther() : tabs.openWelcome(r))}
		onkill={(sid) => manager.kill(sid)}
		repos={$manager.repos}
		home={startup.home}
		disabled={$manager.creating || $manager.status !== 'connected'}
		onreopen={(sid) => manager.reopen(sid)}
		ondismiss={(sid) => manager.dismiss(sid)}
		onstart={(repo, cmd) => manager.create(repo, cmd, '')}
		onremoverepo={(p) => manager.removeRepo(p)}
		onrename={(sid, name) => manager.rename(sid, name)}
		onreport={(m) => manager.report(m)}
		addDisabled={$manager.status !== 'connected'}
		onaddrepo={() => void layout.addRepo?.open()}
		onnewsession={tabs.newSession}
	/>
	<div class="sidebar-footer">
		<button class="new-session" title="New session (⌘T)" onclick={tabs.newSession}>
			<Icon name="plus" />
			<span class="label">New session</span>
			<kbd>⌘T</kbd>
		</button>
	</div>
	<SidebarEdge width={layout.sidebarWidth} onstart={() => holdLayout(true)} onresize={(w) => (layout.sidebarWidth = w)} onend={layout.sidebarResized} />
</aside>
