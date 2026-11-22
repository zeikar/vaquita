// @vitest-environment happy-dom
// Named .svelte.test.ts so that the store's runes compile; in the client
// build, as vitest makes the server one for node, where effects never run.
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, connected, fakeTimersAndStorage, info } from './manager-harness';
import { LAST_CWD } from './NewSessionDialog.svelte';
import type { SessionInfo } from './protocol';
import { diffTab } from './changes';
import { OTHER, TABS_KEY, WELCOME } from './tabs';
import { Tabs, type TabDocuments, type TabsDeps } from './tabs.svelte';

fakeTimersAndStorage();

const repo = '/tmp/repo';
const a = `${repo}/a.md`;
const b = `${repo}/b.md`;

// The documents as far as Tabs uses them, with what it asked of them.
function fakeDocuments(dirty: string[] = []) {
	const listeners = new Set<(path: string, dirty: boolean) => void>();
	const calls = { isDirty: [] as string[], dropped: [] as string[], saved: [] as string[] };
	const docs: TabDocuments = {
		isDirty: (p) => {
			calls.isDirty.push(p);
			return dirty.includes(p);
		},
		dropDocument: (p) => void calls.dropped.push(p),
		onDirtyChange: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		saveDocument: async (p) => void calls.saved.push(p),
	};
	const tell = (path: string, d: boolean) => {
		for (const l of listeners) l(path, d);
	};
	return { docs, calls, tell, listeners };
}

// The store's effects need an owner, as App's script is in the app.
let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

// dirty is what isDirty answers; tell is what turns a document dirty for the store.
async function make(list = [info(1), info(2)], dirty: string[] = [], selected?: number, open?: TabsDeps<never, never>['open']) {
	const t = await connected(list, selected);
	const d = fakeDocuments(dirty);
	const ask = vi.fn(async (_message: string, _okLabel: string) => false);
	const closeWindow = vi.fn(async () => {});
	const build = () => new Tabs({ manager: t.m, documents: d.docs, ask, closeWindow, open });
	let tabs: ReturnType<typeof build> | undefined;
	cleanup = $effect.root(() => {
		tabs = build();
	});
	flushSync();
	return { ...t, ...d, tabs: tabs!, ask, closeWindow };
}

const stored = () => JSON.parse(localStorage.getItem(TABS_KEY) ?? '{}');

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => (resolve = res));
	return { promise, resolve };
}

