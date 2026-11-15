// @vitest-environment happy-dom
// Named .svelte.test.ts so that the class's runes compile; in the client
// build, the one the app runs, as vitest makes the server one for node.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_CHECK_MS } from './app-update';
import { Startup, type StartupDeps } from './startup.svelte';

const endpoint = vi.hoisted(() => ({
	checkAppUpdate: vi.fn(async (): Promise<{ version: string } | null> => ({ version: '9.9.9' })),
	installAppUpdate: vi.fn(async (): Promise<void> => {}),
	asked: undefined as (() => void) | undefined,
	unlistened: 0,
	onUpdateCheckAsked: vi.fn(async (ask: () => void) => {
		endpoint.asked = ask;
		return () => void endpoint.unlistened++;
	}),
}));
vi.mock('./endpoint', () => endpoint);

const tauri = vi.hoisted(() => ({
	getVersion: vi.fn(async () => '0.1.30'),
	homeDir: vi.fn(async () => '/Users/example'),
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: tauri.getVersion }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: tauri.homeDir }));

// The window inside Tauri: its close request, its focus, and raising it.
const win = vi.hoisted(() => ({
	closeRequested: undefined as ((e: { preventDefault(): void }) => Promise<void>) | undefined,
	closeUnlistened: 0,
	focusUnlistened: 0,
	raised: [] as string[],
	async onCloseRequested(h: (e: { preventDefault(): void }) => Promise<void>) {
		win.closeRequested = h;
		return () => void win.closeUnlistened++;
	},
	async onFocusChanged() {
		return () => void win.focusUnlistened++;
	},
	isFocused: async () => true,
	show: async () => void win.raised.push('show'),
	unminimize: async () => void win.raised.push('unminimize'),
	setFocus: async () => void win.raised.push('setFocus'),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));

const notify = vi.hoisted(() => ({
	allowed: true,
	onClick: undefined as ((target?: { sid: number; inc: string }) => void) | undefined,
	stopped: 0,
	createTauriNotifier: vi.fn(async (onClick: (target?: { sid: number; inc: string }) => void) => {
		notify.onClick = onClick;
		return { allowed: notify.allowed, show: () => {}, stop: () => void notify.stopped++ };
	}),
}));
vi.mock('./tauri-notify', () => ({ createTauriNotifier: notify.createTauriNotifier }));

const internals = window as unknown as { __TAURI_INTERNALS__?: object };

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	endpoint.asked = undefined;
	endpoint.unlistened = 0;
	Object.assign(win, { closeRequested: undefined, closeUnlistened: 0, focusUnlistened: 0, raised: [] });
	Object.assign(notify, { allowed: true, onClick: undefined, stopped: 0 });
});
afterEach(() => {
	vi.useRealTimers();
	delete internals.__TAURI_INTERNALS__;
});

function make(answer = true) {
	const order: string[] = [];
	const manager = { report: vi.fn(), start: vi.fn(() => void order.push('start')), stop: vi.fn(), setFocused: vi.fn() };
	const tabs = { mayLoseAll: vi.fn(async (_question: string, _okLabel: string) => answer), openNotified: vi.fn() };
	const useNotifier = vi.fn(() => void order.push('notifier'));
	const startup = new Startup({ manager, tabs, useNotifier } as unknown as StartupDeps);
	return { manager, tabs, useNotifier, order, startup };
}

// The updater holds 9.9.9, as after the menu's Check for Updates.
async function offered(s: Startup) {
	await s.updater.checkNow();
}

const installing = (s: Startup) => {
	let v = false;
	s.updater.subscribe((st) => (v = st.installing))();
	return v;
};

