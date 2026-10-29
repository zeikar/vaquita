// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TabBar from './TabBar.svelte';

let target: HTMLElement;
let bar: ReturnType<typeof mount> | undefined;

function show(tabs: string[], active?: string) {
	const props = $state({
		title: 'claude',
		tabs,
		active,
		dirty: new SvelteSet<string>(),
		onselect: vi.fn(),
		onclose: vi.fn(),
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
		expect(props.onclose).toHaveBeenCalledWith('/tmp/repo/b.md');
		expect(props.onselect).not.toHaveBeenCalled();
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
