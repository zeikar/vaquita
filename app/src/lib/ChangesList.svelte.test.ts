// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChangesList from './ChangesList.svelte';
import { gitChanges, onRepoChanged, watchRepo, type Change, type ChangeList } from './files';

// The listener the list installed and what its stop was.
const fake = vi.hoisted(() => ({
	run: undefined as ((root: string) => void) | undefined,
	unlisten: (() => {}) as () => void,
}));

vi.mock('./files', () => ({
	gitChanges: vi.fn(),
	watchRepo: vi.fn(),
	onRepoChanged: vi.fn(),
}));

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

const change = (path: string, status: Change['status'], added: number | null, removed: number | null, from: string | null = null): Change => ({
	path,
	abs: `${root}/${path}`,
	status,
	added,
	removed,
	from,
});
const list = (...entries: Change[]): ChangeList => ({ root, entries, total: entries.length });

// Each test gets a root of its own, as the lists are kept by root for the module's life.
let roots = 0;
let root: string;

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;

function show(highlight?: string) {
	const props = $state({ root, highlight, onopen: vi.fn(), report: vi.fn() });
	target = document.createElement('div');
	document.body.append(target);
	shown = mount(ChangesList, { target, props });
	flushSync();
	return props;
}

function hide() {
	unmount(shown!);
	shown = undefined;
	flushSync();
}

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	flushSync();
}

const rows = () => [...target.querySelectorAll<HTMLButtonElement>('button.row')];
const texts = () => rows().map((r) => r.textContent?.replace(/\s+/g, ' ').trim());
const error = () => target.querySelector('.error')?.textContent;
const watches = () => vi.mocked(watchRepo).mock.calls;

beforeEach(() => {
	root = `/tmp/repo${++roots}`;
	fake.run = undefined;
	fake.unlisten = vi.fn();
	vi.mocked(gitChanges).mockReset().mockResolvedValue({ root: '', entries: [], total: 0 });
	vi.mocked(watchRepo).mockReset().mockResolvedValue();
	vi.mocked(onRepoChanged)
		.mockReset()
		.mockImplementation(async (run) => {
			fake.run = run;
			return fake.unlisten;
		});
});

afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target?.remove();
	vi.restoreAllMocks();
});

describe('ChangesList', () => {
	it('shows each row with its letter, path and counts', async () => {
		vi.mocked(gitChanges).mockResolvedValue(
			list(change('src/a.ts', 'M', 3, 1), change('new.txt', 'U', 2, 0), change('img.png', 'A', null, null), change('b.ts', 'R', 0, 0, 'old/b.ts')),
		);
		show();
		await settle();
		expect(texts()).toEqual(['M src/a.ts +3 −1', 'U new.txt +2 −0', 'A img.png', 'R b.ts +0 −0']);
		expect(rows()[0].querySelector('.dir')?.textContent).toBe('src/');
		expect(rows()[3].title).toBe('from old/b.ts');
	});

	it('says so when there is nothing, and how many rows were left out', async () => {
		show();
		await settle();
		expect(target.textContent).toContain('No changes');
		hide();
		vi.mocked(gitChanges).mockResolvedValue({ root, entries: [change('a', 'M', 1, 0)], total: 2001 });
		show();
		await settle();
		expect(target.querySelector('.more')?.textContent).toContain('2000 more not shown');
	});

	it('opens a clicked row as a preview, a double-clicked one pinned, and marks the shown one', async () => {
		vi.mocked(gitChanges).mockResolvedValue(list(change('a.ts', 'M', 1, 0), change('b.ts', 'M', 1, 0)));
		const props = show(`${root}/b.ts`);
		await settle();
		rows()[0].click();
		rows()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(props.onopen.mock.calls).toEqual([[`${root}/a.ts`], [`${root}/a.ts`, true]]);
		expect(rows().map((r) => r.hasAttribute('aria-current'))).toEqual([false, true]);
	});

	it('watches the root while mounted and stops with a higher generation', async () => {
		show();
		await settle();
		expect(watches()).toHaveLength(1);
		expect(watches()[0][1]).toBe(root);
		hide();
		expect(fake.unlisten).toHaveBeenCalledOnce();
		expect(watches()).toHaveLength(2);
		expect(watches()[1][1]).toBeNull();
		expect(watches()[1][0]).toBeGreaterThan(watches()[0][0]);
	});

	it('stops a listener that lands after the unmount and never watches', async () => {
		const listened = hold<() => void>();
		vi.mocked(onRepoChanged).mockImplementationOnce(() => listened.promise);
		show();
		await settle();
		hide();
		listened.resolve(fake.unlisten);
		await settle();
		expect(fake.unlisten).toHaveBeenCalledOnce();
		expect(watches().map((c) => c[1])).toEqual([null]);
		expect(gitChanges).not.toHaveBeenCalled();
	});

	it('refreshes on a change in its root only', async () => {
		show();
		await settle();
		expect(gitChanges).toHaveBeenCalledTimes(1);
		fake.run!(root);
		await settle();
		expect(gitChanges).toHaveBeenCalledTimes(2);
		fake.run!('/tmp/elsewhere');
		await settle();
		expect(gitChanges).toHaveBeenCalledTimes(2);
	});

	it('reports a failed watch and still lists', async () => {
		vi.mocked(watchRepo).mockRejectedValueOnce(new Error('too many watches'));
		vi.mocked(gitChanges).mockResolvedValue(list(change('a.ts', 'M', 1, 0)));
		const props = show();
		await settle();
		expect(props.report).toHaveBeenCalledWith('watching the repo failed: too many watches');
		expect(texts()).toEqual(['M a.ts +1 −0']);
	});

	it('lists without a watch when listening fails, and says so', async () => {
		vi.mocked(onRepoChanged).mockRejectedValueOnce(new Error('no event bus'));
		vi.mocked(gitChanges).mockResolvedValue(list(change('a.ts', 'M', 1, 0)));
		const props = show();
		await settle();
		expect(props.report).toHaveBeenCalledWith('listening for repo changes failed: no event bus');
		expect(watches()).toEqual([]);
		expect(texts()).toEqual(['M a.ts +1 −0']);
	});

	// The status line hears of it from the panel, through changeLists.onFailed.
	it('keeps the rows over a failed refresh and says so above them, reporting nothing itself', async () => {
		vi.mocked(gitChanges).mockResolvedValue(list(change('a.ts', 'M', 1, 0)));
		const props = show();
		await settle();
		vi.mocked(gitChanges).mockRejectedValue(new Error('git exited with 128'));
		fake.run!(root);
		await settle();
		expect(texts()).toEqual(['M a.ts +1 −0']);
		expect(error()).toBe('git exited with 128');
		expect(target.firstElementChild?.firstElementChild?.classList.contains('error')).toBe(true);
		expect(props.report).not.toHaveBeenCalled();
	});
});
