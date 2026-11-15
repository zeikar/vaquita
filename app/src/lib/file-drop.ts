import { getCurrentWebview } from '@tauri-apps/api/webview';
import { get } from 'svelte/store';
import type { SessionManager } from './manager';
import { sessionTab } from './session-tabs';
import { shellQuoteAll } from './shellquote';
import type { Tabs } from './tabs.svelte';
import { isTauri } from './tauri';

export type DropDeps = {
	manager: Pick<SessionManager, 'subscribe' | 'addRepo' | 'report'>;
	tabs: Pick<Tabs, 'active' | 'selectedView' | 'show'>;
	sidebar: () => HTMLElement | undefined;
};

// Paths dropped on the sidebar are added as repos; anywhere else they are
// typed into the selected session. The position is in CSS pixels.
export function dropped(paths: string[], { x, y }: { x: number; y: number }, { manager, tabs, sidebar }: DropDeps): void {
	const box = sidebar()?.getBoundingClientRect();
	if (box && x >= box.left && x < box.right && y >= box.top && y < box.bottom) {
		for (const p of paths) manager.addRepo(p);
		return;
	}
	const sid = get(manager).selected;
	const view = tabs.selectedView();
	if (sid === undefined || !view) return;
	// The paths go to the terminal, so its tab shows.
	if (tabs.active !== sessionTab(sid)) void tabs.show(sessionTab(sid));
	try {
		view.sendInput(shellQuoteAll(paths));
	} catch (err) {
		manager.report(`file drop refused: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// The OS file drop only exists inside Tauri; returns what stops listening.
export function watchFileDrop(manager: DropDeps['manager'], tabs: DropDeps['tabs'], sidebar: DropDeps['sidebar']): () => void {
	if (!isTauri()) return () => {};
	const unlisten = getCurrentWebview().onDragDropEvent((e) => {
		if (e.payload.type !== 'drop') return;
		// The position arrives in physical pixels.
		dropped(e.payload.paths, e.payload.position.toLogical(window.devicePixelRatio), { manager, tabs, sidebar });
	});
	unlisten.catch((e) => manager.report(`file drop unavailable: ${e instanceof Error ? e.message : String(e)}`));
	return () => void unlisten.then((f) => f(), () => {});
}
