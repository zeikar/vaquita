// Named .svelte.test.ts so that the store's runes compile.
import { describe, expect, it } from 'vitest';
import { connected, fakeTimersAndStorage, info } from './manager-harness';
import { OTHER, TABS_KEY } from './tabs';
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
});
