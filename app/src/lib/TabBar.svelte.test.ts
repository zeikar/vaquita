// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TabBar from './TabBar.svelte';

const opener = vi.hoisted(() => ({ revealItemInDir: vi.fn(async (_path: string) => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => opener);

let target: HTMLElement;
let bar: ReturnType<typeof mount> | undefined;

function show(tabs: string[], active?: string, preview?: string) {
	const props = $state({
		title: 'claude',
		tabs,
		active,
		preview,
		dirty: new SvelteSet<string>(),
		onselect: vi.fn(),
		onclose: vi.fn((_paths: string[]) => {}),
		onpin: vi.fn((_path: string) => {}),
		report: vi.fn(),
	});
	target = document.createElement('div');
	document.body.append(target);
	bar = mount(TabBar, { target, props });
	flushSync();
	return props;
}

afterEach(() => {
	if (bar) unmount(bar);
	bar = undefined;
	target?.remove();
});

const tabs = () => [...target.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const names = () => tabs().map((t) => t.textContent?.trim());
const selected = () => tabs().filter((t) => t.getAttribute('aria-selected') === 'true');

describe('TabBar', () => {
	it('shows the terminal tab, then the files by name with the path as their title', () => {
		show(['/tmp/repo/src/main.ts', '/tmp/repo/shot.png']);
		expect(target.querySelector('[role="tablist"]')).not.toBeNull();
		expect(names()).toEqual(['claude', 'main.ts', 'shot.png']);
		expect(tabs()[0].querySelector('svg[data-icon="command-line"]')).not.toBeNull();
		expect(tabs()[1].title).toBe('/tmp/repo/src/main.ts');
	});

	it('marks the shown tab selected, the terminal when no file is', () => {
		const props = show(['/tmp/repo/a.md', '/tmp/repo/b.md']);
		expect(selected()).toEqual([tabs()[0]]);
		props.active = '/tmp/repo/b.md';
		flushSync();
		expect(selected()).toEqual([tabs()[2]]);
	});

	it('selects a clicked tab, and the terminal', () => {
		const props = show(['/tmp/repo/a.md'], '/tmp/repo/a.md');
		tabs()[0].click();
		expect(props.onselect).toHaveBeenLastCalledWith(undefined);
		tabs()[1].click();
		expect(props.onselect).toHaveBeenLastCalledWith('/tmp/repo/a.md');
	});

	it('closes a tab from its button without selecting it', () => {
		const props = show(['/tmp/repo/a.md', '/tmp/repo/b.md']);
		target.querySelector<HTMLButtonElement>('button[aria-label="Close b.md"]')!.click();
		expect(props.onclose).toHaveBeenCalledWith(['/tmp/repo/b.md']);
		expect(props.onselect).not.toHaveBeenCalled();
	});

	it('sets the preview tab in italics, and only it', () => {
		const props = show(['/tmp/repo/a.md', '/tmp/repo/b.md'], undefined, '/tmp/repo/b.md');
		const italic = () => [...target.querySelectorAll('.tab.preview')].map((t) => t.textContent?.trim());
		expect(italic()).toEqual(['b.md']);
		props.preview = undefined;
		flushSync();
		expect(italic()).toEqual([]);
	});

	it('pins a double-clicked tab, which its clicks still select', () => {
		const props = show(['/tmp/repo/a.md'], undefined, '/tmp/repo/a.md');
		tabs()[1].click();
		tabs()[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(props.onpin).toHaveBeenCalledExactlyOnceWith('/tmp/repo/a.md');
		expect(props.onselect).toHaveBeenCalledExactlyOnceWith('/tmp/repo/a.md');
	});

	it('marks a tab with unsaved edits', () => {
		const props = show(['/tmp/repo/a.md', '/tmp/repo/b.md']);
		expect(target.querySelectorAll('[aria-label="Unsaved"]')).toHaveLength(0);
		(props.dirty as SvelteSet<string>).add('/tmp/repo/b.md');
		flushSync();
		const marks = target.querySelectorAll('[aria-label="Unsaved"]');
		expect(marks).toHaveLength(1);
		expect(tabs()[2].contains(marks[0])).toBe(true);
	});

	describe('menu', () => {
		const a = '/tmp/repo/a.md';
		const b = '/tmp/repo/b.md';
		const c = '/tmp/repo/c.md';
		const items = () => [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		const labels = () => items().map((i) => i.textContent?.trim());
		const item = (label: string) => items().find((i) => i.textContent?.trim() === label)!;
		const disabled = (label: string) => item(label).getAttribute('aria-disabled') === 'true';
		const tabOf = (name: string) => tabs().find((t) => t.textContent?.trim() === name)!.parentElement!;
		function rightClick(name: string): MouseEvent {
			const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 10 });
			tabOf(name).dispatchEvent(e);
			flushSync();
			return e;
		}
		const choose = (label: string) => {
			item(label).click();
			flushSync();
		};

		// What has the focus under the bar: the terminal's textarea or the editor.
		let content: HTMLTextAreaElement;
		beforeEach(() => {
			content = document.createElement('textarea');
			document.body.append(content);
			content.focus();
		});
		afterEach(() => content.remove());

		it('lists the items in order and marks the tab it is for', () => {
			show([a, b]);
			const e = rightClick('a.md');
			expect(e.defaultPrevented).toBe(true);
			// No Reveal in Finder outside Tauri.
			expect(labels()).toEqual(['Close', 'Close Others', 'Close to the Right', 'Close All', 'Copy path']);
			expect(tabOf('a.md').classList.contains('menu')).toBe(true);
			expect(tabOf('b.md').classList.contains('menu')).toBe(false);
			choose('Close');
			expect(tabOf('a.md').classList.contains('menu')).toBe(false);
		});

		it('opens on no tab button: the first item has the focus, and Escape gives it back to the content', () => {
			show([a, b]);
			rightClick('a.md');
			expect(document.activeElement).toBe(items()[0]);
			items()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			flushSync();
			expect(items()).toHaveLength(0);
			expect(document.activeElement).toBe(content);
		});

		it('closes the tab', () => {
			const props = show([a, b]);
			rightClick('b.md');
			choose('Close');
			expect(props.onclose).toHaveBeenCalledWith([b]);
		});

		it('closes the others after showing the tab, as the bar has them when clicked', () => {
			const props = show([a, b, c]);
			rightClick('b.md');
			expect(disabled('Close Others')).toBe(false);
			props.tabs = [...props.tabs, '/tmp/repo/d.md'];
			flushSync();
			choose('Close Others');
			expect(props.onselect).toHaveBeenCalledWith(b);
			expect(props.onclose).toHaveBeenCalledWith([a, c, '/tmp/repo/d.md']);
			expect(props.onselect.mock.invocationCallOrder[0]).toBeLessThan(props.onclose.mock.invocationCallOrder[0]);
		});

		it('has no others to close with one file tab', () => {
			const props = show([a]);
			rightClick('a.md');
			expect(disabled('Close Others')).toBe(true);
			choose('Close Others');
			expect(props.onclose).not.toHaveBeenCalled();
			expect(props.onselect).not.toHaveBeenCalled();
		});

		it('closes the tabs to the right, and has none to close on the last tab', () => {
			const props = show([a, b, c]);
			rightClick('a.md');
			choose('Close to the Right');
			expect(props.onclose).toHaveBeenCalledWith([b, c]);
			rightClick('c.md');
			expect(disabled('Close to the Right')).toBe(true);
		});

		it('closes every file tab', () => {
			const props = show([a, b, c]);
			rightClick('b.md');
			choose('Close All');
			expect(props.onclose).toHaveBeenCalledWith([a, b, c]);
		});

		it('copies the path, and reports a failure', async () => {
			const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
			const props = show([a, b]);
			rightClick('b.md');
			choose('Copy path');
			expect(write).toHaveBeenCalledWith(b);
			write.mockRejectedValueOnce(new Error('denied'));
			rightClick('a.md');
			choose('Copy path');
			await vi.waitFor(() => expect(props.report).toHaveBeenCalledWith('copy path failed: denied'));
			write.mockRestore();
		});

		// Unmounting gives no focus back, so a file shown since cannot leave it
		// on a terminal it now covers.
		it('goes when its tab leaves the bar, without focusing what had the focus', () => {
			const props = show([a, b]);
			rightClick('b.md');
			const focus = vi.spyOn(content, 'focus');
			props.tabs = [a];
			flushSync();
			expect(items()).toHaveLength(0);
			expect(focus).not.toHaveBeenCalled();
		});

		it('goes when the shown tab changes, without focusing what had the focus', () => {
			const props = show([a, b]);
			rightClick('b.md');
			const focus = vi.spyOn(content, 'focus');
			props.active = a;
			flushSync();
			expect(items()).toHaveLength(0);
			expect(focus).not.toHaveBeenCalled();
		});

		it('opens on no terminal tab', () => {
			show([a]);
			const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
			tabs()[0].dispatchEvent(e);
			flushSync();
			expect(e.defaultPrevented).toBe(false);
			expect(items()).toHaveLength(0);
		});

		describe('inside Tauri', () => {
			const internals = window as unknown as { __TAURI_INTERNALS__?: object };
			beforeEach(() => {
				internals.__TAURI_INTERNALS__ = {};
				opener.revealItemInDir.mockClear();
			});
			afterEach(() => {
				delete internals.__TAURI_INTERNALS__;
			});

			it('reveals the file in Finder, and reports a failure', async () => {
				const props = show([a, b]);
				rightClick('b.md');
				expect(labels()).toEqual(['Close', 'Close Others', 'Close to the Right', 'Close All', 'Copy path', 'Reveal in Finder']);
				choose('Reveal in Finder');
				await vi.waitFor(() => expect(opener.revealItemInDir).toHaveBeenCalledWith(b));
				opener.revealItemInDir.mockRejectedValueOnce(new Error('no such file'));
				rightClick('a.md');
				choose('Reveal in Finder');
				await vi.waitFor(() => expect(props.report).toHaveBeenCalledWith('reveal in Finder failed: no such file'));
			});
		});
	});

	describe('overflow', () => {
		const wheel = (init: WheelEventInit) => {
			const bar = target.querySelector<HTMLElement>('.tabs')!;
			const e = new WheelEvent('wheel', { cancelable: true, ...init });
			bar.dispatchEvent(e);
			return { bar, e };
		};
		const overflow = (bar: HTMLElement, overflowing: boolean) => {
			Object.defineProperty(bar, 'scrollWidth', { configurable: true, value: overflowing ? 500 : 100 });
			Object.defineProperty(bar, 'clientWidth', { configurable: true, value: 100 });
		};

		it('turns a vertical wheel into sideways scrolling when the bar overflows', () => {
			show(['/tmp/repo/a.md']);
			const bar = target.querySelector<HTMLElement>('.tabs')!;
			overflow(bar, true);
			const { e } = wheel({ deltaY: 40 });
			expect(bar.scrollLeft).toBe(40);
			expect(e.defaultPrevented).toBe(true);
		});

		it('leaves the wheel alone when nothing overflows, and horizontal swipes always', () => {
			show(['/tmp/repo/a.md']);
			const bar = target.querySelector<HTMLElement>('.tabs')!;
			overflow(bar, false);
			expect(wheel({ deltaY: 40 }).e.defaultPrevented).toBe(false);
			overflow(bar, true);
			const swipe = wheel({ deltaX: 40, deltaY: 3 });
			expect(swipe.e.defaultPrevented).toBe(false);
			expect(bar.scrollLeft).toBe(0);
		});

		it('scrolls the shown tab into view when it changes or opens', () => {
			const scrollIntoView = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoView;
			const props = show(['/tmp/repo/a.md', '/tmp/repo/b.md']);
			scrollIntoView.mockClear();
			props.active = '/tmp/repo/b.md';
			flushSync();
			expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
			expect(scrollIntoView.mock.contexts.at(-1)).toBe(tabs()[2].parentElement);
			scrollIntoView.mockClear();
			props.tabs = [...props.tabs, '/tmp/repo/c.md'];
			props.active = '/tmp/repo/c.md';
			flushSync();
			expect(scrollIntoView.mock.contexts.at(-1)).toBe(tabs()[3].parentElement);
		});
	});
});
