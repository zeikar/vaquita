// @vitest-environment happy-dom
// happy-dom's showModal() only sets open and lays nothing out, so the dialog's
// rectangle is stubbed where a click's point matters; the platform's focus
// handling and the scrolling are left to a browser.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHORTCUTS } from './shortcut-list';
import ShortcutList from './ShortcutList.svelte';

let target: HTMLElement;
let app: ReturnType<typeof mount> | undefined;

function show() {
	const props = { onclose: vi.fn(), fallbackFocus: vi.fn() };
	target = document.createElement('div');
	document.body.append(target);
	app = mount(ShortcutList, { target, props });
	flushSync();
	return props;
}

function hide() {
	if (app) unmount(app);
	app = undefined;
	flushSync();
}

const dialog = () => target.querySelector('dialog')!;
const closeButton = () => target.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
const rows = () => [...target.querySelectorAll('li')];

function mouse(type: string, el: Element, at: { x: number; y: number }): MouseEvent {
	const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
	el.dispatchEvent(e);
	flushSync();
	return e;
}

const click = (el: Element, at: { x: number; y: number }) => mouse('click', el, at);

// A press and a release, the click going where the platform sends it.
function pressAndRelease(down: Element, downAt: { x: number; y: number }, up: Element, upAt: { x: number; y: number }) {
	mouse('mousedown', down, downAt);
	click(up, upAt);
}

function stubRect() {
	vi.spyOn(dialog(), 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 100, y: 50, width: 600, height: 400 }));
}

afterEach(() => {
	hide();
	target?.remove();
	vi.restoreAllMocks();
});

