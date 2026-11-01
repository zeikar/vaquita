import { repoOf } from './groups';
import { groupKey, WELCOME, type TabGroups } from './tabs';
import { STATE_RUNNING, type SessionInfo } from './protocol';

// Undefined until a git status has counted them: showing the welcome runs none of its own.
export function changesText(total: number | undefined): string | undefined {
	if (total === undefined) return undefined;
	if (total === 0) return 'no changes';
	return total === 1 ? '1 changed file' : `${total} changed files`;
}

export function sessionsText(n: number): string {
	if (n === 0) return 'no sessions';
	return n === 1 ? '1 session' : `${n} sessions`;
}

// Exited sessions and restorable records are history, not something running here.
export function repoSessions(sessions: SessionInfo[], repos: string[], repo: string): number {
	return sessions.filter((s) => s.state === STATE_RUNNING && repoOf(s.cwd, repos) === repo).length;
}

export function newRepos(prev: string[], next: string[]): string[] {
	const known = new Set(prev);
	return next.filter((r) => !known.has(r));
}

// Where the selection goes when the selected repo leaves the list: the group
// its file tabs moved to, since without a session nothing else in the sidebar
// reaches them (and any unsaved edit in them); undefined when none moved, and
// the app welcome shows instead. A repo still listed stays selected.
export function selectionAfterRemoval(before: TabGroups, selected: string, repos: string[]): string | undefined {
	if (repos.includes(selected)) return selected;
	if (!(before[selected] ?? []).some((p) => p !== WELCOME)) return undefined;
	return groupKey(selected, repos);
}
