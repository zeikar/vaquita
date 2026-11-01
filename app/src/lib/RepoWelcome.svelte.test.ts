// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RepoWelcome from './RepoWelcome.svelte';
import { changeLists } from './changes.svelte';
import type { Change } from './files';
import { pastStub } from './PastList.stub.svelte';
import type { SessionInfo } from './protocol';

vi.mock('./PastList.svelte', async () => ({ default: (await import('./PastList.stub.svelte')).default }));
vi.mock('./files', () => ({ gitChanges: vi.fn() }));

const REPO = '/tmp/repo';
const session = (sid: number, cwd: string, state = 'running') => ({ sid, cwd, state }) as SessionInfo;
const entries = (n: number): Change[] =>
	Array.from({ length: n }, (_, i) => ({ path: `f${i}`, abs: `${REPO}/f${i}`, status: 'M', added: 1, removed: 0, from: null }));

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;
let refresh: ReturnType<typeof vi.fn<(root: string) => Promise<void>>>;

type Where = { home?: string; connected?: boolean; creating?: boolean; sessions?: SessionInfo[] };

function show(where: Where = {}) {
	const props = $state({
		repo: REPO,
		home: where.home,
		sessions: where.sessions ?? [],
		repos: [REPO, '/tmp/other'],
		connected: where.connected ?? true,
		creating: where.creating ?? false,
		onstart: vi.fn(),
		onallpast: vi.fn(),
		onresume: vi.fn(),
		onselect: vi.fn(),
		onreopen: vi.fn(),
		report: vi.fn(),
	});
	target = document.createElement('div');
	document.body.append(target);
	shown = mount(RepoWelcome, { target, props });
	flushSync();
	return props;
}

const button = (label: string) =>
	[...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(label));
const meta = () => target.querySelector('.meta')?.textContent?.replace(/\s+/g, ' ').trim();

beforeEach(() => {
	changeLists.lists = {};
	refresh = vi.fn(async (_root: string) => {});
	vi.spyOn(changeLists, 'refresh').mockImplementation(refresh);
	pastStub.props = undefined;
});

afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target.remove();
	vi.restoreAllMocks();
});

describe('RepoWelcome', () => {
	it('names the repo, from ~ under the home folder', () => {
		show({ home: '/tmp' });
		expect(target.querySelector('h1')?.textContent).toBe('repo');
		expect(target.querySelector('.crumb')?.textContent?.trim()).toBe('~/repo');
	});

	it('shows the full path without a home', () => {
		show();
		expect(target.querySelector('.crumb')?.textContent?.trim()).toBe(REPO);
	});

	it('reads the branch, the changes and the running sessions', () => {
		changeLists.lists = { [REPO]: { list: { root: REPO, entries: entries(3), total: 3, branch: 'main' }, busy: false } };
		show({ sessions: [session(1, REPO), session(2, `${REPO}/src`), session(3, '/tmp/other'), session(4, REPO, 'exited')] });
		expect(meta()).toBe('on main 3 changed files 2 sessions');
		expect(target.querySelector('.meta em')?.textContent).toBe('main');
		expect(target.querySelector('.meta .chg')?.textContent).toBe('3 changed files');
	});

	it('shows no changes text before a snapshot, and no amber for none', () => {
		show();
		expect(meta()).toBe('no sessions');
		changeLists.lists = { [REPO]: { list: { root: REPO, entries: [], total: 0, branch: 'main' }, busy: false } };
		flushSync();
		expect(meta()).toBe('on main no changes no sessions');
		expect(target.querySelector('.meta .chg')).toBeNull();
	});

	it('shows no branch when HEAD is detached', () => {
		changeLists.lists = { [REPO]: { list: { root: REPO, entries: entries(1), total: 1, branch: null }, busy: false } };
		show({ sessions: [session(1, REPO)] });
		expect(meta()).toBe('1 changed file 1 session');
	});

	it("shows a snapshot's error", () => {
		changeLists.lists = { [REPO]: { error: 'git broke', busy: false } };
		show();
		expect(target.querySelector('.error')?.textContent).toBe('git broke');
	});

	it('refreshes the changes once, on mount', () => {
		const props = show();
		props.sessions = [session(1, REPO)];
		flushSync();
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledWith(REPO);
	});

	it('starts each kind of session from its card', () => {
		const props = show();
		button('Claude Code')!.click();
		button('Codex')!.click();
		button('Shell')!.click();
		expect(props.onstart.mock.calls).toEqual([['claude'], ['codex'], ['']]);
	});

	it('disables the cards while creating or disconnected', () => {
		const props = show({ creating: true });
		const cards = () => ['Claude Code', 'Codex', 'Shell'].map((l) => button(l)!);
		expect(cards().every((b) => b.disabled)).toBe(true);
		props.creating = false;
		flushSync();
		expect(cards().every((b) => !b.disabled)).toBe(true);
		props.connected = false;
		flushSync();
		expect(cards().every((b) => b.disabled)).toBe(true);
		expect(pastStub.props?.disabled).toBe(true);
	});

	it('opens all past conversations', () => {
		const props = show();
		button('All past conversations')!.click();
		expect(props.onallpast).toHaveBeenCalledTimes(1);
	});

	it("lists the repo's newest five past conversations", () => {
		const props = show();
		expect(pastStub.props?.limit).toBe(5);
		expect(pastStub.props?.root).toBe(REPO);
		expect(pastStub.props?.disabled).toBe(false);
		expect(pastStub.props?.repos).toEqual(props.repos);
		pastStub.props?.onselect(4);
		expect(props.onselect).toHaveBeenCalledWith(4);
	});

	it('takes the focus on its root', () => {
		show();
		(shown as { focus(): void }).focus();
		const root = target.firstElementChild as HTMLElement;
		expect(root.tabIndex).toBe(-1);
		expect(document.activeElement).toBe(root);
	});
});
