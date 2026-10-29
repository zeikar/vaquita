import { gitChanges, type ChangeList } from './files';

export type Snapshot = { list?: ChangeList; error?: string; busy: boolean };

// The latest list per repo root, outside any component so the badge and the list read one answer.
// One status runs per root at a time: git is not asked twice at once, and requests that arrive
// during a run become a single run after it, since the run may have read the tree before they came.
export class ChangeLists {
	// Replaced whole, never edited in place: a list can hold 2000 rows, which need no deep proxy.
	lists = $state.raw<Record<string, Snapshot>>({});
	// The lock is this map, not Snapshot.busy, which is for display.
	private runs = new Map<string, Promise<void>>();
	private again = new Set<string>();
	private failedListeners = new Set<(root: string, error: string) => void>();

	constructor(private status: (root: string) => Promise<ChangeList>) {}

	// Hears each error a refresh ends in when it is new for the root, where it
	// happens: a failure repeated by the next refreshes is told once, and one
	// after a success again.
	onFailed(listener: (root: string, error: string) => void): () => void {
		this.failedListeners.add(listener);
		return () => this.failedListeners.delete(listener);
	}

	// Resolves when the list reflects a read started at or after the call.
	refresh(root: string): Promise<void> {
		const running = this.runs.get(root);
		if (running) {
			this.again.add(root);
			return running;
		}
		const run = this.loop(root).finally(() => this.runs.delete(root));
		this.runs.set(root, run);
		return run;
	}

	private set(root: string, snap: Snapshot): void {
		this.lists = { ...this.lists, [root]: snap };
	}

	private async loop(root: string): Promise<void> {
		do {
			this.again.delete(root);
			this.set(root, { ...this.lists[root], busy: true });
			try {
				this.set(root, { list: await this.status(root), busy: false });
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				const known = this.lists[root]?.error;
				// The last list stays: a failed refresh is not an answer.
				this.set(root, { list: this.lists[root]?.list, error, busy: false });
				if (error !== known) for (const l of this.failedListeners) l(root, error);
			}
		} while (this.again.has(root));
	}
}

export const changeLists = new ChangeLists(gitChanges);
