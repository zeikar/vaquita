import { getVersion } from '@tauri-apps/api/app';
import { homeDir } from '@tauri-apps/api/path';
import { get } from 'svelte/store';
import { AppUpdater } from './app-update';
import { checkAppUpdate, installAppUpdate, onUpdateCheckAsked } from './endpoint';
import type { SessionManager } from './manager';
import type { Tabs } from './tabs.svelte';
import { isTauri } from './tauri';

export type StartupDeps = {
	manager: Pick<SessionManager, 'report'>;
	tabs: Pick<Tabs, 'mayLoseAll'>;
};

// What the app sets up once it starts and undoes when it goes, beside the
// manager and the tabs: the app's own update, and what it reads of the system.
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

	private readonly tabs: Pick<Tabs, 'mayLoseAll'>;
	private readonly stops: (() => void)[];

	constructor({ manager, tabs }: StartupDeps) {
		this.tabs = tabs;
		this.updater = new AppUpdater({
			check: checkAppUpdate,
			install: installAppUpdate,
			warn: (m) => console.warn(m),
			report: (m, tone) => manager.report(m, tone),
		});
		this.updater.start();
		const unlistenCheck = onUpdateCheckAsked(() => void this.updater.checkNow());
		unlistenCheck.catch((e) => manager.report(`Check for Updates unavailable: ${e instanceof Error ? e.message : String(e)}`));
		this.stops = [() => this.updater.stop(), () => void unlistenCheck.then((f) => f(), () => {})];

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

	stop(): void {
		for (const stop of this.stops) stop();
	}
}
