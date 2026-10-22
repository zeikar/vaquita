// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchFocus } from './focus';

const win = vi.hoisted(() => ({
	// What the fake window's isFocused and its listener registration do.
	focused: async (): Promise<boolean> => true,
	listen: async (): Promise<void> => {},
	handler: undefined as ((e: { payload: boolean }) => void) | undefined,
	unlistened: false,
	isFocused() {
		return this.focused();
	},
	async onFocusChanged(h: (e: { payload: boolean }) => void) {
		await this.listen();
		this.handler = h;
		return async () => void (this.unlistened = true);
	},
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));

const settle = () => new Promise((r) => setTimeout(r));

describe('watchFocus in a browser', () => {
	it('reports the page focus at once and on focus and blur, until stopped', () => {
		const got: boolean[] = [];
		const stop = watchFocus((f) => got.push(f), () => {});
		window.dispatchEvent(new Event('blur'));
		window.dispatchEvent(new Event('focus'));
		stop();
		window.dispatchEvent(new Event('blur'));
		expect(got).toEqual([document.hasFocus(), false, true]);
	});
});

describe('watchFocus inside Tauri', () => {
	const internals = window as unknown as { __TAURI_INTERNALS__?: object };
	const got: boolean[] = [];
	const errors: unknown[] = [];
	const watch = () =>
		watchFocus(
			(f) => got.push(f),
			(e) => errors.push(e),
		);
	beforeEach(() => {
		internals.__TAURI_INTERNALS__ = {};
		got.length = errors.length = 0;
		win.focused = async () => true;
		win.listen = async () => {};
		win.handler = undefined;
		win.unlistened = false;
	});
	afterEach(() => {
		delete internals.__TAURI_INTERNALS__;
	});

	it('reports the window focus, then its changes, until stopped', async () => {
		win.focused = async () => false;
		const stop = watch();
		await settle();
		win.handler!({ payload: true });
		stop();
		await settle();
		expect(got).toEqual([false, true]);
		expect(win.unlistened).toBe(true);
		expect(errors).toEqual([]);
	});

	it('drops the window focus answer once a change was heard', async () => {
		let answer!: (f: boolean) => void;
		win.focused = () => new Promise((r) => (answer = r));
		watch();
		await settle();
		win.handler!({ payload: false });
		answer(true);
		await settle();
		expect(got).toEqual([false]);
	});

	it('removes the listener once it is in place when stopped before that', async () => {
		let listening!: () => void;
		win.listen = () => new Promise((r) => (listening = r));
		const stop = watch();
		stop();
		await settle();
		expect(win.unlistened).toBe(false);
		listening();
		await settle();
		expect(win.unlistened).toBe(true);
	});

	it('falls back to the page focus and reports when the window cannot be asked', async () => {
		const err = new Error('no isFocused');
		win.focused = async () => {
			throw err;
		};
		watch();
		await settle();
		expect(got).toEqual([document.hasFocus()]);
		expect(errors).toEqual([err]);
	});

	it('falls back to the page focus and reports when the window cannot be listened to', async () => {
		const err = new Error('no listen');
		win.listen = async () => {
			throw err;
		};
		const stop = watch();
		await settle();
		stop();
		await settle();
		expect(got).toEqual([document.hasFocus()]);
		expect(errors).toEqual([err]);
	});
});
