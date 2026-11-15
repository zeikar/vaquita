import { getVersion } from '@tauri-apps/api/app';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { get } from 'svelte/store';
import { AppUpdater } from './app-update';
import { checkAppUpdate, installAppUpdate, onUpdateCheckAsked } from './endpoint';
import { watchFocus } from './focus';
import type { SessionManager } from './manager';
import type { Notifier, Target } from './notify';
import type { Tabs } from './tabs.svelte';
import { isTauri } from './tauri';
import { createTauriNotifier } from './tauri-notify';

export type StartupDeps = {
	manager: Pick<SessionManager, 'report' | 'start' | 'stop' | 'setFocused'>;
	tabs: Pick<Tabs, 'mayLoseAll' | 'openNotified'>;
	// Given the Tauri notifier once it is ready, before the manager starts.
	useNotifier: (n: Notifier) => void;
};

// What the app sets up once it starts and undoes when it goes, beside the
// manager and the tabs: the manager's start, the window's close request and
// focus, the app's own update, and what it reads of the system.
export class Startup {
	// Rows show paths under it with ~; in a plain browser it stays unknown and
	// paths absolute, as a guess could show another user's folder as home.
	home = $state<string>();
	// For the app welcome's corner; unknown in a plain browser, as home is.
	version = $state<string>();
	// The install ends in an exit, which no close request precedes. Editing is
	// frozen before the question and until the install fails or is declined, so
	// that nothing typed meanwhile is lost to the exit.
	updating = $state(false);
	readonly updater: AppUpdater;

	private readonly manager: StartupDeps['manager'];
	private readonly tabs: StartupDeps['tabs'];
	private readonly stops: (() => void)[] = [];
	private stopped = false;

	constructor({ manager, tabs, useNotifier }: StartupDeps) {
		this.manager = manager;
		this.tabs = tabs;

		// Every way of closing the window but ⌘Q comes here: its close button, ⌘W
		// and the menu. With a listener, Tauri leaves the closing to it.
		if (isTauri()) {
			const unlisten = getCurrentWindow().onCloseRequested(async (e) => {
				if (!(await tabs.mayLoseAll('Close the window?', 'Close'))) e.preventDefault();
			});
			unlisten.catch((e) => manager.report(`asking before closing unavailable: ${e instanceof Error ? e.message : String(e)}`));
			this.stops.push(() => void unlisten.then((f) => f(), () => {}));
		}

		this.stops.push(
			() => manager.stop(),
			watchFocus(
				(focused) => manager.setFocused(focused),
				(e) => manager.report(`window focus unavailable: ${e instanceof Error ? e.message : String(e)}`),
			),
		);

		this.updater = new AppUpdater({
			check: checkAppUpdate,
			install: installAppUpdate,
			warn: (m) => console.warn(m),
			report: (m, tone) => manager.report(m, tone),
		});
		this.updater.start();
		const unlistenCheck = onUpdateCheckAsked(() => void this.updater.checkNow());
		unlistenCheck.catch((e) => manager.report(`Check for Updates unavailable: ${e instanceof Error ? e.message : String(e)}`));
		this.stops.push(() => this.updater.stop(), () => void unlistenCheck.then((f) => f(), () => {}));

		// The manager starts once the notifier is set up, so the notifications it
		// sends on connecting, such as the missed summary, do not go to the console.
		const tauriNotifier = isTauri()
			? createTauriNotifier(this.openNotified, (e) => manager.report(`notification failed: ${e instanceof Error ? e.message : String(e)}`))
			: undefined;
		this.stops.push(() => void tauriNotifier?.then((n) => n.stop()).catch(() => {}));
		void Promise.resolve(tauriNotifier)
			.then(
				(n) => {
					if (n) useNotifier(n);
					return n?.allowed === false ? 'notifications are turned off for vaquita in System Settings' : undefined;
				},
				(e) => `notifications unavailable: ${e instanceof Error ? e.message : String(e)}`,
			)
			.then((failure) => {
				if (this.stopped) return;
				manager.start();
				if (failure) manager.report(failure);
			});

		if (isTauri()) {
			homeDir().then(
				(h) => (this.home = h),
				(e) => manager.report(`home folder unavailable: ${e instanceof Error ? e.message : String(e)}`),
			);
			getVersion().then(
				(v) => (this.version = v),
				(e) => manager.report(`app version unavailable: ${e instanceof Error ? e.message : String(e)}`),
			);
		}
	}

	install = async (): Promise<void> => {
		if (this.updating) return;
		this.updating = true;
		if (await this.tabs.mayLoseAll('Update and relaunch?', 'Update')) await this.updater.install();
		// A successful install leaves the app on its way out, still installing.
		this.updating = get(this.updater).installing;
	};

	// A click brings the window up whatever the notification was about.
	private openNotified = (target?: Target): void => {
		this.tabs.openNotified(target);
		const win = getCurrentWindow();
		win.show()
			.then(() => win.unminimize())
			.then(() => win.setFocus())
			.catch((e) => this.manager.report(`bringing the window up failed: ${e instanceof Error ? e.message : String(e)}`));
	};

	stop(): void {
		this.stopped = true;
		for (const stop of this.stops) stop();
	}
}
