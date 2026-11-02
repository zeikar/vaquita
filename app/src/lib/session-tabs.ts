import { STATE_RUNNING, type SessionInfo } from './protocol';
import { groupKey, type TabGroups } from './tabs';

// A session's key among a group's tabs. File tabs are absolute paths (they start
// with "/"), diff tabs start with "diff:" and the welcome is "welcome", so the
// prefix collides with none of them.
export const SESSION_PREFIX = 'session:';

export function sessionTab(sid: number): string {
	return `${SESSION_PREFIX}${sid}`;
}

export function tabSid(key: string): number | undefined {
	if (!key.startsWith(SESSION_PREFIX)) return undefined;
	const digits = key.slice(SESSION_PREFIX.length);
	return /^\d+$/.test(digits) ? Number(digits) : undefined;
}

export function isSessionTab(key: string): boolean {
	return tabSid(key) !== undefined;
}

// Where each session's tab belongs. A record from an earlier run has no
// terminal, so it is history in the sidebar and never a tab: that is a
// restorable one, and also one whose orphaned processes are still alive, which
// the daemon reports with no size.
export function placement(sessions: SessionInfo[], repos: string[]): Map<number, string> {
	const placed = new Map<number, string>();
	for (const s of sessions) if (!s.restorable && s.cols > 0 && s.rows > 0) placed.set(s.sid, groupKey(s.cwd, repos));
	return placed;
}

// The stored order, minus session tabs whose session is not in this group any
// more, plus the sessions it has no tab for yet, by number. The same array
// comes back when nothing changed.
export function arrangeGroup(order: string[], sids: number[]): string[] {
	const here = new Set(sids);
	const kept = order.filter((key) => {
		const sid = tabSid(key);
		return sid === undefined || here.has(sid);
	});
	const known = new Set(kept);
	const added = [...sids].sort((a, b) => a - b).map(sessionTab).filter((key) => !known.has(key));
	return kept.length === order.length && added.length === 0 ? order : [...kept, ...added];
}

// arrangeGroup on every group, so a session's tab follows its cwd between
// groups and a group left empty is dropped. The same object comes back when
// nothing changed: the persist effect keys on that.
export function reconcile(groups: TabGroups, placed: Map<number, string>): TabGroups {
	const sidsOf = new Map<string, number[]>();
	for (const [sid, key] of placed) sidsOf.set(key, [...(sidsOf.get(key) ?? []), sid]);
	const next: TabGroups = {};
	let changed = false;
	for (const key of new Set([...Object.keys(groups), ...sidsOf.keys()])) {
		const order = groups[key] ?? [];
		const arranged = arrangeGroup(order, sidsOf.get(key) ?? []);
		if (arranged !== order) changed = true;
		if (arranged.length > 0) next[key] = arranged;
		else if (key in groups) changed = true;
	}
	return changed ? next : groups;
}

// A session that is waiting on the user: a tab closed over it is asked about
// first.
export function needsAsk(info: SessionInfo): boolean {
	return info.state === STATE_RUNNING && (info.status?.state === 'working' || info.status?.state === 'input');
}
