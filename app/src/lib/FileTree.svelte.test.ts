// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileTree from './FileTree.svelte';
import { onFolderChanged, readFolder, setWatched, type Listing, type Refused } from './files';

const opener = vi.hoisted(() => ({ revealItemInDir: vi.fn(async (_path: string) => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => opener);

// What the mocked commands see and do: the folders on "disk", the order of
// listening, setting and reading, the reads held back by a test, and the
// listener the tree installed.
const fake = vi.hoisted(() => ({
	disk: {} as Record<string, Listing>,
	log: [] as string[],
	gates: new Map<string, Promise<void>>(),
	run: undefined as ((folders: string[]) => void) | undefined,
	unlisten: (() => {}) as () => void,
}));

vi.mock('./files', () => ({
	readFolder: vi.fn(),
	setWatched: vi.fn(),
	onFolderChanged: vi.fn(),
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

// Holds every read of path until the returned function is called.
function gate(path: string): () => void {
	const h = hold<void>();
	fake.gates.set(path, h.promise);
	return () => {
		fake.gates.delete(path);
		h.resolve();
	};
}

// A listing of names, a trailing slash marking a folder.
const listing = (...names: string[]): Listing => ({
	entries: names.map((n) =>
		n.endsWith('/') ? { name: n.slice(0, -1), dir: true, ignored: false } : { name: n, dir: false, ignored: false },
	),
	total: names.length,
	canonical: '',
});

// Each test gets a root of its own, as the expanded folders are remembered by
// root for the module's life.
let roots = 0;
let root: string;
const at = (rel: string) => `${root}/${rel}`;

let target: HTMLElement;
let tree: ReturnType<typeof mount> | undefined;

function show(highlight?: string) {
	const props = $state({ root, highlight, onopen: vi.fn(), report: vi.fn() });
	target = document.createElement('div');
	document.body.append(target);
	tree = mount(FileTree, { target, props });
	flushSync();
	return props;
}

function hide() {
	unmount(tree!);
	tree = undefined;
	flushSync();
}

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	flushSync();
}

const rows = () => [...target.querySelectorAll<HTMLElement>('.row')];
const names = () => rows().map((r) => r.textContent?.trim());
const row = (name: string) => rows().find((r) => r.textContent?.trim() === name)!;
const error = () => target.querySelector('.error')?.textContent;
const reads = () => vi.mocked(readFolder).mock.calls.map((c) => c[0]);
const sets = () => vi.mocked(setWatched).mock.calls;
const lastSet = () => sets().at(-1)![1];

async function click(el: HTMLElement) {
	el.click();
	flushSync();
	await settle();
}

beforeEach(() => {
	root = `/tmp/repo${++roots}`;
	fake.disk = {};
	fake.log = [];
	fake.gates.clear();
	fake.run = undefined;
	fake.unlisten = vi.fn();
	vi.mocked(readFolder)
		.mockReset()
		.mockImplementation(async (path) => {
			fake.log.push(`read ${path}`);
			await fake.gates.get(path);
			const l = fake.disk[path];
			if (!l) throw new Error('no such file');
			return structuredClone(l);
		});
	vi.mocked(setWatched)
		.mockReset()
		.mockImplementation(async (_generation, folders) => {
			fake.log.push(`set ${folders.join(' ')}`);
			return [];
		});
	vi.mocked(onFolderChanged)
		.mockReset()
		.mockImplementation(async (run) => {
			fake.log.push('listen');
			fake.run = run;
			return fake.unlisten;
		});
});

afterEach(() => {
	if (tree) unmount(tree);
	tree = undefined;
	target?.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('FileTree', () => {
	it('listens, then watches the root alone, and reads it only once the watch is set', async () => {
		fake.disk[root] = listing('a.ts');
		const listened = hold<() => void>();
		vi.mocked(onFolderChanged).mockImplementationOnce((run) => {
			fake.log.push('listen');
			fake.run = run;
			return listened.promise;
		});
		const set = hold<Refused[]>();
		vi.mocked(setWatched).mockImplementationOnce((_g, folders) => {
			fake.log.push(`set ${folders.join(' ')}`);
			return set.promise;
		});
		show();
		await settle();
		expect(fake.log).toEqual(['listen']);
		listened.resolve(fake.unlisten);
		await settle();
		expect(fake.log).toEqual(['listen', `set ${root}`]);
		expect(reads()).toEqual([]);
		set.resolve([]);
		await settle();
		expect(fake.log).toEqual(['listen', `set ${root}`, `read ${root}`]);
		expect(names()).toEqual(['a.ts']);
	});

	it('shows the rows in the order the listing came in', async () => {
		fake.disk[root] = listing('A/', 'b/', 'B.txt', 'file2', 'file10');
		show();
		await settle();
		expect(names()).toEqual(['A', 'b', 'B.txt', 'file2', 'file10']);
		expect(row('A').getAttribute('aria-expanded')).toBe('false');
		expect(row('file2').hasAttribute('aria-expanded')).toBe(false);
	});

	it('draws each row its kind icon, a folder open while expanded, without changing its name', async () => {
		fake.disk[root] = listing('src/', 'a.ts');
		fake.disk[at('src')] = listing('b.md');
		show();
		await settle();
		const kind = (name: string) => row(name).querySelector<SVGElement>('.kind svg')!.dataset.icon;
		expect(kind('src')).toBe('folder');
		expect(kind('a.ts')).toBe('code-bracket');
		await click(row('src'));
		expect(kind('src')).toBe('folder-open');
		expect(kind('b.md')).toBe('document-text');
		expect(names()).toEqual(['src', 'b.md', 'a.ts']);
	});

	it('draws one indent guide per depth', async () => {
		fake.disk[root] = listing('src/');
		fake.disk[at('src')] = listing('lib/');
		fake.disk[at('src/lib')] = listing('a.ts');
		show();
		await settle();
		await click(row('src'));
		await click(row('lib'));
		const guides = (name: string) => [...row(name).querySelectorAll<HTMLElement>('.guide')].map((g) => g.style.left);
		expect(guides('src')).toEqual([]);
		expect(guides('lib')).toEqual(['15px']);
		expect(guides('a.ts')).toEqual(['15px', '27px']);
	});

	it('marks an ignored entry, and still highlights it when it is the shown tab', async () => {
		fake.disk[root] = {
			...listing('a.ts'),
			entries: [
				{ name: 'dist', dir: true, ignored: true },
				{ name: '.env', dir: false, ignored: true },
				{ name: 'a.ts', dir: false, ignored: false },
			],
			total: 3,
		};
		show(at('.env'));
		await settle();
		expect(row('dist').classList.contains('ignored')).toBe(true);
		expect(row('.env').classList.contains('ignored')).toBe(true);
		expect(row('.env').getAttribute('aria-current')).toBe('true');
		expect(row('a.ts').classList.contains('ignored')).toBe(false);
	});

	it('watches an expanded folder, reads every shown folder again, and drops it on a collapse', async () => {
		fake.disk[root] = listing('src/', 'z.ts');
		fake.disk[at('src')] = listing('lib.ts');
		show();
		await settle();
		// Added while only the root was watched, and seen by the read after the set.
		fake.disk[root] = listing('src/', 'new.ts', 'z.ts');
		vi.mocked(readFolder).mockClear();
		await click(row('src'));
		expect(lastSet()).toEqual([root, at('src')]);
		expect(reads()).toEqual([root, at('src')]);
		expect(names()).toEqual(['src', 'lib.ts', 'new.ts', 'z.ts']);
		expect(row('src').getAttribute('aria-expanded')).toBe('true');
		expect(row('lib.ts').style.paddingLeft).toBe('20px');
		expect(row('z.ts').style.paddingLeft).toBe('8px');
		await click(row('src'));
		expect(lastSet()).toEqual([root]);
		expect(names()).toEqual(['src', 'new.ts', 'z.ts']);
	});

	it('takes an expanded child out of the set with its parent, and reads it anew when the parent opens', async () => {
		fake.disk[root] = listing('src/');
		fake.disk[at('src')] = listing('lib/');
		fake.disk[at('src/lib')] = listing('a.ts');
		show();
		await settle();
		await click(row('src'));
		await click(row('lib'));
		expect(lastSet()).toEqual([root, at('src'), at('src/lib')]);
		await click(row('src'));
		expect(lastSet()).toEqual([root]);
		expect(names()).toEqual(['src']);
		fake.disk[at('src/lib')] = listing('a.ts', 'b.ts');
		vi.mocked(readFolder).mockClear();
		await click(row('src'));
		expect(lastSet()).toEqual([root, at('src'), at('src/lib')]);
		expect(reads()).toContain(at('src/lib'));
		expect(names()).toEqual(['src', 'lib', 'a.ts', 'b.ts']);
	});

	it('reads a folder collapsed and expanded again before the collapse was answered', async () => {
		fake.disk[root] = listing('src/');
		fake.disk[at('src')] = listing('a.ts');
		show();
		await settle();
		await click(row('src'));
		const collapse = hold<Refused[]>();
		const expand = hold<Refused[]>();
		vi.mocked(setWatched)
			.mockImplementationOnce(() => collapse.promise)
			.mockImplementationOnce(() => expand.promise);
		row('src').click();
		flushSync();
		fake.disk[at('src')] = listing('a.ts', 'b.ts');
		vi.mocked(readFolder).mockClear();
		await click(row('src'));
		// The old rows went with the collapse, so none show until the read.
		expect(names()).toEqual(['src']);
		collapse.resolve([]);
		await settle();
		expect(reads()).toEqual([]);
		expand.resolve([]);
		await settle();
		expect(reads()).toContain(at('src'));
		expect(names()).toEqual(['src', 'a.ts', 'b.ts']);
	});

	it('discards a read in flight for a folder collapsed meanwhile', async () => {
		fake.disk[root] = listing('src/');
		fake.disk[at('src')] = listing('a.ts');
		show();
		await settle();
		const open = gate(at('src'));
		await click(row('src'));
		expect(reads()).toContain(at('src'));
		await click(row('src'));
		open();
		await settle();
		expect(names()).toEqual(['src']);
		// Expanded again with its set unanswered: a listing the late read had
		// stored would show now.
		vi.mocked(setWatched).mockImplementationOnce(() => hold<Refused[]>().promise);
		await click(row('src'));
		expect(names()).toEqual(['src']);
	});

	it('raises the generation with every call', async () => {
		fake.disk[root] = listing('src/');
		fake.disk[at('src')] = listing();
		show();
		await settle();
		await click(row('src'));
		await click(row('src'));
		hide();
		const gens = sets().map((c) => c[0]);
		expect(gens).toHaveLength(4);
		for (let i = 1; i < gens.length; i++) expect(gens[i]).toBeGreaterThan(gens[i - 1]);
	});

	it('starts its generations above zero, from the clock', async () => {
		fake.disk[root] = listing();
		show();
		await settle();
		expect(sets()[0][0]).toBeGreaterThan(1_000_000_000_000);
	});

	it('stops on a rejected set: the message replaces the rows, and nothing is read after it', async () => {
		vi.useFakeTimers();
		fake.disk[root] = listing('src/', 'a.ts');
		fake.disk[at('src')] = listing('b.ts');
		const p = show();
		await settle();
		// A root read in flight when the set fails.
		fake.run!([root]);
		const open = gate(root);
		vi.advanceTimersByTime(150);
		await settle();
		vi.mocked(setWatched).mockRejectedValueOnce(new Error('too many watches'));
		vi.mocked(readFolder).mockClear();
		await click(row('src'));
		expect(error()).toBe('watching folders failed: too many watches');
		expect(p.report).toHaveBeenCalledWith('watching folders failed: too many watches');
		expect(rows()).toEqual([]);
		expect(reads()).toEqual([]);
		fake.disk[root] = listing('src/', 'a.ts', 'c.ts');
		open();
		await settle();
		expect(error()).toBe('watching folders failed: too many watches');
		fake.run!([root]);
		vi.advanceTimersByTime(150);
		await settle();
		expect(reads()).toEqual([]);
		// No row is left to click.
		expect(rows()).toEqual([]);
	});

	it('reads nothing when the first set is rejected', async () => {
		fake.disk[root] = listing('a.ts');
		vi.mocked(setWatched).mockRejectedValueOnce(new Error('watching folders: no watcher'));
		const p = show();
		await settle();
		expect(error()).toBe('watching folders failed: watching folders: no watcher');
		expect(p.report).toHaveBeenCalledTimes(1);
		expect(reads()).toEqual([]);
	});

	it('shows a listener that failed, and watches nothing', async () => {
		fake.disk[root] = listing('a.ts');
		vi.mocked(onFolderChanged).mockRejectedValueOnce(new Error('no event bus'));
		const p = show();
		await settle();
		expect(error()).toBe('listening for folder changes failed: no event bus');
		expect(p.report).toHaveBeenCalledWith('listening for folder changes failed: no event bus');
		expect(sets()).toEqual([]);
		expect(reads()).toEqual([]);
	});

	it('reads a shown folder once, 150 ms after its last change, and ignores one not shown', async () => {
		vi.useFakeTimers();
		fake.disk[root] = listing('src/', 'a.ts');
		fake.disk[at('src')] = listing();
		show();
		await settle();
		vi.mocked(readFolder).mockClear();
		fake.disk[root] = listing('src/', 'a.ts', 'b.ts');
		fake.run!([root]);
		vi.advanceTimersByTime(100);
		fake.run!([root]);
		vi.advanceTimersByTime(100);
		fake.run!([root, at('src')]);
		vi.advanceTimersByTime(149);
		await settle();
		expect(reads()).toEqual([]);
		vi.advanceTimersByTime(1);
		await settle();
		expect(reads()).toEqual([root]);
		expect(names()).toEqual(['src', 'a.ts', 'b.ts']);
	});

	it('reports a refused folder once and keeps it listed', async () => {
		fake.disk[root] = listing('src/');
		fake.disk[at('src')] = listing('a.ts');
		const p = show();
		await settle();
		vi.mocked(setWatched).mockResolvedValueOnce([{ path: at('src'), error: 'no such file' }]);
		await click(row('src'));
		expect(p.report).toHaveBeenCalledTimes(1);
		expect(p.report).toHaveBeenCalledWith('watching src failed: no such file');
		expect(names()).toEqual(['src', 'a.ts']);
	});

	it('ends a capped folder with how many entries are not shown', async () => {
		fake.disk[root] = { ...listing('a.ts', 'b.ts'), total: 2500 };
		show();
		await settle();
		expect(names()).toEqual(['a.ts', 'b.ts', '2498 more not shown']);
		expect(row('2498 more not shown').tagName).toBe('DIV');
	});

	it('opens a clicked file by its full path and marks the highlighted one', async () => {
		fake.disk[root] = listing('src/', 'a.ts', 'b.ts');
		fake.disk[at('src')] = listing('c.ts');
		const p = show(at('b.ts'));
		await settle();
		expect(row('b.ts').getAttribute('aria-current')).toBe('true');
		expect(row('a.ts').hasAttribute('aria-current')).toBe(false);
		await click(row('src'));
		await click(row('c.ts'));
		expect(p.onopen).toHaveBeenCalledExactlyOnceWith(at('src/c.ts'));
		p.highlight = at('src/c.ts');
		flushSync();
		expect(row('c.ts').getAttribute('aria-current')).toBe('true');
		expect(row('b.ts').hasAttribute('aria-current')).toBe(false);
	});

	it('opens a double-clicked file pinned', async () => {
		fake.disk[root] = listing('a.ts');
		const p = show();
		await settle();
		row('a.ts').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		expect(p.onopen).toHaveBeenCalledExactlyOnceWith(at('a.ts'), true);
	});

	it('marks the highlighted file by its canonical path when the root is reached through a link', async () => {
		fake.disk[root] = { ...listing('a.ts'), canonical: `/private${root}` };
		show(`/private${root}/a.ts`);
		await settle();
		expect(row('a.ts').getAttribute('aria-current')).toBe('true');
	});

	it('closes and stops watching an expanded folder a new listing shows as a file or not at all', async () => {
		fake.disk[root] = listing('src/', 'lib/');
		fake.disk[at('src')] = listing('a.ts');
		fake.disk[at('lib')] = listing('b.ts');
		show();
		await settle();
		await click(row('src'));
		await click(row('lib'));
		expect(lastSet()).toEqual([root, at('src'), at('lib')]);
		// src becomes a link (a row, no folder), lib is removed.
		fake.disk[root] = listing('src');
		fake.run!([root]);
		await new Promise((r) => setTimeout(r, 200));
		await settle();
		expect(lastSet()).toEqual([root]);
		expect(names()).toEqual(['src']);
		// A remount does not bring them back.
		hide();
		fake.disk[root] = listing('src/', 'lib/');
		show();
		await settle();
		expect(lastSet()).toEqual([root]);
	});

	it('collapses a folder that is gone without a report, and one whose read fails with a report', async () => {
		vi.useFakeTimers();
		fake.disk[root] = listing('src/', 'lib/');
		fake.disk[at('src')] = listing('a.ts');
		fake.disk[at('lib')] = listing('b.ts');
		const p = show();
		await settle();
		await click(row('src'));
		await click(row('lib'));
		// Gone: its parent's read, racing this one, takes the row.
		delete fake.disk[at('src')];
		fake.run!([at('src')]);
		vi.advanceTimersByTime(150);
		await settle();
		expect(p.report).not.toHaveBeenCalled();
		expect(row('src').getAttribute('aria-expanded')).toBe('false');
		expect(lastSet()).toEqual([root, at('lib')]);
		// Any other failure is reported.
		vi.mocked(readFolder).mockRejectedValueOnce(new Error('permission denied'));
		fake.run!([at('lib')]);
		vi.advanceTimersByTime(150);
		await settle();
		expect(p.report).toHaveBeenCalledWith('lib: permission denied');
		expect(row('lib').getAttribute('aria-expanded')).toBe('false');
		expect(lastSet()).toEqual([root]);
	});

	it('shows a root that cannot be read', async () => {
		show();
		await settle();
		expect(error()).toBe('no such file');
		expect(rows()).toEqual([]);
	});

	it('sends an empty set above every earlier generation when unmounted, and stops listening', async () => {
		fake.disk[root] = listing('src/');
		fake.disk[at('src')] = listing();
		show();
		await settle();
		await click(row('src'));
		const before = Math.max(...sets().map((c) => c[0]));
		hide();
		expect(lastSet()).toEqual([]);
		expect(sets().at(-1)![0]).toBeGreaterThan(before);
		expect(fake.unlisten).toHaveBeenCalledTimes(1);
	});

	it('stops listening at once when unmounted before the listener was installed', async () => {
		const listened = hold<() => void>();
		vi.mocked(onFolderChanged).mockImplementationOnce(() => listened.promise);
		show();
		hide();
		listened.resolve(fake.unlisten);
		await settle();
		expect(fake.unlisten).toHaveBeenCalledTimes(1);
		expect(sets().map((c) => c[1])).toEqual([[]]);
	});

	it('reads nothing for a set answered after a newer one was sent', async () => {
		fake.disk[root] = listing('src/', 'lib/');
		fake.disk[at('src')] = listing();
		fake.disk[at('lib')] = listing();
		show();
		await settle();
		const older = hold<Refused[]>();
		vi.mocked(setWatched).mockImplementationOnce(() => older.promise);
		const newer = hold<Refused[]>();
		vi.mocked(setWatched).mockImplementationOnce(() => newer.promise);
		await click(row('src'));
		await click(row('lib'));
		vi.mocked(readFolder).mockClear();
		older.resolve([]);
		await settle();
		expect(reads()).toEqual([]);
		newer.resolve([]);
		await settle();
		expect(reads()).toEqual([root, at('src'), at('lib')]);
	});

	it('opens the same folders again when mounted again with the same root, and reads them afresh', async () => {
		fake.disk[root] = listing('src/');
		fake.disk[at('src')] = listing('a.ts');
		show();
		await settle();
		await click(row('src'));
		hide();
		target.remove();
		fake.disk[at('src')] = listing('a.ts', 'b.ts');
		vi.mocked(readFolder).mockClear();
		show();
		await settle();
		expect(lastSet()).toEqual([root, at('src')]);
		expect(reads()).toEqual([root, at('src')]);
		expect(names()).toEqual(['src', 'a.ts', 'b.ts']);
	});

	describe('menu', () => {
		const items = () => [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		const labels = () => items().map((b) => b.textContent?.trim());
		const item = (label: string) => items().find((b) => b.textContent?.trim() === label)!;
		function rightClick(el: HTMLElement): MouseEvent {
			const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
			el.dispatchEvent(e);
			flushSync();
			return e;
		}

		it('copies a row path, marks the row while open, and reports a failure', async () => {
			const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
			fake.disk[root] = listing('src/', 'a.ts');
			const p = show();
			await settle();
			const e = rightClick(row('a.ts'));
			expect(e.defaultPrevented).toBe(true);
			// No Reveal in Finder outside Tauri.
			expect(labels()).toEqual(['Copy path']);
			expect(row('a.ts').classList.contains('menu')).toBe(true);
			item('Copy path').click();
			flushSync();
			expect(write).toHaveBeenCalledWith(at('a.ts'));
			expect(row('a.ts').classList.contains('menu')).toBe(false);
			write.mockRejectedValueOnce(new Error('denied'));
			rightClick(row('src'));
			item('Copy path').click();
			flushSync();
			await vi.waitFor(() => expect(p.report).toHaveBeenCalledWith('copy path failed: denied'));
			expect(write).toHaveBeenLastCalledWith(at('src'));
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

			it('reveals a row in Finder, and reports a failure', async () => {
				fake.disk[root] = listing('src/', 'a.ts');
				const p = show();
				await settle();
				rightClick(row('src'));
				expect(labels()).toEqual(['Reveal in Finder', 'Copy path']);
				item('Reveal in Finder').click();
				flushSync();
				await vi.waitFor(() => expect(opener.revealItemInDir).toHaveBeenCalledWith(at('src')));
				opener.revealItemInDir.mockRejectedValueOnce(new Error('no such file'));
				rightClick(row('a.ts'));
				item('Reveal in Finder').click();
				flushSync();
				await vi.waitFor(() => expect(p.report).toHaveBeenCalledWith('reveal in Finder failed: no such file'));
			});
		});
	});
});
