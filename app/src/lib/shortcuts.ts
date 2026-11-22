import { onTabAsked } from './files';
import { agentShortcut, isNewSessionShortcut, isNextRepoShortcut, isNextTabShortcut, isPrevRepoShortcut, isPrevTabShortcut, isSaveShortcut, isSidebarShortcut, tabNumber } from './keys';
import type { Layout } from './layout.svelte';
import type { SessionManager } from './manager';
import type { Tabs } from './tabs.svelte';

// On the window in the capture phase, so it runs before xterm's handler on
// its textarea and the terminal never sees the key. ⌃Tab and ⌃⇧Tab are
// here and not in the menu, as AppKit would run its key-view loop on them;
// ⌥⌘← and ⌥⌘→ are here beside them, and so are ⌥⌘↑ and ⌥⌘↓, which the
// editor and the terminal would take; ⌘⇧C and ⌘⇧X start an agent. The menu has ⌘⇧[ and ⌘⇧].
export function windowShortcut(tabs: Pick<Tabs, 'newSession' | 'startAgent' | 'step' | 'stepRepo' | 'showAt' | 'save'>, layout: Pick<Layout, 'toggleSidebar'>): (e: KeyboardEvent) => void {
	return (e) => {
		const n = tabNumber(e);
		const agent = agentShortcut(e);
		if (isNewSessionShortcut(e)) tabs.newSession();
		else if (isSidebarShortcut(e)) layout.toggleSidebar();
		else if (isPrevTabShortcut(e)) tabs.step(-1);
		else if (isNextTabShortcut(e)) tabs.step(1);
		else if (isPrevRepoShortcut(e)) tabs.stepRepo(-1);
		else if (isNextRepoShortcut(e)) tabs.stepRepo(1);
		else if (agent !== undefined) tabs.startAgent(agent);
		else if (n !== undefined) tabs.showAt(n);
		else if (isSaveShortcut(e)) tabs.save();
		else return;
		e.preventDefault();
		e.stopPropagation();
	};
}

// The menu's tab actions and its files item; returns what stops listening.
export function watchMenu(tabs: Pick<Tabs, 'closeActive' | 'step'>, layout: Pick<Layout, 'togglePanel'>, manager: Pick<SessionManager, 'report'>): () => void {
	const unlisten = onTabAsked((a) => {
		switch (a) {
			case 'close':
				return tabs.closeActive();
			case 'prev':
				return tabs.step(-1);
			case 'next':
				return tabs.step(1);
			case 'files':
				return layout.togglePanel();
		}
	});
	unlisten.catch((e) => manager.report(`tab shortcuts unavailable: ${e instanceof Error ? e.message : String(e)}`));
	return () => void unlisten.then((f) => f(), () => {});
}
