// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampPanelWidth, PANEL_DEFAULT_WIDTH } from './file-panel';
import { DEFAULT_WIDTH } from './sidebar';
import SidebarEdge from './SidebarEdge.svelte';

let target: HTMLElement;
let app: ReturnType<typeof mount> | undefined;

function show(props: Record<string, unknown> = {}) {
	target = document.createElement('div');
	document.body.append(target);
	const calls = { onstart: vi.fn(), onresize: vi.fn(), onend: vi.fn() };
	app = mount(SidebarEdge, { target, props: { width: 300, ...calls, ...props } });
	return calls;
}

const edge = () => target.querySelector<HTMLElement>('[role="separator"]')!;

function drag(dx: number) {
	edge().dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 500, pointerId: 1, bubbles: true }));
	flushSync();
	edge().dispatchEvent(new PointerEvent('pointermove', { clientX: 500 + dx, pointerId: 1, bubbles: true }));
	edge().dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true }));
	flushSync();
}

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	target?.remove();
});

describe('SidebarEdge', () => {
	it('widens the sidebar as the pointer moves right, within its bounds', () => {
		const { onstart, onresize, onend } = show();
		drag(40);
		expect(onstart).toHaveBeenCalledOnce();
		expect(onresize).toHaveBeenLastCalledWith(340);
		expect(onend).toHaveBeenCalledOnce();
		expect(edge().getAttribute('aria-label')).toBe('Resize sidebar');
		expect(edge().classList.contains('left')).toBe(false);
	});

	it('widens a panel on the right as the pointer moves left, with its own clamp', () => {
		const { onresize } = show({ side: 'left', clamp: clampPanelWidth, label: 'Resize files panel' });
		drag(-40);
		expect(onresize).toHaveBeenLastCalledWith(340);
		drag(-1000);
		expect(onresize).toHaveBeenLastCalledWith(clampPanelWidth(10_000));
		expect(edge().getAttribute('aria-label')).toBe('Resize files panel');
		expect(edge().classList.contains('left')).toBe(true);
	});

	it('sets the given default width back on a double-click', () => {
		const sidebar = show();
		edge().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(sidebar.onresize).toHaveBeenLastCalledWith(DEFAULT_WIDTH);
		expect(sidebar.onend).toHaveBeenCalledOnce();
		unmount(app!);
		target.remove();

		const panel = show({ side: 'left', defaultWidth: PANEL_DEFAULT_WIDTH });
		edge().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(panel.onresize).toHaveBeenLastCalledWith(PANEL_DEFAULT_WIDTH);
	});
});