describe('ShortcutList', () => {
	it('opens as a modal once, titled for the checks, with the focus inside', () => {
		const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
		show();
		expect(showModal).toHaveBeenCalledTimes(1);
		expect(dialog().open).toBe(true);
		expect(dialog().getAttribute('aria-labelledby')).toBe('shortcuts-title');
		expect(target.querySelector('#shortcuts-title')?.textContent).toBe('Keyboard shortcuts');
		expect(dialog().contains(document.activeElement)).toBe(true);
	});

	it('shows every section and one row per entry of the list', () => {
		show();
		expect([...target.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(SHORTCUTS.map((s) => s.title));
		const entries = SHORTCUTS.flatMap((s) => s.entries);
		expect(rows().map((r) => r.querySelector('.does')?.textContent)).toEqual(entries.map((e) => e.does));
		const keys = [...target.querySelectorAll('kbd')].map((k) => k.textContent);
		expect(keys).toContain('⌥⌘↓');
		expect(keys).toContain('⌘⇧C');
		expect(keys).toContain('⌘-click');
	});

	it('shows a range as its first and last keys, and alternatives with or between them', () => {
		show();
		const row = (does: string) => rows().find((r) => r.querySelector('.does')?.textContent === does)!;
		expect(row('Show tab 1 to 9').querySelector('.keys')?.textContent).toBe('⌘1–⌘9');
		expect(row('Next tab').querySelector('.keys')?.textContent).toBe('⌃Tabor⌥⌘→or⌘⇧]');
	});

	it('calls onclose once on Escape, prevented so that no cancel follows', () => {
		const p = show();
		const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		document.activeElement!.dispatchEvent(e);
		flushSync();
		expect(e.defaultPrevented).toBe(true);
		expect(p.onclose).toHaveBeenCalledTimes(1);
	});

	it('routes the platform cancel to onclose, keeping the dialog', () => {
		const p = show();
		const e = new Event('cancel', { cancelable: true });
		dialog().dispatchEvent(e);
		expect(e.defaultPrevented).toBe(true);
		expect(p.onclose).toHaveBeenCalledTimes(1);
		expect(dialog().open).toBe(true);
	});

	it('calls onclose once from the close button, also at the point (0, 0) a key press gives', () => {
		const p = show();
		stubRect();
		closeButton().click();
		flushSync();
		expect(p.onclose).toHaveBeenCalledTimes(1);
		click(closeButton(), { x: 0, y: 0 });
		expect(p.onclose).toHaveBeenCalledTimes(2);
	});

	it('closes on a click on the backdrop, not on one inside it', () => {
		const p = show();
		stubRect();
		pressAndRelease(rows()[0], { x: 5, y: 5 }, rows()[0], { x: 5, y: 5 });
		pressAndRelease(dialog(), { x: 104, y: 250 }, dialog(), { x: 104, y: 250 });
		expect(p.onclose).not.toHaveBeenCalled();
		pressAndRelease(dialog(), { x: 5, y: 5 }, dialog(), { x: 5, y: 5 });
		expect(p.onclose).toHaveBeenCalledTimes(1);
	});

	it('stays open when a press inside it is released on the backdrop', () => {
		const p = show();
		stubRect();
		// The click of such a drag goes to the dialog, the two ends' common ancestor.
		pressAndRelease(rows()[0], { x: 300, y: 200 }, dialog(), { x: 5, y: 5 });
		pressAndRelease(dialog(), { x: 104, y: 250 }, dialog(), { x: 5, y: 5 });
		click(dialog(), { x: 5, y: 5 });
		expect(p.onclose).not.toHaveBeenCalled();
	});

	it('keeps the focus in the list on a press on its title or padding, not taking it from the button', () => {
		show();
		stubRect();
		const title = target.querySelector('#shortcuts-title')!;
		(document.activeElement as HTMLElement).blur();
		const e = mouse('mousedown', title, { x: 120, y: 60 });
		expect(e.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(target.querySelector('.scroller'));
		closeButton().focus();
		expect(mouse('mousedown', dialog(), { x: 104, y: 250 }).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(closeButton());
		// These take the focus themselves.
		expect(mouse('mousedown', closeButton(), { x: 680, y: 60 }).defaultPrevented).toBe(false);
		expect(mouse('mousedown', rows()[0], { x: 300, y: 200 }).defaultPrevented).toBe(false);
	});

	it('calls onclose when the platform closes it, and once only when it goes after an Escape', () => {
		let p = show();
		dialog().close();
		expect(p.onclose).toHaveBeenCalledTimes(1);
		hide();
		expect(p.onclose).toHaveBeenCalledTimes(1);
		target.remove();
		p = show();
		document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		hide();
		expect(p.onclose).toHaveBeenCalledTimes(1);
	});

	it('rings the scroller only once Tab moved through the list, until a press', () => {
		show();
		const scroller = target.querySelector('.scroller')!;
		const tab = () => {
			document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
			flushSync();
		};
		expect(document.activeElement).toBe(scroller);
		expect(scroller.classList.contains('tabbed')).toBe(false);
		tab();
		tab();
		expect(document.activeElement).toBe(scroller);
		expect(scroller.classList.contains('tabbed')).toBe(true);
		mouse('mousedown', rows()[0], { x: 300, y: 200 });
		expect(scroller.classList.contains('tabbed')).toBe(false);
	});

	it('keeps Tab inside', () => {
		show();
		const tab = () => {
			const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
			document.activeElement!.dispatchEvent(e);
			flushSync();
			expect(e.defaultPrevented).toBe(true);
			return document.activeElement;
		};
		const first = document.activeElement;
		expect(tab()).toBe(closeButton());
		expect(tab()).toBe(first);
	});

	it('gives the focus back on unmount to what had it at the mount', () => {
		const before = document.createElement('button');
		document.body.append(before);
		before.focus();
		const p = show();
		expect(document.activeElement).not.toBe(before);
		hide();
		expect(document.activeElement).toBe(before);
		expect(p.fallbackFocus).not.toHaveBeenCalled();
		before.remove();
	});

	it('falls back when what had the focus is gone', () => {
		const item = document.createElement('button');
		document.body.append(item);
		item.focus();
		const p = show();
		item.remove();
		hide();
		expect(p.fallbackFocus).toHaveBeenCalledTimes(1);
	});

	it('opens afresh on a second mount', () => {
		const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
		show();
		hide();
		target.remove();
		const p = show();
		expect(showModal).toHaveBeenCalledTimes(2);
		expect(dialog().open).toBe(true);
		expect(dialog().contains(document.activeElement)).toBe(true);
		expect(p.onclose).not.toHaveBeenCalled();
	});
});
