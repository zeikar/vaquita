import { describe, expect, it, vi } from 'vitest';
import { ChangeLists } from './changes.svelte';
import type { ChangeList } from './files';

const list = (root: string, n: number): ChangeList => ({ root, entries: [], total: n });

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

describe('ChangeLists', () => {
	it('stores the list a refresh read', async () => {
		const lists = new ChangeLists(async (root) => list(root, 3));
		await lists.refresh('/tmp/repo');
		expect(lists.lists['/tmp/repo']).toEqual({ list: list('/tmp/repo', 3), busy: false });
	});

	it('runs status twice for three refreshes during one run', async () => {
		const gates = [deferred<ChangeList>(), deferred<ChangeList>()];
		const status = vi.fn(() => gates[status.mock.calls.length - 1].promise);
		const lists = new ChangeLists(status);
		const first = lists.refresh('/tmp/repo');
		expect(lists.lists['/tmp/repo'].busy).toBe(true);
		void lists.refresh('/tmp/repo');
		void lists.refresh('/tmp/repo');
		expect(status).toHaveBeenCalledTimes(1);
		gates[0].resolve(list('/tmp/repo', 1));
		await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
		gates[1].resolve(list('/tmp/repo', 2));
		await first;
		expect(status).toHaveBeenCalledTimes(2);
		expect(lists.lists['/tmp/repo'].list?.total).toBe(2);
		expect(lists.lists['/tmp/repo'].busy).toBe(false);
	});

	it('resolves a refresh asked mid-run only after the run it caused', async () => {
		const gates = [deferred<ChangeList>(), deferred<ChangeList>()];
		const status = vi.fn(() => gates[status.mock.calls.length - 1].promise);
		const lists = new ChangeLists(status);
		void lists.refresh('/tmp/repo');
		let done = false;
		const second = lists.refresh('/tmp/repo').then(() => (done = true));
		gates[0].resolve(list('/tmp/repo', 1));
		await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
		expect(done).toBe(false);
		gates[1].resolve(list('/tmp/repo', 2));
		await second;
		expect(done).toBe(true);
	});

	it('runs a third time for a refresh asked during the second run', async () => {
		const gates = [deferred<ChangeList>(), deferred<ChangeList>(), deferred<ChangeList>()];
		const status = vi.fn(() => gates[status.mock.calls.length - 1].promise);
		const lists = new ChangeLists(status);
		const all = lists.refresh('/tmp/repo');
		void lists.refresh('/tmp/repo');
		gates[0].resolve(list('/tmp/repo', 1));
		await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
		void lists.refresh('/tmp/repo');
		gates[1].resolve(list('/tmp/repo', 2));
		await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(3));
		gates[2].resolve(list('/tmp/repo', 3));
		await all;
		expect(lists.lists['/tmp/repo'].list?.total).toBe(3);
	});

	it('keeps the earlier list when a refresh fails', async () => {
		const status = vi.fn<(root: string) => Promise<ChangeList>>().mockResolvedValueOnce(list('/tmp/repo', 1)).mockRejectedValueOnce(new Error('git broke'));
		const lists = new ChangeLists(status);
		await lists.refresh('/tmp/repo');
		await lists.refresh('/tmp/repo');
		expect(lists.lists['/tmp/repo']).toEqual({ list: list('/tmp/repo', 1), error: 'git broke', busy: false });
		status.mockResolvedValueOnce(list('/tmp/repo', 2));
		await lists.refresh('/tmp/repo');
		expect(lists.lists['/tmp/repo'].error).toBeUndefined();
	});

	it('keeps two roots apart', async () => {
		const gate = deferred<ChangeList>();
		const status = vi.fn((root: string) => (root === '/tmp/a' ? gate.promise : Promise.resolve(list(root, 5))));
		const lists = new ChangeLists(status);
		const a = lists.refresh('/tmp/a');
		await lists.refresh('/tmp/b');
		expect(lists.lists['/tmp/b'].list?.total).toBe(5);
		expect(lists.lists['/tmp/a'].busy).toBe(true);
		gate.resolve(list('/tmp/a', 1));
		await a;
		expect(status).toHaveBeenCalledTimes(2);
	});
});
