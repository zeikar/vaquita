import { isTauri } from './tauri';
import { gateTarget } from './file-links';

export type PathQuery = { path: string; host: string };
// One answer per query, in order: true, false, or null when the app could not
// tell (its stat slots were busy, see open_path.rs).
export type ExistsInvoker = (paths: PathQuery[]) => Promise<(boolean | null)[]>;

const defaultInvoker: ExistsInvoker = async (paths) => {
	if (!isTauri()) throw new Error('file links open only in the app');
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke<(boolean | null)[]>('paths_exist', { paths });
};

// A file that is there stays there far more often than not, and a stale yes is
// only today's behaviour: a click reports the miss. So a yes may live long.
const YES_MS = 60_000;
// A stale no hides a file an agent has just written, so a no is asked again soon.
const NO_MS = 5_000;
// A hover must not wait on a slow disk (a hung mount): past this the line is
// underlined as if nothing were known, and the answer is kept when it lands.
const WAIT_MS = 250;

export type PathChecker = {
	// The cached answer for a link's text, or undefined when there is none fresh.
	known(text: string): boolean | undefined;
	// Asks for the texts with no fresh answer and none in flight; resolves when
	// they are answered or after WAIT_MS, and never rejects.
	ask(texts: readonly string[]): Promise<void>;
	// Entries held, expired ones included until the next reply drops them.
	readonly size: number;
};

export function createPathChecker(invoker: ExistsInvoker = defaultInvoker, now: () => number = Date.now): PathChecker {
	const cache = new Map<string, { exists: boolean; at: number }>();
	// A text being asked, with its call's bounded wait, so a second ask waits on it.
	const inFlight = new Map<string, Promise<void>>();
	let warned = false;

	const fresh = (e: { exists: boolean; at: number }) => now() - e.at < (e.exists ? YES_MS : NO_MS);

	// Once per instance: a broken command would otherwise log on every hover.
	function warn(e: unknown) {
		if (warned) return;
		warned = true;
		console.warn('path existence check failed, links stay underlined:', e);
	}

	function store(texts: string[], reply: unknown) {
		if (!Array.isArray(reply) || reply.length !== texts.length) {
			warn(new Error('paths_exist did not answer once per path'));
			return;
		}
		const at = now();
		texts.forEach((t, i) => {
			if (typeof reply[i] === 'boolean') cache.set(t, { exists: reply[i], at });
		});
		// Dropping here, not on a timer, keeps about the last minute's hovers.
		for (const [t, e] of cache) if (!fresh(e)) cache.delete(t);
	}

	return {
		known(text) {
			const e = cache.get(text);
			return e && fresh(e) ? e.exists : undefined;
		},
		async ask(texts) {
			const asked: string[] = [];
			const queries: PathQuery[] = [];
			const pending = new Set<Promise<void>>();
			for (const t of new Set(texts)) {
				const flying = inFlight.get(t);
				if (flying) {
					pending.add(flying);
					continue;
				}
				const e = cache.get(t);
				if (e && fresh(e)) continue;
				// A text gateTarget cannot map never comes from the link provider; it is skipped.
				const q = gateTarget(t);
				if (!q) continue;
				asked.push(t);
				queries.push(q);
			}
			if (asked.length > 0) {
				// Its own handlers catch everything, so a call that lands after the wait
				// cannot become an unhandled rejection.
				const call = (async () => invoker(queries))().then(
					(reply) => store(asked, reply),
					(e) => warn(e),
				);
				// One wait per call, shared by every ask that finds its texts in flight:
				// asks past a hung stat then hold nothing on the call itself, which may
				// never settle.
				let timer: ReturnType<typeof setTimeout> | undefined;
				const bounded = Promise.race([call, new Promise<void>((resolve) => (timer = setTimeout(resolve, WAIT_MS)))]);
				void call.finally(() => {
					clearTimeout(timer);
					for (const t of asked) inFlight.delete(t);
				});
				for (const t of asked) inFlight.set(t, bounded);
				pending.add(bounded);
			}
			await Promise.all(pending);
		},
		get size() {
			return cache.size;
		},
	};
}

export const pathChecker = createPathChecker();
