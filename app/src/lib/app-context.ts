import type { Terminal } from '@xterm/xterm';
import { getContext, setContext } from 'svelte';
import type { Layout } from './layout.svelte';
import type { SessionManager } from './manager';
import type { Tabs } from './tabs.svelte';
import type { TermView } from './term-view';

// The app's stores, built once by App.svelte and read by the parts of its
// layout that would otherwise take a dozen props each.
export const APP = Symbol('app');

export type AppContext = {
	manager: SessionManager<Terminal, TermView>;
	tabs: Tabs<Terminal, TermView>;
	layout: Layout;
};

export function setApp(ctx: AppContext): void {
	setContext(APP, ctx);
}

export function getApp(): AppContext {
	return getContext<AppContext>(APP);
}
