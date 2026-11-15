// @vitest-environment happy-dom
import { writable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropped, watchFileDrop, type DropDeps } from './file-drop';
import type { ManagerState } from './manager';

type DropEvent = { payload: { type: string; paths?: string[]; position?: { toLogical(scale: number): { x: number; y: number } } } };
const webview = vi.hoisted(() => ({
	handler: undefined as ((e: DropEvent) => void) | undefined,
	unlistened: 0,
	fail: undefined as Error | undefined,
}));
vi.mock('@tauri-apps/api/webview', () => ({
	getCurrentWebview: () => ({
		onDragDropEvent: async (h: (e: DropEvent) => void) => {
			if (webview.fail) throw webview.fail;
			webview.handler = h;
			return () => void webview.unlistened++;
		},
	}),
}));

const internals = window as unknown as { __TAURI_INTERNALS__?: object };
beforeEach(() => Object.assign(webview, { handler: undefined, unlistened: 0, fail: undefined }));
afterEach(() => {
	delete internals.__TAURI_INTERNALS__;
	vi.unstubAllGlobals();
});

const base: ManagerState = { status: 'connected', sessions: [], repos: [], reposListed: true, creating: false, focused: true };

// The sidebar is the box 0-200 by 0-600.
function fakes(selected: number | undefined = 3, active: string | undefined = 'session:3') {
	const store = writable<ManagerState>({ ...base, selected });
	const manager = { subscribe: store.subscribe, addRepo: vi.fn(), report: vi.fn() };
	const view = { sendInput: vi.fn() };
	const tabs = { active, selectedView: vi.fn(() => (selected === undefined ? undefined : view)), show: vi.fn(async () => {}) };
	const aside = { getBoundingClientRect: () => ({ left: 0, right: 200, top: 0, bottom: 600 }) } as HTMLElement;
	const deps = { manager, tabs, sidebar: () => aside } as unknown as DropDeps;
	return { manager, view, tabs, deps };
}

const settle = () => new Promise((r) => setTimeout(r));

describe('dropped', () => {
	it('adds every path dropped on the sidebar as a repo and types nothing', () => {
		const f = fakes();
		dropped(['/tmp/a', '/tmp/b'], { x: 100, y: 300 }, f.deps);
		expect(f.manager.addRepo.mock.calls).toEqual([['/tmp/a'], ['/tmp/b']]);
		expect(f.view.sendInput).not.toHaveBeenCalled();
		expect(f.tabs.show).not.toHaveBeenCalled();
	});

	it("types the quoted paths into the selected session elsewhere, its tab already shown", () => {
		const f = fakes();
		dropped(['/tmp/a b.txt', '/tmp/c'], { x: 200, y: 300 }, f.deps);
		expect(f.view.sendInput).toHaveBeenCalledWith("'/tmp/a b.txt' '/tmp/c' ");
		expect(f.tabs.show).not.toHaveBeenCalled();
		expect(f.manager.addRepo).not.toHaveBeenCalled();
	});

	it("shows the session's tab when another shows", () => {
		const f = fakes(3, '/tmp/repo/README.md');
		dropped(['/tmp/c'], { x: 500, y: 300 }, f.deps);
		expect(f.tabs.show).toHaveBeenCalledWith('session:3');
		expect(f.view.sendInput).toHaveBeenCalledWith("'/tmp/c' ");
	});

	it('does nothing with no session selected', () => {
		const f = fakes(undefined, undefined);
		dropped(['/tmp/c'], { x: 500, y: 300 }, f.deps);
		expect(f.tabs.show).not.toHaveBeenCalled();
		expect(f.manager.addRepo).not.toHaveBeenCalled();
		expect(f.manager.report).not.toHaveBeenCalled();
	});

	it('reports a path with a control character and types nothing', () => {
		const f = fakes();
		dropped(['/tmp/ok', '/tmp/a\nb'], { x: 500, y: 300 }, f.deps);
		expect(f.view.sendInput).not.toHaveBeenCalled();
		expect(f.manager.report).toHaveBeenCalledWith('file drop refused: path with a control character: "/tmp/a\\nb"');
	});
});

describe('watchFileDrop', () => {
	it('listens to nothing outside Tauri', async () => {
		const f = fakes();
		const stop = watchFileDrop(f.deps.manager, f.deps.tabs, f.deps.sidebar);
		await settle();
		expect(webview.handler).toBeUndefined();
		stop();
	});

	it('inside Tauri takes drops at their logical position until stopped', async () => {
		internals.__TAURI_INTERNALS__ = {};
		vi.stubGlobal('devicePixelRatio', 2);
		const f = fakes();
		const stop = watchFileDrop(f.deps.manager, f.deps.tabs, f.deps.sidebar);
		await settle();
		// 300 physical pixels across is 150 logical ones, inside the sidebar.
		const at = (x: number, y: number) => ({ toLogical: (s: number) => ({ x: x / s, y: y / s }) });
		webview.handler!({ payload: { type: 'over', position: at(300, 300) } });
		webview.handler!({ payload: { type: 'drop', paths: ['/tmp/a'], position: at(300, 300) } });
		expect(f.manager.addRepo).toHaveBeenCalledWith('/tmp/a');
		webview.handler!({ payload: { type: 'drop', paths: ['/tmp/c'], position: at(500, 300) } });
		expect(f.view.sendInput).toHaveBeenCalledWith("'/tmp/c' ");
		expect(f.manager.addRepo).toHaveBeenCalledTimes(1);
		stop();
		await settle();
		expect(webview.unlistened).toBe(1);
	});

	it('inside Tauri reports a drop it cannot listen to', async () => {
		internals.__TAURI_INTERNALS__ = {};
		webview.fail = new Error('no webview');
		const f = fakes();
		const stop = watchFileDrop(f.deps.manager, f.deps.tabs, f.deps.sidebar);
		await settle();
		expect(f.manager.report).toHaveBeenCalledWith('file drop unavailable: no webview');
		stop();
		await settle();
	});
});
