import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppUpdater, CHECK_INTERVAL_MS, FIRST_CHECK_MS, releaseUrl, type AppUpdate, type AppUpdateState } from './app-update';

function setup(results: Array<AppUpdate | null | Error> = []) {
	const check = vi.fn(async () => {
		const r = results.shift() ?? null;
		if (r instanceof Error) throw r;
		return r;
	});
	const install = vi.fn(async () => {});
	const warn = vi.fn();
	const updater = new AppUpdater({ check, install, warn });
	let state: AppUpdateState = { installing: false };
	updater.subscribe((s) => (state = s));
	return { updater, check, install, warn, state: () => state };
}

const at = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AppUpdater checks', () => {
	it('checks first after FIRST_CHECK_MS, then every CHECK_INTERVAL_MS', async () => {
		const t = setup();
		t.updater.start();
		await at(FIRST_CHECK_MS - 1);
		expect(t.check).not.toHaveBeenCalled();
		await at(1);
		expect(t.check).toHaveBeenCalledTimes(1);
		await at(CHECK_INTERVAL_MS - 1);
		expect(t.check).toHaveBeenCalledTimes(1);
		await at(1);
		expect(t.check).toHaveBeenCalledTimes(2);
	});

	it('shows no bar for a null result, as a dev run or a build without a feed gives', async () => {
		const t = setup([null]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		expect(t.state().version).toBeUndefined();
	});

	it('publishes a version and clears it when a later check finds none', async () => {
		const t = setup([{ version: '0.2.0' }, null]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		expect(t.state()).toEqual({ version: '0.2.0', installing: false });
		await at(CHECK_INTERVAL_MS);
		expect(t.state().version).toBeUndefined();
	});

	it('warns on a rejected check and publishes nothing, then checks again', async () => {
		const t = setup([new Error('offline'), { version: '0.2.0' }]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		expect(t.warn).toHaveBeenCalledWith('update check failed: offline');
		expect(t.state()).toEqual({ installing: false });
		await at(CHECK_INTERVAL_MS);
		expect(t.state().version).toBe('0.2.0');
	});

	it('stop ends the chain, also when a check is in flight', async () => {
		const t = setup([null, null]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		t.updater.stop();
		await at(CHECK_INTERVAL_MS * 2);
		expect(t.check).toHaveBeenCalledTimes(1);

		const u = setup();
		let release!: () => void;
		u.check.mockImplementationOnce(() => new Promise((r) => (release = () => r(null))));
		u.updater.start();
		await at(FIRST_CHECK_MS);
		u.updater.stop();
		release();
		await at(CHECK_INTERVAL_MS * 2);
		expect(u.check).toHaveBeenCalledTimes(1);
	});
});

describe('AppUpdater dismiss', () => {
	it('hides that version on later checks until a different one arrives', async () => {
		const t = setup([{ version: '0.2.0' }, { version: '0.2.0' }, { version: '0.3.0' }]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		t.updater.dismiss();
		expect(t.state().version).toBeUndefined();
		await at(CHECK_INTERVAL_MS);
		expect(t.state().version).toBeUndefined();
		await at(CHECK_INTERVAL_MS);
		expect(t.state().version).toBe('0.3.0');
	});
});

describe('AppUpdater install', () => {
	it('sets installing, which stays set once the install resolves, and skips due checks', async () => {
		const t = setup([{ version: '0.2.0' }, { version: '0.3.0' }]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		await t.updater.install();
		expect(t.install).toHaveBeenCalledTimes(1);
		expect(t.state()).toEqual({ version: '0.2.0', installing: true });
		await at(CHECK_INTERVAL_MS);
		expect(t.check).toHaveBeenCalledTimes(1);
		// The chain goes on: a skipped check still schedules the next.
		await at(CHECK_INTERVAL_MS);
		expect(t.check).toHaveBeenCalledTimes(1);
		expect(t.state().version).toBe('0.2.0');
	});

	it('shows a rejection with installing false, and a second install calls the dep again', async () => {
		const t = setup([{ version: '0.2.0' }]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		t.install.mockRejectedValueOnce(new Error('disk full'));
		await t.updater.install();
		expect(t.state()).toEqual({ version: '0.2.0', installing: false, error: 'disk full' });
		await t.updater.install();
		expect(t.install).toHaveBeenCalledTimes(2);
		expect(t.state()).toEqual({ version: '0.2.0', installing: true, error: undefined });
	});

	it('clears the error when a check brings a different version, keeps it for the same one', async () => {
		const t = setup([{ version: '0.2.0' }, { version: '0.2.0' }, { version: '0.3.0' }]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		t.install.mockRejectedValueOnce(new Error('disk full'));
		await t.updater.install();
		await at(CHECK_INTERVAL_MS);
		expect(t.state().error).toBe('disk full');
		await at(CHECK_INTERVAL_MS);
		expect(t.state()).toEqual({ version: '0.3.0', installing: false });
	});

	it('drops a check that was in flight when the install began, and ignores dismiss meanwhile', async () => {
		const t = setup([{ version: '0.2.0' }]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		let answer: (u: AppUpdate) => void = () => {};
		t.check.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
		t.install.mockImplementationOnce(() => new Promise(() => {}));
		await at(CHECK_INTERVAL_MS);
		void t.updater.install();
		answer({ version: '0.3.0' });
		await at(0);
		t.updater.dismiss();
		expect(t.state()).toEqual({ version: '0.2.0', installing: true, error: undefined });
	});
});

describe('releaseUrl', () => {
	it('points at the release tag', () => {
		expect(releaseUrl('0.2.0')).toBe('https://github.com/zeikar/vaquita/releases/tag/v0.2.0');
	});
});
