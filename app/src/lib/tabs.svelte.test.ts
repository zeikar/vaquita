// Named .svelte.test.ts so that the store's runes compile.
import { describe, expect, it, vi } from 'vitest';
import { answer, connected, fakeTimersAndStorage, info } from './manager-harness';
import { LAST_CWD } from './NewSessionDialog.svelte';
import { OTHER, TABS_KEY, WELCOME } from './tabs';
import { Tabs, type TabDocuments } from './tabs.svelte';

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

async function make(list = [info(1), info(2)]) {
	const t = await connected(list);
	const d = fakeDocuments();
	const tabs = new Tabs({ manager: t.m, documents: d.docs });
	return { ...t, ...d, tabs };
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
			await tabs.show(a);
			expect(tabs.active).toBe(a);
			expect(state().selected).toBe(2);
			expect(tabs.recent.get(repo)).toEqual([a, 'session:2']);
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
});
