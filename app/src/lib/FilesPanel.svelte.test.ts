// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilesPanel, { showView } from './FilesPanel.svelte';
import { endedTurns } from './changes';
import { changeLists } from './changes.svelte';
import { gitChanges, type Change } from './files';
import { pastBusy, pastStub } from './PastList.stub.svelte';
import type { SessionInfo } from './protocol';

// The save listeners the panel installed.
const saved = vi.hoisted(() => new Set<(path: string) => void>());

vi.mock('./FileTree.svelte', async () => ({ default: (await import('./FileTree.stub.svelte')).default }));
vi.mock('./ChangesList.svelte', async () => ({ default: (await import('./ChangesList.stub.svelte')).default }));
vi.mock('./PastList.svelte', async () => ({ default: (await import('./PastList.stub.svelte')).default }));
vi.mock('./files', () => ({ gitChanges: vi.fn() }));
// Counted, so a rerun of the turn-end effect shows.
vi.mock('./changes', async (actual) => {
	const real = await actual<typeof import('./changes')>();
	return { ...real, endedTurns: vi.fn(real.endedTurns) };
});
vi.mock('./documents', () => ({
	documents: {
		onSaved: (l: (path: string) => void) => {
			saved.add(l);
			return () => saved.delete(l);
		},
	},
}));

const session = (sid: number, cwd: string, state?: 'working' | 'done'): SessionInfo =>
	({ sid, cwd, status: state && { state } }) as SessionInfo;
const entries = (n: number): Change[] =>
	Array.from({ length: n }, (_, i) => ({ path: `f${i}`, abs: `/tmp/repo/f${i}`, status: 'M', added: 1, removed: 0, from: null }));

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;
let refresh: ReturnType<typeof vi.fn<(root: string) => Promise<void>>>;
// Restored by a test that runs the real refresh, with gitChanges mocked.
let spy: { mockRestore: () => void };

type Where = { root?: string; cwd?: string; home?: string; connected?: boolean; creating?: boolean; sessions?: SessionInfo[]; repos?: string[] };

function show(where: Where = {}) {
	const props = $state({
		root: where.root,
		cwd: where.cwd,
		home: where.home,
		connected: where.connected ?? true,
		creating: where.creating ?? false,
		sessions: where.sessions ?? [],
		repos: where.repos ?? ['/tmp/repo'],
		highlight: '/tmp/repo/a.ts' as string | undefined,
		onopen: vi.fn(),
		onopendiff: vi.fn(),
		onaddrepo: vi.fn(),
		onresume: vi.fn(),
		onselect: vi.fn(),
		onreopen: vi.fn(),
		onleave: vi.fn(),
		report: vi.fn(),
	});
	target = document.createElement('div');
	document.body.append(target);
	shown = mount(FilesPanel, { target, props });
	flushSync();
	return props;
}

const button = (label: string) => [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(label) || b.getAttribute('aria-label') === label);
const badge = () => target.querySelector('.badge')?.textContent;
const tree = () => target.querySelector<HTMLElement>('.tree-stub');
const list = () => target.querySelector<HTMLElement>('.changes-stub');
const past = () => target.querySelector<HTMLElement>('.past-stub');

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	flushSync();
}

function click(el: HTMLElement) {
	el.click();
	flushSync();
}

beforeEach(() => {
	changeLists.lists = {};
	refresh = vi.fn(async (_root: string) => {});
	spy = vi.spyOn(changeLists, 'refresh').mockImplementation(refresh);
	vi.mocked(gitChanges).mockReset();
	pastStub.props = undefined;
	pastStub.refresh.mockClear();
	pastBusy.busy = false;
});

afterEach(() => {
	// The view is the module's, kept across mounts as across the app run.
	const files = target && button('Files');
	if (files && files.getAttribute('aria-pressed') === 'false') click(files);
	if (shown) unmount(shown);
	shown = undefined;
	target?.remove();
	saved.clear();
	vi.restoreAllMocks();
});