describe('Startup', () => {
	it('installs nothing when the question is declined', async () => {
		const { tabs, startup } = make(false);
		await offered(startup);
		await startup.install();
		expect(tabs.mayLoseAll).toHaveBeenCalledWith('Update and relaunch?', 'Update');
		expect(endpoint.installAppUpdate).not.toHaveBeenCalled();
		expect(startup.updating).toBe(false);
	});

	it('installs once accepted, updating while the updater is installing', async () => {
		const { startup } = make();
		await offered(startup);
		await startup.install();
		expect(endpoint.installAppUpdate).toHaveBeenCalledTimes(1);
		expect(installing(startup)).toBe(true);
		expect(startup.updating).toBe(true);
	});

	it('is no longer updating once an install failed', async () => {
		endpoint.installAppUpdate.mockRejectedValueOnce(new Error('no space'));
		const { startup } = make();
		await offered(startup);
		await startup.install();
		expect(installing(startup)).toBe(false);
		expect(startup.updating).toBe(false);
	});

	it('does nothing on a second install while one runs', async () => {
		const { tabs, startup } = make();
		await offered(startup);
		let answer!: (v: boolean) => void;
		tabs.mayLoseAll.mockImplementationOnce(() => new Promise((r) => (answer = r)));
		const first = startup.install();
		expect(startup.updating).toBe(true);
		await startup.install();
		expect(tabs.mayLoseAll).toHaveBeenCalledTimes(1);
		answer(true);
		await first;
		expect(endpoint.installAppUpdate).toHaveBeenCalledTimes(1);
	});

	it('stops the timed checks on stop', async () => {
		const { startup } = make();
		await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
		expect(endpoint.checkAppUpdate).toHaveBeenCalledTimes(1);
		startup.stop();
		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
		expect(endpoint.checkAppUpdate).toHaveBeenCalledTimes(1);
	});

	it("checks on the menu's Check for Updates until stopped", async () => {
		const { startup } = make();
		await vi.advanceTimersByTimeAsync(0);
		endpoint.asked!();
		await vi.advanceTimersByTimeAsync(0);
		expect(endpoint.checkAppUpdate).toHaveBeenCalledTimes(1);
		startup.stop();
		await vi.advanceTimersByTimeAsync(0);
		expect(endpoint.unlistened).toBe(1);
	});

	it('reads no home and no version outside Tauri', async () => {
		const { startup } = make();
		await vi.advanceTimersByTimeAsync(0);
		expect(startup.home).toBeUndefined();
		expect(startup.version).toBeUndefined();
		expect(tauri.homeDir).not.toHaveBeenCalled();
		expect(tauri.getVersion).not.toHaveBeenCalled();
	});

	it('reads the home and the version inside Tauri, reporting a failure', async () => {
		internals.__TAURI_INTERNALS__ = {};
		const { startup } = make();
		await vi.advanceTimersByTimeAsync(0);
		expect(startup.home).toBe('/Users/example');
		expect(startup.version).toBe('0.1.30');

		tauri.homeDir.mockRejectedValueOnce(new Error('denied'));
		const { manager } = make();
		await vi.advanceTimersByTimeAsync(0);
		expect(manager.report).toHaveBeenCalledWith('home folder unavailable: denied');
	});

	it('starts the manager once the notifier step has settled, outside Tauri with no notifier', async () => {
		const { manager, useNotifier } = make();
		expect(manager.start).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(0);
		expect(manager.start).toHaveBeenCalledTimes(1);
		expect(useNotifier).not.toHaveBeenCalled();
		expect(notify.createTauriNotifier).not.toHaveBeenCalled();
		expect(manager.report).not.toHaveBeenCalled();
	});

	it('never starts the manager when stopped before', async () => {
		const { manager, startup } = make();
		startup.stop();
		await vi.advanceTimersByTimeAsync(0);
		expect(manager.start).not.toHaveBeenCalled();
	});

	it('passes page focus changes to the manager until stopped, and stops the manager', async () => {
		const { manager, startup } = make();
		expect(manager.setFocused).toHaveBeenLastCalledWith(document.hasFocus());
		window.dispatchEvent(new Event('blur'));
		expect(manager.setFocused).toHaveBeenLastCalledWith(false);
		window.dispatchEvent(new Event('focus'));
		expect(manager.setFocused).toHaveBeenLastCalledWith(true);
		const calls = manager.setFocused.mock.calls.length;
		startup.stop();
		expect(manager.stop).toHaveBeenCalledTimes(1);
		window.dispatchEvent(new Event('blur'));
		expect(manager.setFocused).toHaveBeenCalledTimes(calls);
	});

	it('inside Tauri hands the notifier over before the manager starts', async () => {
		internals.__TAURI_INTERNALS__ = {};
		const { manager, useNotifier, order } = make();
		await vi.advanceTimersByTimeAsync(0);
		expect(useNotifier).toHaveBeenCalledTimes(1);
		expect(order).toEqual(['notifier', 'start']);
		expect(manager.report).not.toHaveBeenCalled();
	});

	it('inside Tauri reports notifications turned off, or unavailable, once started', async () => {
		internals.__TAURI_INTERNALS__ = {};
		notify.allowed = false;
		const off = make();
		await vi.advanceTimersByTimeAsync(0);
		expect(off.manager.start).toHaveBeenCalledTimes(1);
		expect(off.manager.report).toHaveBeenCalledWith('notifications are turned off for vaquita in System Settings');

		notify.createTauriNotifier.mockRejectedValueOnce(new Error('no center'));
		const failed = make();
		await vi.advanceTimersByTimeAsync(0);
		expect(failed.useNotifier).not.toHaveBeenCalled();
		expect(failed.manager.start).toHaveBeenCalledTimes(1);
		expect(failed.manager.report).toHaveBeenCalledWith('notifications unavailable: no center');
	});

	it('inside Tauri shows the clicked notification and raises the window', async () => {
		internals.__TAURI_INTERNALS__ = {};
		const { tabs } = make();
		await vi.advanceTimersByTimeAsync(0);
		notify.onClick!({ sid: 3, inc: 'i' });
		await vi.advanceTimersByTimeAsync(0);
		expect(tabs.openNotified).toHaveBeenCalledWith({ sid: 3, inc: 'i' });
		expect(win.raised).toEqual(['show', 'unminimize', 'setFocus']);
	});

	it('inside Tauri keeps the window open while edits would be lost', async () => {
		internals.__TAURI_INTERNALS__ = {};
		const declined = make(false);
		await vi.advanceTimersByTimeAsync(0);
		const e = { preventDefault: vi.fn() };
		await win.closeRequested!(e);
		expect(declined.tabs.mayLoseAll).toHaveBeenCalledWith('Close the window?', 'Close');
		expect(e.preventDefault).toHaveBeenCalledTimes(1);

		make(true);
		await vi.advanceTimersByTimeAsync(0);
		const e2 = { preventDefault: vi.fn() };
		await win.closeRequested!(e2);
		expect(e2.preventDefault).not.toHaveBeenCalled();
	});

	it('inside Tauri undoes the listeners and the notifier on stop', async () => {
		internals.__TAURI_INTERNALS__ = {};
		const { startup } = make();
		await vi.advanceTimersByTimeAsync(0);
		startup.stop();
		await vi.advanceTimersByTimeAsync(0);
		expect(win.closeUnlistened).toBe(1);
		expect(win.focusUnlistened).toBe(1);
		expect(notify.stopped).toBe(1);
		expect(endpoint.unlistened).toBe(1);
	});
});
