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

const internals = window as unknown as { __TAURI_INTERNALS__?: object };

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	endpoint.asked = undefined;
	endpoint.unlistened = 0;
});
afterEach(() => {
	vi.useRealTimers();
	delete internals.__TAURI_INTERNALS__;
});

function make(answer = true) {
	const manager = { report: vi.fn() };
	const tabs = { mayLoseAll: vi.fn(async (_question: string, _okLabel: string) => answer) };
	const startup = new Startup({ manager, tabs } as unknown as StartupDeps);
	return { manager, tabs, startup };
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
});