describe('FilesPanel', () => {
	it('shows the switch with Files pressed and the tree, for a repo', () => {
		show({ root: '/tmp/repo', cwd: '/tmp/repo' });
		expect(button('Files')!.getAttribute('aria-pressed')).toBe('true');
		expect(button('Changes')!.getAttribute('aria-pressed')).toBe('false');
		expect(target.querySelector('.repo')?.textContent).toBe('repo');
		expect(tree()?.dataset.root).toBe('/tmp/repo');
		expect(tree()?.dataset.highlight).toBe('/tmp/repo/a.ts');
		expect(list()).toBeNull();
		expect(button('Refresh changes')).toBeUndefined();
	});

	it('mounts the list and Refresh for Changes, and the tree again for Files', () => {
		const props = show({ root: '/tmp/repo', cwd: '/tmp/repo' });
		click(button('Changes')!);
		expect(tree()).toBeNull();
		expect(list()?.dataset.root).toBe('/tmp/repo');
		click(list()!.querySelector('button')!);
		expect(props.onopendiff).toHaveBeenCalledWith('/tmp/repo/a.ts');
		click(button('Refresh changes')!);
		expect(refresh).toHaveBeenCalledWith('/tmp/repo');
		// Dimmed, not disabled, so it keeps the focus; a click is one more run.
		changeLists.lists = { '/tmp/repo': { busy: true } };
		flushSync();
		expect(button('Refresh changes')!.getAttribute('aria-disabled')).toBe('true');
		click(button('Refresh changes')!);
		expect(refresh).toHaveBeenCalledTimes(2);
		click(button('Files')!);
		expect(list()).toBeNull();
		expect(tree()).not.toBeNull();
	});

	it('switches among three views, Past mounting the list with what it needs', () => {
		const sessions = [session(1, '/tmp/repo', 'working')];
		const props = show({ root: '/tmp/repo', cwd: '/tmp/repo', sessions, repos: ['/tmp/repo', '/tmp/other'] });
		expect([...target.querySelectorAll('.switch button')].map((b) => b.textContent?.trim())).toEqual(['Files', 'Changes', 'Past']);
		click(button('Past conversations')!);
		expect(button('Past conversations')!.getAttribute('aria-pressed')).toBe('true');
		expect(tree()).toBeNull();
		expect(list()).toBeNull();
		expect(past()?.dataset.root).toBe('/tmp/repo');
		expect(pastStub.props?.sessions).toEqual(sessions);
		expect(pastStub.props?.repos).toEqual(['/tmp/repo', '/tmp/other']);
		expect(past()?.dataset.disabled).toBe('false');
		props.creating = true;
		flushSync();
		expect(past()?.dataset.disabled).toBe('true');
		props.creating = false;
		props.connected = false;
		flushSync();
		expect(past()?.dataset.disabled).toBe('true');
		pastStub.props!.onselect(3);
		expect(props.onselect).toHaveBeenCalledWith(3);
		pastStub.props!.onleave!();
		expect(props.onleave).toHaveBeenCalledOnce();
	});

	it('can be set to a view from outside', () => {
		show({ root: '/tmp/repo', cwd: '/tmp/repo' });
		showView('past');
		flushSync();
		expect(past()).not.toBeNull();
		expect(button('Past conversations')!.getAttribute('aria-pressed')).toBe('true');
	});

	it('refreshes the past conversations, not the changes, from the Past view', () => {
		show({ root: '/tmp/repo', cwd: '/tmp/repo' });
		click(button('Past conversations')!);
		expect(button('Refresh changes')).toBeUndefined();
		click(button('Refresh past conversations')!);
		expect(pastStub.refresh).toHaveBeenCalledOnce();
		expect(refresh).not.toHaveBeenCalled();
		expect(button('Refresh past conversations')!.getAttribute('aria-disabled')).toBe('false');
		pastBusy.busy = true;
		flushSync();
		expect(button('Refresh past conversations')!.getAttribute('aria-disabled')).toBe('true');
	});

	it('badges the last count known, 2000+ past the cap, and nothing for none', () => {
		show({ root: '/tmp/repo', cwd: '/tmp/repo' });
		expect(badge()).toBeUndefined();
		changeLists.lists = { '/tmp/repo': { list: { root: '/tmp/repo', entries: entries(3), total: 3, branch: null }, busy: false } };
		flushSync();
		expect(badge()).toBe('3');
		expect(button('Changes')!.getAttribute('aria-label')).toBe('Changes, 3 changed');
		changeLists.lists = { '/tmp/repo': { list: { root: '/tmp/repo', entries: entries(2000), total: 2400, branch: null }, busy: false } };
		flushSync();
		expect(badge()).toBe('2000+');
		changeLists.lists = { '/tmp/repo': { list: { root: '/tmp/repo', entries: [], total: 0, branch: null }, busy: false } };
		flushSync();
		expect(badge()).toBeUndefined();
		expect(button('Changes')!.hasAttribute('aria-label')).toBe(false);
		expect(refresh).not.toHaveBeenCalled();
	});

	it('keeps the Changes view and remounts the list for another repo', () => {
		const props = show({ root: '/tmp/repo', cwd: '/tmp/repo', repos: ['/tmp/repo', '/tmp/other'] });
		click(button('Changes')!);
		const first = list();
		props.root = '/tmp/other';
		props.cwd = '/tmp/other';
		flushSync();
		expect(list()).not.toBe(first);
		expect(list()?.dataset.root).toBe('/tmp/other');
		expect(button('Changes')!.getAttribute('aria-pressed')).toBe('true');
	});

	it('offers to add a session folder under no repo, without the switch', () => {
		const props = show({ cwd: '/tmp/other', connected: false });
		expect(button('Changes')).toBeUndefined();
		expect(badge()).toBeUndefined();
		expect(target.querySelector('.title')?.textContent).toBe('Files');
		const add = button('Add')!;
		expect(add.textContent?.trim()).toBe('Add /tmp/other as a repo');
		expect(add.disabled).toBe(true);
		props.connected = true;
		flushSync();
		click(add);
		expect(props.onaddrepo).toHaveBeenCalledWith('/tmp/other');
	});

	it('shows no body without a session', () => {
		show();
		expect(target.querySelector('.no-repo')).toBeNull();
		expect(tree()).toBeNull();
		expect(list()).toBeNull();
	});

	it('refreshes once when a session in the repo ends a turn', () => {
		const props = show({ root: '/tmp/repo', cwd: '/tmp/repo', sessions: [session(1, '/tmp/repo/src', 'working'), session(2, '/tmp/other', 'working')] });
		props.sessions = [session(1, '/tmp/repo/src', 'working'), session(2, '/tmp/other', 'done')];
		flushSync();
		expect(refresh).not.toHaveBeenCalled();
		props.sessions = [session(1, '/tmp/repo/src', 'done'), session(2, '/tmp/other', 'done')];
		flushSync();
		expect(refresh.mock.calls).toEqual([['/tmp/repo']]);
		props.sessions = [session(1, '/tmp/repo/src', 'done'), session(2, '/tmp/other', 'done')];
		flushSync();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it('runs status once for one turn end, through the real lists, and is not rerun by them', async () => {
		spy.mockRestore();
		vi.mocked(gitChanges).mockResolvedValue({ root: '/tmp/repo', entries: entries(2), total: 2, branch: null });
		const props = show({ root: '/tmp/repo', cwd: '/tmp/repo', sessions: [session(1, '/tmp/repo', 'working')] });
		vi.mocked(endedTurns).mockClear();
		props.sessions = [session(1, '/tmp/repo', 'done')];
		flushSync();
		await settle();
		expect(gitChanges).toHaveBeenCalledOnce();
		expect(badge()).toBe('2');
		expect(endedTurns).toHaveBeenCalledOnce();
	});

	it('reports a new failure once, whatever asked for the run', async () => {
		spy.mockRestore();
		vi.mocked(gitChanges).mockRejectedValue(new Error('git broke'));
		const props = show({ root: '/tmp/repo', cwd: '/tmp/repo', sessions: [session(1, '/tmp/repo', 'working')] });
		props.sessions = [session(1, '/tmp/repo', 'done')];
		flushSync();
		await settle();
		for (const l of saved) l('/tmp/repo/a.ts');
		await settle();
		expect(gitChanges).toHaveBeenCalledTimes(2);
		expect(props.report.mock.calls).toEqual([['listing changes in repo failed: git broke']]);
	});

	it('takes the sessions of a repo switched to as first seen', () => {
		const props = show({
			root: '/tmp/a',
			cwd: '/tmp/a',
			repos: ['/tmp/a', '/tmp/b'],
			sessions: [session(1, '/tmp/a', 'working'), session(2, '/tmp/b', 'working')],
		});
		props.root = '/tmp/b';
		props.cwd = '/tmp/b';
		props.sessions = [session(1, '/tmp/a', 'working'), session(2, '/tmp/b', 'done')];
		flushSync();
		expect(refresh).not.toHaveBeenCalled();
	});

	it('does nothing on a turn end without a repo', () => {
		const props = show({ cwd: '/tmp/other', sessions: [session(2, '/tmp/other', 'working')] });
		props.sessions = [session(2, '/tmp/other', 'done')];
		flushSync();
		expect(refresh).not.toHaveBeenCalled();
	});

	it('refreshes on a save with a repo, and not without one', () => {
		const props = show({ root: '/tmp/repo', cwd: '/tmp/repo' });
		for (const l of saved) l('/private/tmp/repo/a.ts');
		expect(refresh.mock.calls).toEqual([['/tmp/repo']]);
		props.root = undefined;
		flushSync();
		for (const l of saved) l('/tmp/other/b.ts');
		expect(refresh).toHaveBeenCalledOnce();
	});

	it('stops hearing saves once unmounted', () => {
		show({ root: '/tmp/repo', cwd: '/tmp/repo' });
		expect(saved.size).toBe(1);
		unmount(shown!);
		shown = undefined;
		expect(saved.size).toBe(0);
	});
});
