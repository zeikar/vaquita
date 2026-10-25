// @vitest-environment happy-dom
import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppUpdateBanner from './AppUpdateBanner.svelte';

let target: HTMLElement;
let app: ReturnType<typeof mount> | undefined;

function show(props: { installing?: boolean; error?: string; oninstall?: () => void; ondismiss?: () => void; onnotes?: () => void } = {}) {
	target = document.createElement('div');
	document.body.append(target);
	app = mount(AppUpdateBanner, {
		target,
		props: { version: '0.2.0', installing: false, oninstall: () => {}, ondismiss: () => {}, onnotes: () => {}, ...props },
	});
	return target;
}

const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')];
const named = (el: HTMLElement, name: string) => buttons(el).find((b) => (b.title || b.textContent?.trim()) === name)!;

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	target?.remove();
});

describe('AppUpdateBanner', () => {
	it('announces the version, and that sessions survive the relaunch', () => {
		const el = show();
		expect(el.querySelector('.text')?.textContent).toBe('vaquita 0.2.0 is available.');
		expect(el.querySelector('.sub')?.textContent).toBe('It relaunches; your sessions keep running.');
	});

	it('leaves the note out next to an error', () => {
		expect(show({ error: 'no network' }).querySelector('.sub')).toBeNull();
	});

	it('says it is updating while installing', () => {
		expect(show({ installing: true }).querySelector('span')?.textContent).toBe('Updating to 0.2.0…');
	});

	it('says why a failed update failed', () => {
		expect(show({ error: 'no network' }).querySelector('span')?.textContent).toBe('Update to 0.2.0 failed: no network');
	});

	it('takes the shared bar look from app.css', () => {
		const el = show();
		expect(el.querySelector('[role="status"]')?.classList.contains('notice')).toBe(true);
		expect(named(el, 'Update').classList.contains('primary')).toBe(true);
		expect(named(el, 'Not now').classList.contains('icon-btn')).toBe(true);
	});

	it('installs on Update', () => {
		const oninstall = vi.fn();
		named(show({ oninstall }), 'Update').click();
		expect(oninstall).toHaveBeenCalledTimes(1);
	});

	it('offers Retry after an error', () => {
		const oninstall = vi.fn();
		const el = show({ error: 'no network', oninstall });
		expect(buttons(el).some((b) => b.textContent?.trim() === 'Update')).toBe(false);
		named(el, 'Retry').click();
		expect(oninstall).toHaveBeenCalledTimes(1);
	});

	it('opens the notes on What\'s new', () => {
		const onnotes = vi.fn();
		named(show({ onnotes }), "What's new").click();
		expect(onnotes).toHaveBeenCalledTimes(1);
	});

	it('dismisses on Not now', () => {
		const ondismiss = vi.fn();
		named(show({ ondismiss }), 'Not now').click();
		expect(ondismiss).toHaveBeenCalledTimes(1);
	});

	it('disables every button while installing', () => {
		const bs = buttons(show({ installing: true }));
		expect(bs).toHaveLength(3);
		expect(bs.every((b) => b.disabled)).toBe(true);
	});
});
