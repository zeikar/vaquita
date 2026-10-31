// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PastList from './PastList.svelte';
import { pastConversations, type Conversation, type ConversationList } from './files';
import type { SessionInfo } from './protocol';

vi.mock('./files', () => ({ pastConversations: vi.fn() }));

type Held<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function hold<T>(): Held<T> {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const NOW = Date.UTC(2026, 9, 30, 12);
const DAY = 24 * 3600_000;
const CLAUDE_ID = '11111111-2222-3333-4444-555555555555';
const CODEX_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const claude: Conversation = { agent: 'claude', id: CLAUDE_ID, title: 'Fix the Login form', cwd: '/tmp/repo', last_active: NOW - 6 * DAY };
const codex: Conversation = { agent: 'codex', id: CODEX_ID, title: 'Add a parser', cwd: '/tmp/repo/sub', last_active: NOW - 3 * 3600_000 };
const listOf = (...entries: Conversation[]): ConversationList => ({ entries, total: entries.length });

const session = (sid: number, info: Partial<SessionInfo>): SessionInfo =>
	({ sid, cwd: '/tmp/repo', cmd: 'claude', state: 'running', ...info }) as SessionInfo;

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;
let loads: Held<ConversationList>[];
const load = vi.mocked(pastConversations);

function show(opts: { sessions?: SessionInfo[]; disabled?: boolean } = {}) {
	const props = $state({
		root: '/tmp/repo',
		sessions: opts.sessions ?? [],
		repos: ['/tmp/repo', '/tmp/repo/sub'],
		disabled: opts.disabled ?? false,
		onresume: vi.fn(),
		onselect: vi.fn(),
		onreopen: vi.fn(),
		onleave: vi.fn(),
		report: vi.fn(),
	});
	target = document.createElement('div');
	document.body.append(target);
	shown = mount(PastList, { target, props });
	flushSync();
	return props;
}

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	flushSync();
}

// Mounts and lets the first load answer with list.
async function showList(list: ConversationList, opts: Parameters<typeof show>[0] = {}) {
	const props = show(opts);
	loads[0].resolve(list);
	await settle();
	return props;
}

const rows = () => [...target.querySelectorAll<HTMLButtonElement>('button.row')];
const row = (title: string) => rows().find((r) => r.querySelector('.title')?.textContent === title)!;
const filter = () => target.querySelector<HTMLInputElement>('input[type="search"]')!;

function type(text: string) {
	const input = filter();
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

beforeEach(() => {
	vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
	loads = [];
	load.mockReset().mockImplementation(() => {
		const h = hold<ConversationList>();
		loads.push(h);
		return h.promise;
	});
});

afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target?.remove();
	vi.useRealTimers();
});

