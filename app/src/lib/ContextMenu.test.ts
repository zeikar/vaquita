// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContextMenu from './ContextMenu.svelte';
import type { MenuAt, MenuItem } from './menu';

let target: HTMLElement;
let list: HTMLElement;
let opener: HTMLButtonElement;
let app: ReturnType<typeof mount> | undefined;

// Opened from a focused button in a list, as a menu button or a row would be.
function show(items: MenuItem[], at: MenuAt = { x: 10, y: 20 }) {
	list = document.createElement('div');
	opener = document.createElement('button');
	list.append(opener);
	document.body.append(list);
	opener.focus();
	target = document.createElement('div');
	document.body.append(target);
	const onclose = vi.fn();
	app = mount(ContextMenu, { target, props: { at, items, onclose } });
	flushSync();
	return onclose;
}

const menu = () => target.querySelector<HTMLElement>('[role="menu"]')!;
const entries = () => [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const labels = () => entries().map((b) => b.textContent?.trim());

function press(k: string) {
	(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
	flushSync();
}

function click(el: HTMLElement) {
	el.click();
	flushSync();
}

const three = (): MenuItem[] => [
	{ label: 'Rename', run: vi.fn() },
	{ label: 'Copy path', run: vi.fn() },
	{ label: 'Kill', run: vi.fn(), danger: true },
];

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	target?.remove();
	list?.remove();
	vi.restoreAllMocks();
});

