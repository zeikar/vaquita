import type { SessionInfo } from './protocol';

// A diff tab is a tab key, not a path: paths start with `/`, so no file tab can collide with it.
export const DIFF_PREFIX = 'diff:';

export const diffTab = (path: string): string => DIFF_PREFIX + path;

export function diffPath(tab: string): string | undefined {
	return tab.startsWith(DIFF_PREFIX) ? tab.slice(DIFF_PREFIX.length) : undefined;
}

// The file behind a tab: a diff tab's file, else the tab itself.
export const tabFile = (tab: string): string => diffPath(tab) ?? tab;

// Whether a session in the repo just ended a turn, and the states to compare with next time.
// A sid not in prev is only recorded: the view refreshed when it mounted, so a session first seen
// already done has nothing new to show. A turn ends too when a status that was there is gone
// (interrupted, or the agent exited), since it may have edited files first; no status to done is
// not a turn.
export function endedTurns(
	prev: ReadonlyMap<number, string | undefined>,
	sessions: SessionInfo[],
	inRoot: (cwd: string) => boolean,
): { next: Map<number, string | undefined>; ended: boolean } {
	const next = new Map<number, string | undefined>();
	let ended = false;
	for (const s of sessions) {
		const state = s.status?.state;
		next.set(s.sid, state);
		if (!prev.has(s.sid) || !inRoot(s.cwd)) continue;
		const before = prev.get(s.sid);
		if (before !== undefined && before !== state && (state === 'done' || state === 'error' || state === undefined)) ended = true;
	}
	return { next, ended };
}
