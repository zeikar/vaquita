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
	const report = vi.fn();
	const updater = new AppUpdater({ check, install, warn, report });
	let state: AppUpdateState = { installing: false };
	updater.subscribe((s) => (state = s));
	return { updater, check, install, warn, report, state: () => state };
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

	it('lets a check in flight finish before installing, so the bar names what is installed', async () => {
		const t = setup([{ version: '0.2.0' }]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		let answer: (u: AppUpdate) => void = () => {};
		t.check.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
		t.install.mockImplementationOnce(() => new Promise(() => {}));
		await at(CHECK_INTERVAL_MS);
		void t.updater.install();
		await at(0);
		expect(t.install).not.toHaveBeenCalled();
		answer({ version: '0.3.0' });
		await at(0);
		expect(t.install).toHaveBeenCalledTimes(1);
		t.updater.dismiss();
		expect(t.state()).toEqual({ version: '0.3.0', installing: true, error: undefined });
	});

	it('installs nothing when the check it waited for found no update', async () => {
		const t = setup([{ version: '0.2.0' }]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		let answer: (u: AppUpdate | null) => void = () => {};
		t.check.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
		await at(CHECK_INTERVAL_MS);
		const installing = t.updater.install();
		answer(null);
		await installing;
		expect(t.install).not.toHaveBeenCalled();
		expect(t.state()).toEqual({ installing: false });
	});
});

describe('AppUpdater checkNow', () => {
	it('checks at once and says when there is nothing newer, keeping the timed chain', async () => {
		const t = setup([null]);
		t.updater.start();
		await t.updater.checkNow();
		expect(t.check).toHaveBeenCalledTimes(1);
		expect(t.report).toHaveBeenCalledWith('vaquita is up to date');
		await at(FIRST_CHECK_MS);
		expect(t.check).toHaveBeenCalledTimes(2);
		expect(t.report).toHaveBeenCalledTimes(1);
	});

	it('reports a failed check instead of only warning', async () => {
		const t = setup([new Error('offline')]);
		await t.updater.checkNow();
		expect(t.report).toHaveBeenCalledWith('update check failed: offline');
		expect(t.warn).not.toHaveBeenCalled();
	});

	it('shows again a version the bar was closed for', async () => {
		const t = setup([{ version: '0.2.0' }, { version: '0.2.0' }]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		t.updater.dismiss();
		expect(t.state().version).toBeUndefined();
		await t.updater.checkNow();
		expect(t.state()).toEqual({ version: '0.2.0', installing: false });
		expect(t.report).not.toHaveBeenCalled();
	});

	it('runs one check at a time, so an install waits for a timed check a manual one ran into', async () => {
		const t = setup();
		const answers: Array<(u: AppUpdate) => void> = [];
		t.check.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
		t.install.mockImplementation(() => new Promise(() => {}));
		t.updater.start();
		const asked = t.updater.checkNow();
		await at(FIRST_CHECK_MS);
		expect(t.check).toHaveBeenCalledTimes(1);
		answers[0]({ version: '0.2.0' });
		await asked;
		await at(0);
		expect(t.check).toHaveBeenCalledTimes(2);
		void t.updater.install();
		await at(0);
		expect(t.install).not.toHaveBeenCalled();
		answers[1]({ version: '0.3.0' });
		await at(0);
		expect(t.install).toHaveBeenCalledTimes(1);
		expect(t.state()).toEqual({ version: '0.3.0', installing: true, error: undefined });
	});

	it('does nothing while installing', async () => {
		const t = setup([{ version: '0.2.0' }]);
		t.updater.start();
		await at(FIRST_CHECK_MS);
		t.install.mockImplementationOnce(() => new Promise(() => {}));
		void t.updater.install();
		await at(0);
		await t.updater.checkNow();
		expect(t.check).toHaveBeenCalledTimes(1);
	});
});

describe('releaseUrl', () => {
	it('points at the release tag', () => {
		expect(releaseUrl('0.2.0')).toBe('https://github.com/zeikar/vaquita/releases/tag/v0.2.0');
	});
});