describe('PastList', () => {
	it('loads once on mount and shows the rows with their titles and times', async () => {
		show();
		expect(load.mock.calls).toEqual([['/tmp/repo', ['/tmp/repo', '/tmp/repo/sub']]]);
		// Nothing while the first run is busy.
		expect(rows()).toEqual([]);
		expect(target.querySelector('.empty')).toBeNull();
		loads[0].resolve(listOf(claude, codex));
		await settle();
		expect(rows().map((r) => r.querySelector('.title')?.textContent)).toEqual(['Fix the Login form', 'Add a parser']);
		expect(row('Fix the Login form').querySelector('.when')?.textContent).toBe('6d');
		expect(row('Add a parser').querySelector('.when')?.textContent).toBe('3h');
		expect(row('Fix the Login form').querySelector('svg')?.dataset.icon).toBe('claude');
		expect(row('Add a parser').querySelector('svg')?.dataset.icon).toBe('openai');
		expect(row('Add a parser').title).toBe(`/tmp/repo/sub\n${new Date(codex.last_active).toLocaleString()}`);
		expect(load).toHaveBeenCalledOnce();
	});

	it('is busy while a load runs', async () => {
		show();
		const list = shown as unknown as { isBusy: () => boolean };
		expect(list.isBusy()).toBe(true);
		loads[0].resolve(listOf(claude));
		await settle();
		expect(list.isBusy()).toBe(false);
	});

	it('says so for an empty list', async () => {
		await showList(listOf());
		expect(target.querySelector('.empty')?.textContent).toBe('No past conversations');
	});

	it('filters by title, case-insensitively, and Escape clears the filter', async () => {
		const props = await showList(listOf(claude, codex));
		type('login');
		expect(rows().map((r) => r.querySelector('.title')?.textContent)).toEqual(['Fix the Login form']);
		type('nothing like it');
		expect(rows()).toEqual([]);
		expect(target.querySelector('.empty')?.textContent).toBe('No titles match');
		filter().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		flushSync();
		expect(filter().value).toBe('');
		expect(props.onleave).toHaveBeenCalledOnce();
		expect(rows()).toHaveLength(2);
	});

	it('resumes a conversation of either agent in its folder', async () => {
		const props = await showList(listOf(claude, codex));
		row('Fix the Login form').click();
		row('Add a parser').click();
		expect(props.onresume.mock.calls).toEqual([
			['/tmp/repo', `claude --resume ${CLAUDE_ID}`],
			['/tmp/repo/sub', `codex resume ${CODEX_ID}`],
		]);
	});

	it('marks a conversation a running session holds open, and selects that session', async () => {
		const props = await showList(listOf(claude), { sessions: [session(7, { conversation: CLAUDE_ID })] });
		const r = row('Fix the Login form');
		expect(r.querySelector('.when')?.textContent).toBe('open');
		expect(r.querySelector('.when')?.classList.contains('open')).toBe(true);
		r.click();
		expect(props.onselect).toHaveBeenCalledWith(7);
		expect(props.onresume).not.toHaveBeenCalled();
	});

	it('knows a running session by its typed resume command alone', async () => {
		const props = await showList(listOf(codex), { sessions: [session(4, { cmd: `codex resume ${CODEX_ID}` })] });
		expect(row('Add a parser').querySelector('.when')?.textContent).toBe('open');
		row('Add a parser').click();
		expect(props.onselect).toHaveBeenCalledWith(4);
		expect(props.onresume).not.toHaveBeenCalled();
	});

	it('reopens a restorable record that holds the conversation', async () => {
		const props = await showList(listOf(claude), {
			sessions: [session(3, { state: 'exited', restorable: true, conversation: CLAUDE_ID })],
		});
		row('Fix the Login form').click();
		expect(props.onreopen).toHaveBeenCalledWith(3);
		expect(props.onresume).not.toHaveBeenCalled();
	});

	it('does nothing for a conversation an earlier run still has processes of', async () => {
		const props = await showList(listOf(claude), {
			sessions: [session(3, { state: 'exited', orphans: [123], conversation: CLAUDE_ID })],
		});
		const r = row('Fix the Login form');
		expect(r.querySelector('.when')?.textContent).toBe('earlier run');
		expect(r.getAttribute('aria-disabled')).toBe('true');
		expect(r.title.split('\n')[2]).toBe('its earlier session still has processes; kill them in the sidebar first');
		r.click();
		expect(props.onresume).not.toHaveBeenCalled();
		expect(props.onreopen).not.toHaveBeenCalled();
		expect(props.onselect).not.toHaveBeenCalled();
	});

	it('only selects while disabled', async () => {
		const props = await showList(listOf(claude, codex), {
			disabled: true,
			sessions: [session(7, { conversation: CODEX_ID })],
		});
		expect(row('Fix the Login form').getAttribute('aria-disabled')).toBe('true');
		expect(row('Add a parser').hasAttribute('aria-disabled')).toBe(false);
		row('Fix the Login form').click();
		row('Add a parser').click();
		expect(props.onresume).not.toHaveBeenCalled();
		expect(props.onselect).toHaveBeenCalledWith(7);
		props.disabled = false;
		flushSync();
		row('Fix the Login form').click();
		expect(props.onresume).toHaveBeenCalledOnce();
	});

	it('loads again on refresh, two during a run making one more', async () => {
		await showList(listOf(claude));
		const list = shown as unknown as { refresh: () => Promise<void> };
		void list.refresh();
		expect(load).toHaveBeenCalledTimes(2);
		void list.refresh();
		void list.refresh();
		expect(load).toHaveBeenCalledTimes(2);
		loads[1].resolve(listOf(claude, codex));
		await settle();
		expect(load).toHaveBeenCalledTimes(3);
		loads[2].resolve(listOf(codex));
		await settle();
		expect(load).toHaveBeenCalledTimes(3);
		expect(rows().map((r) => r.querySelector('.title')?.textContent)).toEqual(['Add a parser']);
	});

	it('keeps the rows on a failed load, shows why above them and reports it once', async () => {
		const props = await showList(listOf(claude));
		const list = shown as unknown as { refresh: () => Promise<void> };
		void list.refresh();
		loads[1].reject(new Error('disk gone'));
		await settle();
		expect(target.querySelector('.error')?.textContent).toBe('disk gone');
		expect(rows()).toHaveLength(1);
		void list.refresh();
		loads[2].reject(new Error('disk gone'));
		await settle();
		expect(props.report.mock.calls).toEqual([['listing past conversations in repo failed: disk gone']]);
	});

	it('tells how many rows were left out', async () => {
		const entries = Array.from({ length: 500 }, (_, i) => ({ ...claude, id: `${String(i).padStart(8, '0')}-2222-3333-4444-555555555555` }));
		await showList({ entries, total: 501 });
		expect(target.querySelector('.more')?.textContent?.trim()).toBe('1 more not shown');
	});

	it('drops an answer that comes after it is gone', async () => {
		const props = show();
		unmount(shown!);
		shown = undefined;
		// A failure is what would show: an unmounted list has no rows to see.
		loads[0].reject(new Error('late'));
		await settle();
		expect(props.report).not.toHaveBeenCalled();
	});
});