describe('Tabs', () => {
	it("is the group's stored order with its sessions' tabs added, and none before the repo list", async () => {
		localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [b, 'session:2', a] }));
		const { tabs, c } = await make();
		tabs.group = repo;
		expect(tabs.groupTabs).toEqual([b, a]);
		c.emit.repos([repo]);
		expect(tabs.groupTabs).toEqual([b, 'session:2', a, 'session:1']);
	});

	it('shows no tabs with no group', async () => {
		const { tabs, c } = await make();
		c.emit.repos([repo]);
		expect(tabs.groupTabs).toEqual([]);
	});

	it('has the group as its root, but for Other and no group', async () => {
		const { tabs } = await make();
		expect(tabs.root).toBeUndefined();
		tabs.group = repo;
		expect(tabs.root).toBe(repo);
		tabs.group = OTHER;
		expect(tabs.root).toBeUndefined();
	});

	it("follows the manager's selection", async () => {
		const { tabs, m } = await make();
		expect(tabs.selectedRow).toBeUndefined();
		m.select(2);
		expect(tabs.selectedRow?.info.sid).toBe(2);
		m.select(1);
		expect(tabs.selectedRow?.info.sid).toBe(1);
	});

	it('keeps a document turning dirty in dirty and as no preview, until it is clean', async () => {
		const { tabs, tell } = await make();
		tabs.previews = { [repo]: a, [OTHER]: a, '/tmp/other': b };
		tell(a, true);
		expect([...tabs.dirty]).toEqual([a]);
		expect(tabs.previews).toEqual({ '/tmp/other': b });
		tell(a, false);
		expect([...tabs.dirty]).toEqual([]);
	});

	it('hears neither the manager nor the documents after stop', async () => {
		const { tabs, m, tell, listeners } = await make();
		tabs.stop();
		m.select(2);
		tell(a, true);
		expect(tabs.selectedRow).toBeUndefined();
		expect(tabs.dirty.size).toBe(0);
		expect(listeners.size).toBe(0);
	});

	describe('showing', () => {
		// A repo with two files stored and two sessions, the lists in.
		async function shown() {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a, b] }));
			const t = await make();
			t.c.emit.repos([repo]);
			t.tabs.group = repo;
			return t;
		}

		// The panes as far as focusing them goes.
		function panes(tabs: Pick<Tabs, 'filePane' | 'repoWelcome' | 'appWelcome'>) {
			const p = { file: vi.fn(), repo: vi.fn(), app: vi.fn() };
			tabs.filePane = { focus: p.file, relayout: () => {} } as never;
			tabs.repoWelcome = { focus: p.repo } as never;
			tabs.appWelcome = { focus: p.app } as never;
			return p;
		}

		it("shows a tab, selecting a session's and recording each for the group", async () => {
			const { tabs, state } = await shown();
			await tabs.show('session:2');
			expect(tabs.active).toBe('session:2');
			expect(state().selected).toBe(2);
			await tabs.show(b);
			expect(tabs.active).toBe(b);
			expect(state().selected).toBe(2);
			// Closing it goes back to the tab recorded before it, not to the first.
			tabs.closeActive();
			await vi.advanceTimersByTimeAsync(0);
			expect(tabs.active).toBe('session:2');
		});

		it("shows no file and no welcome under the dialog, but a session's tab", async () => {
			const { tabs } = await shown();
			await tabs.show(a);
			tabs.dialogOpen = true;
			await tabs.show(b);
			await tabs.show(WELCOME);
			expect(tabs.active).toBe(a);
			await tabs.show('session:1');
			expect(tabs.active).toBe('session:1');
		});

		it('focuses what shows, and nothing under the dialog', async () => {
			const { tabs, c, row } = await shown();
			answer(c, 1);
			const p = panes(tabs);
			await tabs.show('session:1');
			const view = row(1)!.view!;
			const focuses = view.focuses;
			tabs.refocus();
			expect(view.focuses).toBe(focuses + 1);
			tabs.active = a;
			tabs.refocus();
			expect(p.file).toHaveBeenCalledTimes(1);
			tabs.active = WELCOME;
			tabs.refocus();
			expect(p.repo).toHaveBeenCalledTimes(1);
			tabs.active = undefined;
			tabs.refocus();
			expect(p.app).toHaveBeenCalledTimes(1);
			tabs.dialogOpen = true;
			tabs.refocus();
			expect(p.app).toHaveBeenCalledTimes(1);
		});

		it('steps round the tabs, and not under the dialog', async () => {
			const { tabs } = await shown();
			expect(tabs.groupTabs).toEqual([a, b, 'session:1', 'session:2']);
			tabs.active = 'session:2';
			tabs.step(1);
			expect(tabs.active).toBe(a);
			tabs.step(-1);
			expect(tabs.active).toBe('session:2');
			tabs.dialogOpen = true;
			tabs.step(1);
			expect(tabs.active).toBe('session:2');
		});

		it("changes nothing under the shortcut list, but shows a session's tab", async () => {
			const { tabs, c, row } = await shown();
			answer(c, 1);
			const p = panes(tabs);
			await tabs.show(a);
			p.file.mockClear();
			tabs.openShortcuts();
			expect(tabs.shortcutsOpen).toBe(true);
			tabs.step(1);
			tabs.showAt(2);
			tabs.openWelcome(repo);
			await tabs.show(b);
			expect(tabs.active).toBe(a);
			const view = row(1)!.view!;
			const focuses = view.focuses;
			tabs.refocus();
			expect(view.focuses).toBe(focuses);
			expect(p.file).not.toHaveBeenCalled();
			await tabs.show('session:1');
			expect(tabs.active).toBe('session:1');
			expect(view.focuses).toBe(focuses);
		});

		it('shows a tab by its number, none past the last', async () => {
			const { tabs } = await shown();
			tabs.showAt(2);
			expect(tabs.active).toBe(b);
			tabs.showAt(5);
			expect(tabs.active).toBe(b);
		});

		it("shows a selected session's tab when its row or its notification asks", async () => {
			const { tabs, m } = await shown();
			m.select(1);
			tabs.active = a;
			tabs.selectSession(1);
			expect(tabs.active).toBe('session:1');
			tabs.active = a;
			tabs.openNotified({ sid: 1, inc: 'i' });
			expect(tabs.active).toBe('session:1');
		});

		it('leaves showing the tab of a session newly selected to the selection', async () => {
			const { tabs, m, state } = await shown();
			m.select(1);
			tabs.active = a;
			tabs.selectSession(2);
			expect(state().selected).toBe(2);
			expect(tabs.active).toBe(a);
		});

		it("deselects another repo's session for a welcome, and keeps one of its own", async () => {
			const t = await make([info(1), { ...info(2), cwd: '/tmp/other' }]);
			t.c.emit.repos([repo, '/tmp/other']);
			t.m.select(2);
			t.tabs.openWelcome(repo);
			expect(t.state().selected).toBeUndefined();
			expect(t.tabs.group).toBe(repo);
			expect(t.tabs.active).toBe(WELCOME);
			t.m.select(1);
			t.tabs.openWelcome(repo);
			expect(t.state().selected).toBe(1);
		});

		it("shows Other's most recent tab", async () => {
			const x = '/tmp/x.md';
			const y = '/tmp/y.md';
			localStorage.setItem(TABS_KEY, JSON.stringify({ [OTHER]: [x, y] }));
			const { tabs, c, m, state } = await make();
			c.emit.repos([repo]);
			tabs.group = OTHER;
			await tabs.show(y);
			tabs.group = repo;
			m.select(1);
			tabs.openOther();
			expect(tabs.group).toBe(OTHER);
			expect(tabs.active).toBe(y);
			expect(state().selected).toBeUndefined();
		});

		describe('stepping between repos', () => {
			const other = '/tmp/other';
			const oa = `${other}/a.md`;
			const ob = `${other}/b.md`;
			// Two repos, file tabs and a session in each (session 1 in repo, 2 in other); no group yet.
			async function two() {
				localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a, b], [other]: [oa, ob] }));
				const t = await make([info(1), { ...info(2), cwd: other }]);
				t.c.emit.repos([repo, other]);
				return t;
			}

			it('steps forward and back round the repos in list order', async () => {
				const { tabs } = await two();
				tabs.group = repo;
				tabs.stepRepo(1);
				expect(tabs.group).toBe(other);
				tabs.stepRepo(1);
				expect(tabs.group).toBe(repo);
				tabs.stepRepo(-1);
				expect(tabs.group).toBe(other);
			});

			it('opens a repo not viewed yet on its welcome, deselecting the other repo\'s session', async () => {
				const { tabs, m, state } = await two();
				tabs.group = repo;
				m.select(1);
				tabs.stepRepo(1);
				expect(tabs.group).toBe(other);
				expect(tabs.active).toBe(WELCOME);
				expect(state().selected).toBeUndefined();
			});

			it("comes back to a session's tab shown last, selecting the session", async () => {
				const { tabs, state } = await two();
				tabs.group = other;
				await tabs.show(oa);
				await tabs.show('session:2');
				tabs.stepRepo(-1);
				flushSync();
				expect(state().selected).toBeUndefined();
				tabs.stepRepo(1);
				flushSync();
				expect(tabs.group).toBe(other);
				expect(tabs.active).toBe('session:2');
				expect(state().selected).toBe(2);
			});

			it('comes back to a file tab shown last, leaving no session selected', async () => {
				const { tabs, state } = await two();
				tabs.group = other;
				await tabs.show('session:2');
				await tabs.show(oa);
				tabs.stepRepo(-1);
				flushSync();
				tabs.stepRepo(1);
				flushSync();
				expect(tabs.group).toBe(other);
				expect(tabs.active).toBe(oa);
				expect(state().selected).toBeUndefined();
			});

			it('skips a recent tab that was closed', async () => {
				const { tabs } = await two();
				tabs.group = other;
				await tabs.show(oa);
				await tabs.show(ob);
				tabs.stepRepo(-1);
				// The tab leaves while its group is not the shown one, as a repo list can move it.
				tabs.groups = { ...tabs.groups, [other]: [oa] };
				tabs.stepRepo(1);
				expect(tabs.group).toBe(other);
				expect(tabs.active).toBe(oa);
			});

			it('lands on the first repo going forward from no group, the last going back', async () => {
				const { tabs } = await two();
				expect(tabs.group).toBeUndefined();
				tabs.stepRepo(1);
				expect(tabs.group).toBe(repo);
				tabs.group = undefined;
				tabs.stepRepo(-1);
				expect(tabs.group).toBe(other);
			});

			it('has no Other stop while Other has no tabs', async () => {
				const { tabs } = await two();
				tabs.group = other;
				tabs.stepRepo(1);
				expect(tabs.group).toBe(repo);
			});

			it('has Other as a stop with a file tab there, shown as openOther shows it', async () => {
				const x = '/tmp/x.md';
				localStorage.setItem(TABS_KEY, JSON.stringify({ [OTHER]: [x] }));
				const { tabs, c } = await make();
				c.emit.repos([repo]);
				tabs.group = repo;
				tabs.stepRepo(1);
				expect(tabs.group).toBe(OTHER);
				expect(tabs.active).toBe(x);
				tabs.stepRepo(1);
				expect(tabs.group).toBe(repo);
			});

			it('has Other as a stop for a session outside every repo', async () => {
				const t = await make([info(1), { ...info(2), cwd: '/tmp/elsewhere' }]);
				t.c.emit.repos([repo]);
				t.tabs.group = repo;
				t.tabs.stepRepo(1);
				expect(t.tabs.group).toBe(OTHER);
				expect(t.tabs.active).toBe('session:2');
			});

			it('does nothing when the only stop shows', async () => {
				const { tabs, c } = await make();
				c.emit.repos([repo]);
				tabs.group = repo;
				tabs.stepRepo(1);
				tabs.stepRepo(-1);
				expect(tabs.group).toBe(repo);
				expect(tabs.active).toBeUndefined();
			});

			it('does nothing under the dialog', async () => {
				const { tabs } = await two();
				tabs.group = repo;
				tabs.dialogOpen = true;
				tabs.stepRepo(1);
				expect(tabs.group).toBe(repo);
			});

			it('does nothing under the shortcut list', async () => {
				const { tabs } = await two();
				tabs.group = repo;
				tabs.openShortcuts();
				tabs.stepRepo(1);
				expect(tabs.group).toBe(repo);
			});

			it('does nothing before the repo list', async () => {
				localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a], [OTHER]: ['/tmp/x.md'] }));
				const { tabs } = await make();
				tabs.group = repo;
				tabs.stepRepo(1);
				expect(tabs.group).toBe(repo);
			});
		});

		it('starts a new session in the shown repo, else the last folder, else nowhere', async () => {
			const { tabs } = await make();
			tabs.group = repo;
			tabs.newSession();
			expect(tabs.dialogOpen).toBe(true);
			expect(tabs.dialogCwd).toBe(repo);
			tabs.group = OTHER;
			tabs.newSession();
			expect(tabs.dialogCwd).toBe(repo);
			tabs.dialogOpen = false;
			localStorage.setItem(LAST_CWD, '/tmp/last');
			tabs.newSession();
			expect(tabs.dialogCwd).toBe('/tmp/last');
			tabs.dialogOpen = false;
			tabs.group = undefined;
			localStorage.removeItem(LAST_CWD);
			tabs.newSession();
			expect(tabs.dialogCwd).toBe('');
		});
	});

	describe('starting an agent', () => {
		it('creates it in the shown repo with no name and no dialog', async () => {
			const { tabs, m } = await make();
			const create = vi.spyOn(m, 'create');
			tabs.group = repo;
			tabs.startAgent('claude');
			expect(create).toHaveBeenCalledWith(repo, 'claude', '');
			expect(tabs.dialogOpen).toBe(false);
		});

		it('opens the dialog on that kind with no repo shown, and newSession resets it', async () => {
			const { tabs, m } = await make();
			const create = vi.spyOn(m, 'create');
			localStorage.setItem(LAST_CWD, '/tmp/last');
			tabs.group = OTHER;
			tabs.startAgent('codex');
			expect(tabs.dialogOpen).toBe(true);
			expect(tabs.dialogCmd).toBe('codex');
			expect(tabs.dialogCwd).toBe('/tmp/last');
			tabs.dialogOpen = false;
			tabs.group = undefined;
			tabs.startAgent('claude');
			expect(tabs.dialogCmd).toBe('claude');
			expect(tabs.dialogCwd).toBe('/tmp/last');
			tabs.dialogOpen = false;
			tabs.newSession();
			expect(tabs.dialogCmd).toBe('');
			expect(create).not.toHaveBeenCalled();
		});

		it('does nothing under the dialog', async () => {
			const { tabs, m } = await make();
			const create = vi.spyOn(m, 'create');
			tabs.group = repo;
			tabs.dialogOpen = true;
			tabs.startAgent('claude');
			expect(create).not.toHaveBeenCalled();
		});
	});

	describe('under the shortcut list', () => {
		it('starts no session and opens no dialog', async () => {
			const { tabs, m } = await make();
			const create = vi.spyOn(m, 'create');
			tabs.group = repo;
			tabs.openShortcuts();
			tabs.startAgent('claude');
			tabs.newSession();
			expect(create).not.toHaveBeenCalled();
			expect(tabs.dialogOpen).toBe(false);
		});
	});

	describe('opening', () => {
		it('opens a preview, replaced by the next file, a dirty one pinned, each saved', async () => {
			const c = `${repo}/c.md`;
			const t = await make(undefined, [c]);
			t.c.emit.repos([repo]);
			t.tabs.openFile(repo, a);
			expect(t.tabs.active).toBe(a);
			expect(t.tabs.previews[repo]).toBe(a);
			expect(stored()).toEqual({ [repo]: [a] });
			t.tabs.openFile(repo, b);
			expect(t.tabs.groups[repo]).toEqual([b]);
			expect(t.calls.dropped).toEqual([a]);
			expect(stored()).toEqual({ [repo]: [b] });
			t.tabs.openFile(repo, c);
			expect(t.tabs.groups[repo]).toEqual([b, c]);
			expect(t.tabs.previews[repo]).toBe(b);
			expect(stored()).toEqual({ [repo]: [b, c] });
		});

		it('records where a file opened at a line is to go, anew for each click, until taken or another tab shows', async () => {
			const t = await make();
			t.c.emit.repos([repo]);
			t.tabs.openFile(repo, a, false, { line: 3, col: 2 });
			const first = t.tabs.reveal;
			expect(first).toEqual({ path: a, line: 3, col: 2 });
			// Taken by the editor; one taken already is not taken again.
			t.tabs.revealed(first!);
			expect(t.tabs.reveal).toBeUndefined();
			// The tab already shows: a second click still goes there.
			t.tabs.openFile(repo, a, false, { line: 3, col: 2 });
			expect(t.tabs.reveal).toEqual({ path: a, line: 3, col: 2 });
			expect(t.tabs.reveal).not.toBe(first);
			t.tabs.revealed(first!);
			expect(t.tabs.reveal).toBeDefined();
			// Another tab shown drops it, as does an open with no line.
			await t.tabs.show(b);
			expect(t.tabs.reveal).toBeUndefined();
			t.tabs.openFile(repo, a, false, { line: 5 });
			t.tabs.openFile(repo, a);
			expect(t.tabs.reveal).toBeUndefined();
		});

		it("opens a diff in the shown repo's group, and none with no repo shown", async () => {
			const { tabs } = await make();
			tabs.openDiff(a);
			tabs.group = OTHER;
			tabs.openDiff(a);
			expect(tabs.groups).toEqual({});
			expect(tabs.active).toBeUndefined();
			tabs.group = repo;
			tabs.openDiff(a);
			expect(tabs.groups[repo]).toEqual([diffTab(a)]);
			expect(tabs.active).toBe(diffTab(a));
		});

		it('keeps a pinned preview when the next file opens', async () => {
			const { tabs, c } = await make();
			c.emit.repos([repo]);
			tabs.openFile(repo, a);
			tabs.pin(a);
			expect(tabs.previews[repo]).toBeUndefined();
			tabs.openFile(repo, b);
			expect(tabs.groups[repo]).toEqual([a, b]);
		});

		// A double-click in the tree asks the gate three times: click, click, dblclick.
		async function doubleClick(order: number[]) {
			const asked: (() => void)[] = [];
			const open: TabsDeps<never, never>['open'] = (path, _host, _report, onView) =>
				new Promise<void>((done) => asked.push(() => (onView(path), done())));
			const t = await make(undefined, [], undefined, open);
			t.c.emit.repos([repo]);
			t.tabs.group = repo;
			t.tabs.openFile(repo, a);
			t.tabs.openFromTree(b);
			t.tabs.openFromTree(b);
			t.tabs.openFromTree(b, true);
			for (const i of order) {
				asked[i]();
				await vi.advanceTimersByTimeAsync(0);
			}
			return t.tabs;
		}

		it('keeps a file double-clicked in the tree, its preview replacing the last', async () => {
			const tabs = await doubleClick([0, 1, 2]);
			expect(tabs.groups[repo].filter((k) => !k.startsWith('session:'))).toEqual([b]);
			expect(tabs.previews[repo]).toBeUndefined();
		});

		it("applies the tree's answers in the order asked, a late click undoing no double-click", async () => {
			const tabs = await doubleClick([2, 0, 1]);
			expect(tabs.groups[repo].filter((k) => !k.startsWith('session:'))).toEqual([b]);
			expect(tabs.previews[repo]).toBeUndefined();
		});

		it('opens another file while an earlier one still waits on the gate', async () => {
			const asked = new Map<string, () => void>();
			const open: TabsDeps<never, never>['open'] = (path, _host, _report, onView) =>
				new Promise<void>((done) => asked.set(path, () => (onView(path), done())));
			const t = await make(undefined, [], undefined, open);
			t.c.emit.repos([repo]);
			t.tabs.group = repo;
			t.tabs.openFromTree(a, true);
			t.tabs.openFromTree(b, true);
			asked.get(b)!();
			await vi.advanceTimersByTimeAsync(0);
			expect(t.tabs.active).toBe(b);
		});

		it('stores the order a drag left', async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a, b] }));
			const { tabs } = await make();
			tabs.group = repo;
			tabs.reorder([b, a]);
			expect(tabs.groups[repo]).toEqual([b, a]);
			expect(stored()).toEqual({ [repo]: [b, a] });
		});

		it('saves the shown tab by its path', async () => {
			const { tabs, calls } = await make();
			tabs.save();
			tabs.active = a;
			tabs.save();
			expect(calls.saved).toEqual([a]);
		});
	});

	describe('closing', () => {
		const c3 = `${repo}/c.md`;

		it('asks once for several unsaved files and, declined, closes nothing', async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a, b, c3] }));
			const t = await make(undefined, [a, b]);
			t.tabs.group = repo;
			await t.tabs.show(c3);
			await t.tabs.show(a);
			await t.tabs.close([a, b]);
			expect(t.ask.mock.calls).toEqual([['2 files have unsaved changes. Close them?', 'Close']]);
			expect(t.tabs.groups[repo]).toEqual([a, b, c3]);
			expect(t.tabs.active).toBe(a);
			expect(t.calls.dropped).toEqual([]);
		});

		it('drops the documents once accepted and shows the tab viewed before', async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a, b, c3] }));
			const t = await make(undefined, [a, b]);
			t.ask.mockResolvedValue(true);
			t.tabs.group = repo;
			await t.tabs.show(c3);
			await t.tabs.show(a);
			await t.tabs.close([a, b]);
			expect(t.calls.dropped).toEqual([a, b]);
			expect(t.tabs.groups[repo]).toEqual([c3]);
			expect(stored()).toEqual({ [repo]: [c3] });
			expect(t.tabs.active).toBe(c3);
		});

		it('neither asks about nor drops a path another group still has', async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a], [OTHER]: [a] }));
			const t = await make(undefined, [a]);
			t.tabs.group = repo;
			await t.tabs.close([a]);
			expect(t.ask).not.toHaveBeenCalled();
			expect(t.calls.dropped).toEqual([]);
			expect(t.tabs.groups).toEqual({ [OTHER]: [a] });
		});

		it('closes nothing when the tabs changed under the question so that an unasked edit would go', async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a, b], [OTHER]: [b] }));
			const t = await make(undefined, [a, b]);
			const answer = deferred<boolean>();
			t.ask.mockReturnValue(answer.promise);
			t.tabs.group = repo;
			const closing = t.tabs.close([a, b]);
			expect(t.ask.mock.calls).toEqual([['a.md has unsaved changes. Close it?', 'Close']]);
			t.tabs.groups = { [repo]: [a, b] };
			answer.resolve(true);
			await closing;
			expect(t.calls.dropped).toEqual([]);
			expect(t.tabs.groups).toEqual({ [repo]: [a, b] });
			expect(t.state().report?.text).toBe('The tabs changed while asking; nothing was closed.');
		});

		it('asks once about working sessions and kills only those still the same', async () => {
			const working = (sid: number, inc = 'i'): SessionInfo => ({ ...info(sid, inc), status: { state: 'working' } });
			const t = await make([working(1), working(2), info(3)]);
			const answer = deferred<boolean>();
			t.ask.mockReturnValue(answer.promise);
			const closing = t.tabs.close(['session:1', 'session:2', 'session:3']);
			expect(t.ask).toHaveBeenCalledTimes(1);
			expect(t.ask.mock.calls[0][1]).toBe('Kill');
			t.c.emit.sessions([working(1), working(2, 'j'), info(3)]);
			answer.resolve(true);
			await closing;
			expect(t.c.requests.filter((r) => r[0] === 'kill')).toEqual([['kill', 1], ['kill', 3]]);
		});

		it('closes the shortcut list first, then the dialog, and leaves the shown tab', async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a, b] }));
			const t = await make();
			t.tabs.group = repo;
			await t.tabs.show(a);
			t.tabs.openShortcuts();
			t.tabs.closeActive();
			expect(t.tabs.shortcutsOpen).toBe(false);
			expect(t.tabs.active).toBe(a);
			expect(t.tabs.groups[repo]).toEqual([a, b]);
			t.tabs.dialogOpen = true;
			t.tabs.openShortcuts();
			t.tabs.closeActive();
			expect(t.tabs.shortcutsOpen).toBe(false);
			expect(t.tabs.dialogOpen).toBe(true);
			t.tabs.closeActive();
			expect(t.tabs.dialogOpen).toBe(false);
			expect(t.tabs.groups[repo]).toEqual([a, b]);
		});

		it('kills nothing when the question about a working session is declined', async () => {
			const t = await make([{ ...info(1), status: { state: 'input' } }]);
			await t.tabs.close(['session:1']);
			expect(t.ask).toHaveBeenCalledTimes(1);
			expect(t.c.requests.filter((r) => r[0] === 'kill')).toEqual([]);
		});

		it('closes the dialog, else the shown tab, else a welcome for the last tab, else the window', async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a, b] }));
			const t = await make();
			t.tabs.group = repo;
			await t.tabs.show(b);
			await t.tabs.show(a);
			t.tabs.dialogOpen = true;
			t.tabs.closeActive();
			expect(t.tabs.dialogOpen).toBe(false);
			expect(t.tabs.groups[repo]).toEqual([a, b]);
			t.tabs.closeActive();
			await vi.advanceTimersByTimeAsync(0);
			expect(t.tabs.groups[repo]).toEqual([b]);
			expect(t.tabs.active).toBe(b);
			t.tabs.active = WELCOME;
			t.tabs.closeActive();
			expect(t.tabs.active).toBe(b);
			expect(t.closeWindow).not.toHaveBeenCalled();
			t.tabs.group = undefined;
			t.tabs.active = undefined;
			t.tabs.closeActive();
			expect(t.closeWindow).toHaveBeenCalledTimes(1);
		});

		it('reports a window that would not close', async () => {
			const t = await make();
			t.closeWindow.mockRejectedValue(new Error('no window'));
			t.tabs.closeActive();
			await vi.advanceTimersByTimeAsync(0);
			expect(t.state().report?.text).toBe('closing the window failed: no window');
		});

		it('asks before the app run ends only with something unsaved, counting the files', async () => {
			const t = await make();
			expect(await t.tabs.mayLoseAll('Close the window?', 'Close')).toBe(true);
			expect(t.ask).not.toHaveBeenCalled();
			t.tell(a, true);
			expect(await t.tabs.mayLoseAll('Close the window?', 'Close')).toBe(false);
			t.tell(b, true);
			t.ask.mockResolvedValue(true);
			expect(await t.tabs.mayLoseAll('Update and relaunch?', 'Update')).toBe(true);
			expect(t.ask.mock.calls).toEqual([
				['1 file has unsaved changes. Close the window?', 'Close'],
				['2 files have unsaved changes. Update and relaunch?', 'Update'],
			]);
		});

		it('keeps what a question that could not be asked was about, and reports it', async () => {
			const t = await make();
			t.ask.mockRejectedValue(new Error('no dialog'));
			t.tell(a, true);
			expect(await t.tabs.mayLoseAll('Close the window?', 'Close')).toBe(false);
			expect(t.state().report?.text).toBe('asking about unsaved changes failed: no dialog');
		});
	});

	describe('following the lists', () => {
		const gone = '/tmp/gone';
		const g = `${gone}/g.md`;
		const r2 = '/tmp/repo2';

		it("keeps an unlisted repo's tabs until the daemon's list, then moves them to Other, dropping nothing", async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [gone]: [g] }));
			const { tabs, c, calls } = await make([]);
			expect(tabs.groups).toEqual({ [gone]: [g] });
			c.emit.repos([repo]);
			flushSync();
			expect(tabs.groups).toEqual({ [OTHER]: [g] });
			expect(stored()).toEqual({ [OTHER]: [g] });
			expect(calls.dropped).toEqual([]);
		});

		it('shows a moved file in Other when its repo, shown with no session, goes', async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [gone]: [g] }));
			const { tabs, c } = await make([]);
			tabs.group = gone;
			flushSync();
			c.emit.repos([repo]);
			flushSync();
			expect(tabs.group).toBe(OTHER);
			expect(tabs.active).toBe(g);
		});

		it("adds a new session's tab last to its group and takes a gone one's out", async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a] }));
			const { tabs, c } = await make([info(1)]);
			c.emit.repos([repo]);
			flushSync();
			expect(tabs.groups[repo]).toEqual([a, 'session:1']);
			c.emit.sessions([info(1), info(2)]);
			flushSync();
			expect(tabs.groups[repo]).toEqual([a, 'session:1', 'session:2']);
			c.emit.sessions([info(2)]);
			flushSync();
			expect(tabs.groups[repo]).toEqual([a, 'session:2']);
			expect(stored()).toEqual({ [repo]: [a, 'session:2'] });
		});

		it('falls back from a shown tab that went to the one shown before', async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a, b] }));
			const { tabs, c } = await make();
			c.emit.repos([repo]);
			flushSync();
			tabs.group = repo;
			await tabs.show(b);
			await tabs.show('session:2');
			c.emit.sessions([info(1)]);
			flushSync();
			expect(tabs.active).toBe(b);
		});

		it("falls back to the repo's welcome when its group has no tabs", async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [r2]: [`${r2}/x.md`] }));
			const { tabs, c } = await make([]);
			c.emit.repos([repo, r2]);
			flushSync();
			tabs.group = repo;
			tabs.active = `${repo}/gone.md`;
			flushSync();
			expect(tabs.active).toBe(WELCOME);
		});

		it('falls back to the first tab when none was shown before', async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a, b] }));
			const { tabs, c } = await make([]);
			c.emit.repos([repo]);
			flushSync();
			tabs.group = repo;
			tabs.active = `${repo}/gone.md`;
			flushSync();
			expect(tabs.active).toBe(a);
		});

		it('leaves an Other left empty as no group', async () => {
			const { tabs, c } = await make([]);
			c.emit.repos([repo]);
			flushSync();
			tabs.group = OTHER;
			tabs.active = '/tmp/x.md';
			flushSync();
			expect(tabs.group).toBeUndefined();
			expect(tabs.active).toBeUndefined();
		});

		it("shows a stored selection's tab and group first, the stored order kept", async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: ['session:2', a, 'session:1'] }));
			const { tabs, c } = await make(undefined, [], 2);
			expect(tabs.active).toBe('session:2');
			c.emit.repos([repo]);
			flushSync();
			expect(tabs.group).toBe(repo);
			expect(tabs.active).toBe('session:2');
			expect(tabs.groupTabs).toEqual(['session:2', a, 'session:1']);
		});

		it("moves the selected session's group when a repo is added", async () => {
			const { tabs, c, state } = await make([info(1)], [], 1);
			c.emit.repos([]);
			flushSync();
			expect(tabs.group).toBe(OTHER);
			c.emit.repos([repo]);
			flushSync();
			expect(tabs.group).toBe(repo);
			expect(state().selected).toBe(1);
		});

		it('leaves no group when the selected repo with no file tabs is removed', async () => {
			const { tabs, c } = await make([]);
			c.emit.repos([repo, r2]);
			flushSync();
			tabs.openWelcome(r2);
			flushSync();
			expect(tabs.group).toBe(r2);
			c.emit.repos([repo]);
			flushSync();
			expect(tabs.group).toBeUndefined();
			expect(tabs.active).toBeUndefined();
		});

		it("opens a new repo's welcome: none for the first list, the last of several, and only once the dialog closes", async () => {
			const { tabs, c } = await make([]);
			c.emit.repos([repo]);
			flushSync();
			expect(tabs.group).toBeUndefined();
			c.emit.repos([repo, r2]);
			flushSync();
			expect(tabs.group).toBe(r2);
			expect(tabs.active).toBe(WELCOME);
			c.emit.repos([repo, r2, '/tmp/r3', '/tmp/r4']);
			flushSync();
			expect(tabs.group).toBe('/tmp/r4');
			tabs.dialogOpen = true;
			c.emit.repos([repo, r2, '/tmp/r3', '/tmp/r4', '/tmp/r5']);
			flushSync();
			expect(tabs.group).toBe('/tmp/r4');
			tabs.dialogOpen = false;
			flushSync();
			expect(tabs.group).toBe('/tmp/r5');
		});

		it('opens a new repo\'s welcome once the shortcut list closes', async () => {
			const { tabs, c } = await make([]);
			c.emit.repos([repo]);
			flushSync();
			tabs.openShortcuts();
			c.emit.repos([repo, r2]);
			flushSync();
			expect(tabs.group).toBeUndefined();
			tabs.shortcutsOpen = false;
			flushSync();
			expect(tabs.group).toBe(r2);
		});

		it('covers the terminal under a file or a welcome', async () => {
			localStorage.setItem(TABS_KEY, JSON.stringify({ [repo]: [a] }));
			const { tabs, c, m } = await make([info(1)], [], 1);
			c.emit.repos([repo]);
			flushSync();
			const covered = vi.spyOn(m, 'setCovered');
			tabs.active = a;
			flushSync();
			expect(covered).toHaveBeenLastCalledWith(true);
			tabs.active = 'session:1';
			flushSync();
			expect(covered).toHaveBeenLastCalledWith(false);
			tabs.active = WELCOME;
			flushSync();
			expect(covered).toHaveBeenLastCalledWith(true);
		});
	});
});
