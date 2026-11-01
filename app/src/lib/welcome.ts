import { repoOf } from './groups';
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
