import { isTauri } from './tauri';
import { gateTarget } from './file-links';

export type PathQuery = { path: string; host: string };
// One answer per query, in order: true, false, or null when the app could not
// tell (its stat slots were busy, see open_path.rs).
export type ExistsInvoker = (paths: PathQuery[]) => Promise<(boolean | null)[]>;
// One answer per name, in order: the full path of the one file it names, false
// when none or several do, or null when the app could not tell (see names.rs).
export type NamesInvoker = (folder: string, names: string[]) => Promise<(string | false | null)[]>;

const defaultInvoker: ExistsInvoker = async (paths) => {
	if (!isTauri()) throw new Error('file links open only in the app');
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke<(boolean | null)[]>('paths_exist', { paths });
};

const defaultNamesInvoker: NamesInvoker = async (folder, names) => {
	if (!isTauri()) throw new Error('file links open only in the app');
	const { invoke } = await import('@tauri-apps/api/core');
	return invoke<(string | false | null)[]>('find_names', { folder, names });
};

// A file that is there stays there far more often than not, and a stale yes is
// only today's behaviour: a click reports the miss. So a yes may live long.
const YES_MS = 60_000;
// A stale no hides a file an agent has just written, so a no is asked again soon.
const NO_MS = 5_000;
// A hover must not wait on a slow disk (a hung mount): past this the line is
// underlined as if nothing were known, and the answer is kept when it lands.
const WAIT_MS = 250;

// Answers kept per key, false a no and anything else a yes.
type Answers<A> = {
	// The cached answer for a key, or undefined when there is none fresh.
	known(key: string): A | undefined;
	// Asks for the keys with no fresh answer and none in flight; resolves when
	// they are answered or after WAIT_MS, and never rejects.
	ask(keys: readonly string[]): Promise<void>;
	// Entries held, expired ones included until the next reply drops them.
	readonly size: number;
};

export type PathChecker = Answers<boolean>;
export type NameFinder = Answers<string | false>;

// The cache, the in-flight asks and the bounded wait both lookups share. query
// turns a key into what call is asked with (none skips the key); a reply must
// hold one answer or null per query, or it is dropped whole with one warning.
function createAnswers<Q, A>(
	query: (key: string) => Q | undefined,
	call: (queries: Q[]) => Promise<unknown>,
	isAnswer: (v: unknown) => v is A,
	warning: string,
	now: () => number,
): Answers<A> {
	const cache = new Map<string, { answer: A; at: number }>();
	// A key being asked, with its call's bounded wait, so a second ask waits on it.
	const inFlight = new Map<string, Promise<void>>();
	let warned = false;

	const fresh = (e: { answer: A; at: number }) => now() - e.at < (e.answer === false ? NO_MS : YES_MS);

	// Once per instance: a broken command would otherwise log on every hover.
	function warn(e: unknown) {
		if (warned) return;
		warned = true;
		console.warn(warning, e);
	}

	function store(keys: string[], reply: unknown) {
		if (!Array.isArray(reply) || reply.length !== keys.length || !reply.every((v) => v === null || isAnswer(v))) {
			warn(new Error('the reply did not answer once per query'));
			return;
		}
		const at = now();
		keys.forEach((k, i) => {
			if (reply[i] !== null) cache.set(k, { answer: reply[i], at });
		});
		// Dropping here, not on a timer, keeps about the last minute's hovers.
		for (const [k, e] of cache) if (!fresh(e)) cache.delete(k);
	}

	return {
		known(key) {
			const e = cache.get(key);
			return e && fresh(e) ? e.answer : undefined;
		},
		async ask(keys) {
			const asked: string[] = [];
			const queries: Q[] = [];
			const pending = new Set<Promise<void>>();
			for (const k of new Set(keys)) {
				const flying = inFlight.get(k);
				if (flying) {
					pending.add(flying);
					continue;
				}
				const e = cache.get(k);
				if (e && fresh(e)) continue;
				const q = query(k);
				if (q === undefined) continue;
				asked.push(k);
				queries.push(q);
			}
			if (asked.length > 0) {
				// Its own handlers catch everything, so a call that lands after the wait
				// cannot become an unhandled rejection.
				const called = (async () => call(queries))().then(
					(reply) => store(asked, reply),
					(e) => warn(e),
				);
				// One wait per call, shared by every ask that finds its keys in flight:
				// asks past a hung stat then hold nothing on the call itself, which may
				// never settle.
				let timer: ReturnType<typeof setTimeout> | undefined;
				const bounded = Promise.race([called, new Promise<void>((resolve) => (timer = setTimeout(resolve, WAIT_MS)))]);
				void called.finally(() => {
					clearTimeout(timer);
					for (const k of asked) inFlight.delete(k);
				});
				for (const k of asked) inFlight.set(k, bounded);
				pending.add(bounded);
			}
			await Promise.all(pending);
		},
		get size() {
			return cache.size;
		},
	};
}

export function createPathChecker(invoker: ExistsInvoker = defaultInvoker, now: () => number = Date.now): PathChecker {
	return createAnswers(
		// A text gateTarget cannot map never comes from the link provider; it is skipped.
		gateTarget,
		invoker,
		(v): v is boolean => typeof v === 'boolean',
		'path existence check failed, links stay underlined:',
		now,
	);
}

export const pathChecker = createPathChecker();

// Which file each bare name in a session's output names, looked up from the
// session's starting folder; one per terminal, as that folder is the view's.
export function createNameFinder(cwd: string, invoker: NamesInvoker = defaultNamesInvoker, now: () => number = Date.now): NameFinder {
	// An empty cwd is the home directory, as resolvePath reads it.
	const folder = cwd === '' ? '~' : cwd;
	return createAnswers(
		(name) => name,
		(names: string[]) => invoker(folder, names),
		(v): v is string | false => typeof v === 'string' || v === false,
		'file name lookup failed, names stay unlinked:',
		now,
	);
}
