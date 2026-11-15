// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { writable } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP, type AppContext } from './app-context';
import type { AppUpdateState } from './app-update';
import type { DaemonUpdate } from './daemon-update';
import type { ManagerState } from './manager';
import { info } from './manager-harness';
import Notices from './Notices.svelte';

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;

afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target.remove();
	vi.restoreAllMocks();
});

const base: ManagerState = { status: 'connected', sessions: [], repos: [], reposListed: true, creating: false, focused: true };
const update: DaemonUpdate = { daemon: 'aaaaaaa', app: 'bbbbbbb' };
const rows = (states: string[]) => states.map((s, i) => ({ info: info(i + 1, 'i', s), ro: false, reports: 0, resets: 0 }));

// The manager and the updater as stores, as $manager and $updater read them.
function show(state: Partial<ManagerState> = {}, app: AppUpdateState = { installing: false }) {
	const managerStore = writable<ManagerState>({ ...base, ...state });
	const manager = { subscribe: managerStore.subscribe, restartDaemon: vi.fn(), report: vi.fn() };
	const updaterStore = writable<AppUpdateState>(app);
	const updater = { subscribe: updaterStore.subscribe, dismiss: vi.fn() };
	const startup = { updater, install: vi.fn() };
	const ctx = { manager, tabs: {}, layout: {}, startup } as unknown as AppContext;
	target = document.createElement('div');
	document.body.append(target);
	shown = mount(Notices, { target, context: new Map([[APP, ctx]]) });
	flushSync();
	const set = (s: Partial<ManagerState>) => {
		managerStore.update((old) => ({ ...old, ...s }));
		flushSync();
	};
	const setApp = (s: AppUpdateState) => {
		updaterStore.set(s);
		flushSync();
	};
	return { manager, updater, startup, set, setApp };
}

const notices = () => [...target.querySelectorAll('.notices .notice')];
const button = (text: string) => [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const notNow = (n: Element) => n.querySelector<HTMLButtonElement>('button[aria-label="Not now"]')!;

describe('Notices', () => {
	it('shows nothing with no app update and no daemon update', () => {
		show();
		expect(target.querySelector('.notices')).not.toBeNull();
		expect(notices()).toHaveLength(0);
	});

	it('shows the app notice only with a version; Update installs, Not now dismisses', () => {
		const { startup, updater, setApp } = show();
		setApp({ version: '9.9.9', installing: false });
		expect(notices()).toHaveLength(1);
		expect(target.textContent).toContain('vaquita 9.9.9 is available.');
		button('Update').click();
		expect(startup.install).toHaveBeenCalledTimes(1);
		notNow(notices()[0]).click();
		expect(updater.dismiss).toHaveBeenCalledTimes(1);
		setApp({ installing: false });
		expect(notices()).toHaveLength(0);
	});

	it('passes installing and the error to the app notice', () => {
		const { setApp } = show({}, { version: '9.9.9', installing: true });
		expect(target.textContent).toContain('Updating to 9.9.9…');
		expect(button('Update').disabled).toBe(true);
		setApp({ version: '9.9.9', installing: false, error: 'no space' });
		expect(target.textContent).toContain('Update to 9.9.9 failed: no space');
	});

	it('shows the daemon notice only with an update while connected, with the running count', () => {
		const { set } = show({ update, status: 'disconnected', sessions: rows(['running', 'exited', 'running']) });
		expect(notices()).toHaveLength(0);
		set({ status: 'connected' });
		expect(notices()).toHaveLength(1);
		expect(target.textContent).toContain('2 running sessions will end');
		set({ update: undefined });
		expect(notices()).toHaveLength(0);
	});

	it('restarts the daemon on the confirmed Restart', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const { manager } = show({ update });
		button('Restart daemon').click();
		flushSync();
		expect(manager.restartDaemon).not.toHaveBeenCalled();
		now = 1000;
		button('Confirm restart?').click();
		expect(manager.restartDaemon).toHaveBeenCalledTimes(1);
	});

	it('keeps the daemon notice closed through later publishes', () => {
		const { set } = show({ update });
		notNow(notices()[0]).click();
		flushSync();
		expect(notices()).toHaveLength(0);
		set({ update: { ...update, note: 'still old' }, sessions: rows(['running']) });
		set({ status: 'disconnected' });
		set({ status: 'connected' });
		expect(notices()).toHaveLength(0);
	});
});
