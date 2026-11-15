import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabAction } from './files';
import { watchMenu, windowShortcut } from './shortcuts';

const menu = vi.hoisted(() => ({
	run: undefined as ((a: TabAction) => void) | undefined,
	unlistened: 0,
	fail: undefined as Error | undefined,
}));
vi.mock('./files', () => ({
	onTabAsked: async (run: (a: TabAction) => void) => {
		if (menu.fail) throw menu.fail;
		menu.run = run;
		return () => void menu.unlistened++;
	},
}));

beforeEach(() => {
	Object.assign(menu, { run: undefined, unlistened: 0, fail: undefined });
});

function fakes() {
	const tabs = { newSession: vi.fn(), step: vi.fn(), showAt: vi.fn(), save: vi.fn(), closeActive: vi.fn() };
	const layout = { toggleSidebar: vi.fn(), togglePanel: vi.fn() };
	const manager = { report: vi.fn() };
	return { tabs, layout, manager };
}

// A keydown as the window's capture listener gets it.
function key(init: Partial<KeyboardEvent>) {
	return {
		type: 'keydown',
		key: '',
		keyCode: 0,
		isComposing: false,
		shiftKey: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		...init,
	} as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> };
}

const settle = () => new Promise((r) => setTimeout(r));

describe('windowShortcut', () => {
	it.each<[string, Partial<KeyboardEvent>, (f: ReturnType<typeof fakes>) => ReturnType<typeof vi.fn>, unknown[]]>([
		['⌘T', { key: 't', metaKey: true }, (f) => f.tabs.newSession, []],
		['⌘B', { key: 'b', metaKey: true }, (f) => f.layout.toggleSidebar, []],
		['⌃Tab', { key: 'Tab', ctrlKey: true }, (f) => f.tabs.step, [1]],
		['⌃⇧Tab', { key: 'Tab', ctrlKey: true, shiftKey: true }, (f) => f.tabs.step, [-1]],
		['⌥⌘←', { key: 'ArrowLeft', metaKey: true, altKey: true }, (f) => f.tabs.step, [-1]],
		['⌥⌘→', { key: 'ArrowRight', metaKey: true, altKey: true }, (f) => f.tabs.step, [1]],
		['⌘1', { key: '1', metaKey: true }, (f) => f.tabs.showAt, [1]],
		['⌘9', { key: '9', metaKey: true }, (f) => f.tabs.showAt, [9]],
		['⌘S', { key: 's', metaKey: true }, (f) => f.tabs.save, []],
	])('%s calls its one method and is cancelled and stopped', (_name, init, method, args) => {
		const f = fakes();
		const e = key(init);
		windowShortcut(f.tabs, f.layout)(e);
		const m = method(f);
		expect(m).toHaveBeenCalledTimes(1);
		expect(m).toHaveBeenCalledWith(...args);
		const all = [...Object.values(f.tabs), ...Object.values(f.layout)];
		expect(all.reduce((n, fn) => n + fn.mock.calls.length, 0)).toBe(1);
		expect(e.preventDefault).toHaveBeenCalledTimes(1);
		expect(e.stopPropagation).toHaveBeenCalledTimes(1);
	});

	it('leaves any other key alone', () => {
		const f = fakes();
		const shortcut = windowShortcut(f.tabs, f.layout);
		for (const init of [{ key: 'a' }, { key: 't' }, { key: 'w', metaKey: true }, { key: '0', metaKey: true }, { key: 'Tab' }, { key: 't', metaKey: true, isComposing: true }]) {
			const e = key(init);
			shortcut(e);
			expect(e.preventDefault).not.toHaveBeenCalled();
			expect(e.stopPropagation).not.toHaveBeenCalled();
		}
		for (const fn of [...Object.values(f.tabs), ...Object.values(f.layout)]) expect(fn).not.toHaveBeenCalled();
	});
});

describe('watchMenu', () => {
	it("maps the menu's actions to the tabs and the layout until stopped", async () => {
		const f = fakes();
		const stop = watchMenu(f.tabs, f.layout, f.manager);
		await settle();
		menu.run!('close');
		expect(f.tabs.closeActive).toHaveBeenCalledTimes(1);
		menu.run!('prev');
		expect(f.tabs.step).toHaveBeenLastCalledWith(-1);
		menu.run!('next');
		expect(f.tabs.step).toHaveBeenLastCalledWith(1);
		menu.run!('files');
		expect(f.layout.togglePanel).toHaveBeenCalledTimes(1);
		stop();
		await settle();
		expect(menu.unlistened).toBe(1);
		expect(f.manager.report).not.toHaveBeenCalled();
	});

	it('reports a menu it cannot listen to', async () => {
		menu.fail = new Error('no events');
		const f = fakes();
		const stop = watchMenu(f.tabs, f.layout, f.manager);
		await settle();
		expect(f.manager.report).toHaveBeenCalledWith('tab shortcuts unavailable: no events');
		stop();
		await settle();
	});
});
