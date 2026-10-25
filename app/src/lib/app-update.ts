export interface AppUpdate {
	version: string;
}

// After the daemon connection has settled, so the check does not compete with it.
export const FIRST_CHECK_MS = 15_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function releaseUrl(version: string): string {
	return `https://github.com/zeikar/vaquita/releases/tag/v${version}`;
}

// What the update bar shows: nothing while version is unset.
export interface AppUpdateState {
	version?: string;
	installing: boolean;
	// Why the last install failed; the bar then offers a retry.
	error?: string;
}

export interface AppUpdateDeps {
	check: () => Promise<AppUpdate | null>;
	install: () => Promise<void>;
	warn: (message: string) => void;
	// Shows what a check the user asked for found, in the status line.
	report: (message: string) => void;
}

export class AppUpdater {
	private state: AppUpdateState = { installing: false };
	private readonly subscribers = new Set<(s: AppUpdateState) => void>();
	private timer?: ReturnType<typeof setTimeout>;
	private running = false;
	// The version the user closed the bar for; asking again is for a newer one.
	private dismissed?: string;
	private checking?: Promise<void>;

	constructor(private readonly deps: AppUpdateDeps) {}

	subscribe = (run: (s: AppUpdateState) => void): (() => void) => {
		this.subscribers.add(run);
		run(this.state);
		return () => this.subscribers.delete(run);
	};

	// One timer chain: each check is scheduled once the previous one finished.
	start(): void {
		if (this.running) return;
		this.running = true;
		this.schedule(FIRST_CHECK_MS);
	}

	stop(): void {
		this.running = false;
		clearTimeout(this.timer);
	}

	async install(): Promise<void> {
		// A check in flight replaces the update the app holds for install, so
		// it is let finish first: the bar then names what Update installs.
		await this.checking;
		if (this.state.version === undefined || this.state.installing) return;
		this.set({ ...this.state, installing: true, error: undefined });
		try {
			await this.deps.install();
		} catch (e) {
			this.set({ ...this.state, installing: false, error: e instanceof Error ? e.message : String(e) });
		}
		// On success the app is restarting, so installing stays set.
	}

	// For the app menu's Check for Updates. Unlike the timed checks it says
	// what it found, and shows again a version the bar was closed for.
	async checkNow(): Promise<void> {
		await this.checking;
		if (this.state.installing) return;
		this.dismissed = undefined;
		this.checking = this.check(true);
		await this.checking;
		this.checking = undefined;
	}

	dismiss(): void {
		if (this.state.version === undefined || this.state.installing) return;
		this.dismissed = this.state.version;
		this.set({ installing: false });
	}

	private schedule(ms: number): void {
		this.timer = setTimeout(() => void this.tick(), ms);
	}

	private async tick(): Promise<void> {
		this.checking = this.check();
		await this.checking;
		this.checking = undefined;
		if (this.running) this.schedule(CHECK_INTERVAL_MS);
	}

	private async check(asked = false): Promise<void> {
		if (this.state.installing) return;
		let found: AppUpdate | null;
		try {
			found = await this.deps.check();
		} catch (e) {
			const message = `update check failed: ${e instanceof Error ? e.message : String(e)}`;
			// Offline is normal, so a timed check that fails shows nothing; the next one tries again.
			if (asked) this.deps.report(message);
			else this.deps.warn(message);
			return;
		}
		if (found === null) {
			if (asked) this.deps.report('vaquita is up to date');
			if (this.state.version !== undefined) this.set({ installing: false });
		} else if (found.version !== this.dismissed && found.version !== this.state.version) {
			// An earlier version's failure is not shown against this one; the same
			// version again leaves its error up.
			this.set({ version: found.version, installing: false });
		}
	}

	private set(next: AppUpdateState): void {
		this.state = next;
		for (const run of this.subscribers) run(next);
	}
}