describe('ContextMenu', () => {
	it('is a menu of menu items, with disabled and danger ones marked', () => {
		show([
			{ label: 'Rename', run: vi.fn() },
			{ label: 'Copy path', run: vi.fn(), disabled: true },
			{ label: 'Kill', run: vi.fn(), danger: true },
		]);
		expect(menu()).not.toBeNull();
		expect(labels()).toEqual(['Rename', 'Copy path', 'Kill']);
		expect(entries().map((b) => b.getAttribute('aria-disabled'))).toEqual([null, 'true', null]);
		expect(entries().map((b) => b.classList.contains('danger'))).toEqual([false, false, true]);
	});

	it('focuses the first enabled item when it opens', () => {
		const onclose = show([
			{ label: 'Copy path', run: vi.fn(), disabled: true },
			{ label: 'Rename', run: vi.fn() },
		]);
		expect(document.activeElement).toBe(entries()[1]);
		// Focus leaving the opener is no window blur.
		expect(onclose).not.toHaveBeenCalled();
	});

	it('moves with the arrow keys, wrapping around, and skips disabled items', () => {
		show([
			{ label: 'Rename', run: vi.fn() },
			{ label: 'Copy path', run: vi.fn(), disabled: true },
			{ label: 'Reveal in Finder', run: vi.fn() },
			{ label: 'Kill', run: vi.fn() },
		]);
		const [rename, , reveal, kill] = entries();
		press('ArrowDown');
		expect(document.activeElement).toBe(reveal);
		press('ArrowDown');
		expect(document.activeElement).toBe(kill);
		press('ArrowDown');
		expect(document.activeElement).toBe(rename);
		press('ArrowUp');
		expect(document.activeElement).toBe(kill);
		press('ArrowUp');
		expect(document.activeElement).toBe(reveal);
	});

	it('jumps to the first and last items with Home and End', () => {
		show(three());
		const [rename, , kill] = entries();
		press('End');
		expect(document.activeElement).toBe(kill);
		press('Home');
		expect(document.activeElement).toBe(rename);
	});

	it('focuses an enabled item under the pointer, so only one row is lit', () => {
		show([
			{ label: 'Rename', run: vi.fn() },
			{ label: 'Copy path', run: vi.fn(), disabled: true },
			{ label: 'Kill', run: vi.fn() },
		]);
		const [rename, copy, kill] = entries();
		kill.dispatchEvent(new PointerEvent('pointerenter'));
		expect(document.activeElement).toBe(kill);
		copy.dispatchEvent(new PointerEvent('pointerenter'));
		expect(document.activeElement).toBe(kill);
		rename.dispatchEvent(new PointerEvent('pointerenter'));
		expect(document.activeElement).toBe(rename);
	});

	it('runs the focused item on its click and closes', () => {
		const items = three();
		const onclose = show(items);
		press('ArrowDown');
		click(document.activeElement as HTMLElement);
		expect(items[1].run).toHaveBeenCalledTimes(1);
		expect(items[0].run).not.toHaveBeenCalled();
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('closes on Escape and gives the focus back to the opener', () => {
		const onclose = show(three());
		press('Escape');
		expect(onclose).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(opener);
	});

	it('closes on Tab with the focus back on the opener, so Tab goes on from there', () => {
		const onclose = show(three());
		press('Tab');
		expect(onclose).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(opener);
	});

	it('gives the focus back to the opener after an item ran', () => {
		show(three());
		click(entries()[0]);
		expect(document.activeElement).toBe(opener);
	});

	it('leaves the focus alone when the opener has left the document', () => {
		const onclose = show(three());
		opener.remove();
		press('Escape');
		expect(onclose).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(entries()[0]);
	});

	it('closes on a pointerdown outside it, not on one inside', () => {
		const onclose = show(three());
		entries()[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(onclose).not.toHaveBeenCalled();
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('closes when the window loses the focus', () => {
		const onclose = show(three());
		window.dispatchEvent(new Event('blur'));
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('closes on a scroll of what holds its opener', () => {
		const onclose = show(three());
		// A scroll does not bubble; the listener catches it on the way down.
		list.dispatchEvent(new Event('scroll'));
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('closes on a scroll of the page', () => {
		const onclose = show(three());
		document.dispatchEvent(new Event('scroll'));
		window.dispatchEvent(new Event('scroll'));
		expect(onclose).toHaveBeenCalledTimes(2);
	});

	it('stays open on a scroll elsewhere, such as a terminal printing output', () => {
		const onclose = show(three());
		const term = document.createElement('div');
		document.body.append(term);
		term.dispatchEvent(new Event('scroll'));
		term.remove();
		expect(onclose).not.toHaveBeenCalled();
	});

	it('closes on a resize', () => {
		const onclose = show(three());
		window.dispatchEvent(new Event('resize'));
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('stops listening once it is gone', () => {
		const onclose = show(three());
		unmount(app!);
		app = undefined;
		window.dispatchEvent(new Event('blur'));
		window.dispatchEvent(new Event('resize'));
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(onclose).not.toHaveBeenCalled();
	});

	it('arms a confirm item on the first click and runs it on a second one', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const kill = vi.fn();
		const onclose = show([
			{ label: 'Rename', run: vi.fn() },
			{ label: 'Kill', run: kill, danger: true, confirm: true },
		]);
		click(entries()[1]);
		expect(labels()).toEqual(['Rename', 'Confirm kill?']);
		expect(entries()[1].classList.contains('armed')).toBe(true);
		expect(kill).not.toHaveBeenCalled();
		expect(onclose).not.toHaveBeenCalled();
		expect(menu()).not.toBeNull();
		now = 400;
		click(entries()[1]);
		expect(kill).toHaveBeenCalledTimes(1);
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it('does not take a double-click as the confirmation', () => {
		let now = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		const kill = vi.fn();
		const onclose = show([{ label: 'Kill', run: kill, confirm: true }]);
		click(entries()[0]);
		now = 100;
		click(entries()[0]);
		expect(kill).not.toHaveBeenCalled();
		expect(onclose).not.toHaveBeenCalled();
	});

	it('never runs a disabled item, nor closes for one', () => {
		const run = vi.fn();
		const onclose = show([
			{ label: 'Rename', run: vi.fn() },
			{ label: 'Copy path', run, disabled: true },
		]);
		click(entries()[1]);
		expect(run).not.toHaveBeenCalled();
		expect(onclose).not.toHaveBeenCalled();
	});

	it('shifts itself into the viewport', () => {
		// happy-dom lays nothing out; the window is 1024 x 768.
		vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(160);
		vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
		show(three(), { x: 1000, y: 700 });
		expect(menu().style.left).toBe('860px');
		expect(menu().style.top).toBe('664px');
	});

	it('stays where it was opened when it fits', () => {
		show(three(), { x: 10, y: 20 });
		expect(menu().style.left).toBe('10px');
		expect(menu().style.top).toBe('20px');
	});
});
