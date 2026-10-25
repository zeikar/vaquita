// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UpdateBanner from './UpdateBanner.svelte';

let target: HTMLElement;
let app: ReturnType<typeof mount> | undefined;

function show(props: { update: { daemon?: string; app: string; note?: string }; running: number; onrestart?: () => void; ondismiss?: () => void }) {
	target = document.createElement('div');
	document.body.append(target);
	app = mount(UpdateBanner, { target, props: { onrestart: () => {}, ondismiss: () => {}, ...props } });
	return target;
}

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	target?.remove();
	vi.restoreAllMocks();
});

describe('UpdateBanner', () => {
	it('names both builds and the sessions that would end', () => {
		const el = show({ update: { daemon: '0.1.0', app: '0.2.0' }, running: 2 });
		expect(el.querySelector('span')?.textContent).toBe(
			'vaquitad 0.1.0 is running; this app ships 0.2.0. Restart it to update — 2 running sessions will end and can be reopened.',
		);
	});

	it('names a daemon without a build as older, and shows the note', () => {
		const el = show({ update: { app: '0.2.0', note: 'still running after a restart' }, running: 0 });
		expect(el.querySelector('span')?.textContent).toBe(
			'An older vaquitad is running; this app ships 0.2.0. Restart it to update. (still running after a restart)',
		);
	});

	it('restarts on the confirming second click', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const onrestart = vi.fn();
		const el = show({ update: { daemon: '0.1.0', app: '0.2.0' }, running: 1, onrestart });
		const button = el.querySelector<HTMLButtonElement>('button.primary')!;
		button.click();
		flushSync();
		expect(button.textContent?.trim()).toBe('Confirm restart?');
		expect(onrestart).not.toHaveBeenCalled();
		now = 1000;
		button.click();
		flushSync();
		expect(onrestart).toHaveBeenCalledTimes(1);
		expect(button.textContent?.trim()).toBe('Restart daemon');
	});

	it('closes on Not now, leaving the daemon running', () => {
		const onrestart = vi.fn();
		const ondismiss = vi.fn();
		const el = show({ update: { daemon: '0.1.0', app: '0.2.0' }, running: 1, onrestart, ondismiss });
		el.querySelector<HTMLButtonElement>('button[title="Not now"]')!.click();
		flushSync();
		expect(ondismiss).toHaveBeenCalledTimes(1);
		expect(onrestart).not.toHaveBeenCalled();
	});
});
