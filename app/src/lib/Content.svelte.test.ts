// @vitest-environment happy-dom
// Named .svelte.test.ts for the fake tabs' $state, as the store's are.
import { flushSync, mount, unmount } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { writable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP, type AppContext } from './app-context';
import { changeLists } from './changes.svelte';
import Content from './Content.svelte';
import type { ManagerState } from './manager';
import { WELCOME } from './tabs';

vi.mock('./files', () => ({
	CHANGED_ON_DISK: 'changed on disk',
	gitChanges: vi.fn(),
	viewPath: vi.fn(async (path: string) => ({ path, kind: 'text' })),
	readText: vi.fn(async () => ({ text: 'x', stamp: { secs: 1, nanos: 0, len: 1 } })),
	writeText: vi.fn(),
	fileUrl: vi.fn(),
	previewImage: vi.fn(),
}));
vi.mock('./monaco', () => ({
	EDITOR_OPTIONS: {},
	loadMonaco: async () => ({
		editor: {
			create: () => ({ setModel: () => {}, getModel: () => null, focus: () => {}, dispose: () => {}, updateOptions: () => {} }),
			createModel: () => ({ getValue: () => 'x', getAlternativeVersionId: () => 1, onDidChangeContent: () => {}, dispose: () => {} }),
		},
		Uri: { file: (p: string) => p },
	}),
	languageFor: () => 'plaintext',
}));
vi.mock('./markdown', () => ({ renderMarkdown: async (text: string) => text }));
vi.mock('./DiffView.svelte', async () => ({ default: (await import('./DiffView.stub.svelte')).default }));
vi.mock('./PastList.svelte', async () => ({ default: (await import('./PastList.stub.svelte')).default }));
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }));

const repo = '/tmp/repo';
const file = `${repo}/a.ts`;

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;

beforeEach(() => {
	vi.spyOn(changeLists, 'refresh').mockResolvedValue();
});
afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target.remove();
	vi.restoreAllMocks();
});

const base: ManagerState = { status: 'connected', sessions: [], repos: [repo], reposListed: true, creating: false, focused: true };

type Pane = { focus(): void } | null | undefined;

function show(where: { group?: string; active?: string; groupTabs?: string[] } = {}) {
	const store = writable<ManagerState>(base);
	const manager = { subscribe: store.subscribe, create: vi.fn(), reopen: vi.fn(), report: vi.fn() };
	const tabs = $state({
		group: where.group,
		active: where.active,
		root: where.group,
		groupTabs: where.groupTabs ?? [],
		previews: {},
		dirty: new SvelteSet<string>(),
		repoWelcome: undefined as Pane,
		filePane: undefined as Pane,
		appWelcome: undefined as Pane,
		show: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		pin: vi.fn(),
		reorder: vi.fn(),
		newSession: vi.fn(),
		selectSession: vi.fn(),
		openFromTree: vi.fn(),
	});
	const layout = { addRepo: { open: vi.fn(async () => {}) }, showPast: vi.fn() };
	const startup = { home: undefined, version: '0.1.30', updating: false };
	const ctx = { manager, tabs, layout, startup } as unknown as AppContext;
	target = document.createElement('div');
	document.body.append(target);
	shown = mount(Content, { target, context: new Map([[APP, ctx]]) });
	flushSync();
	return { manager, tabs, layout };
}

const bar = () => target.querySelector('[role="tablist"]');
const has = (selector: string) => target.querySelector(selector) !== null;
const button = (text: string) => [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text))!;

describe('Content', () => {
	it('shows the app welcome with no group, bound into the tabs, and no bar', () => {
		const { tabs, layout } = show();
		expect(target.querySelector('section.content > .stack')).not.toBeNull();
		expect(bar()).toBeNull();
		expect(target.textContent).toContain('0.1.30');
		expect(typeof tabs.appWelcome?.focus).toBe('function');
		expect(tabs.repoWelcome).toBeUndefined();
		expect(tabs.filePane).toBeUndefined();
		button('Add a repo').click();
		expect(layout.addRepo.open).toHaveBeenCalledTimes(1);
		button('New session').click();
		expect(tabs.newSession).toHaveBeenCalledTimes(1);
	});

	it("shows a repo's welcome alone, under no bar, while the repo has no tabs", () => {
		const { tabs } = show({ group: repo, active: WELCOME });
		expect(bar()).toBeNull();
		expect(typeof tabs.repoWelcome?.focus).toBe('function');
		expect(tabs.appWelcome).toBeUndefined();
	});

	it('shows the bar with the group tabs, and a click on a tab shows it', () => {
		const { tabs } = show({ group: repo, active: WELCOME, groupTabs: [file] });
		expect(bar()).not.toBeNull();
		expect(typeof tabs.repoWelcome?.focus).toBe('function');
		[...target.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((b) => b.textContent?.includes('a.ts'))!.click();
		expect(tabs.show).toHaveBeenCalledWith(file);
	});

	it('shows a file tab in the file pane, bound into the tabs, and clears it when a session tab shows', () => {
		const { tabs } = show({ group: repo, active: file, groupTabs: [file, 'session:1'] });
		expect(has(`div.bar[title="${file}"]`)).toBe(true);
		expect(typeof tabs.filePane?.focus).toBe('function');
		expect(tabs.repoWelcome).toBeUndefined();
		tabs.active = 'session:1';
		flushSync();
		expect(tabs.filePane).toBeNull();
		expect(has(`div.bar[title="${file}"]`)).toBe(false);
	});
});
