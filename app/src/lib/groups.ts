export function components(path: string): string[] {
	return path.split('/').filter((p) => p !== '');
}

// The registered repo with the most path components that are a prefix of the
// cwd's. Whole components are compared, so /tmp/repo-feature is not under /tmp/repo.
export function repoOf(cwd: string, repos: string[]): string | undefined {
	const parts = components(cwd);
	if (parts.length === 0) return undefined;
	let best: string | undefined;
	// -1 so that / (no components) can still be the repo of everything under it.
	let bestLen = -1;
	for (const repo of repos) {
		const rp = components(repo);
		if (rp.length <= bestLen || rp.length > parts.length) continue;
		if (rp.every((p, i) => p === parts[i])) {
			best = repo;
			bestLen = rp.length;
		}
	}
	return best;
}

export function repoName(path: string): string {
	return components(path).pop() ?? path;
}

// One group per repo in the given order, empty ones included (their start
// buttons live there), then the rest as a group without a repo when it has rows.
export function groupRows<R extends { info: { cwd: string } }>(
	rows: R[],
	repos: string[],
): { repo?: string; rows: R[] }[] {
	const groups = repos.map((repo) => ({ repo, rows: [] as R[] }));
	const other: R[] = [];
	for (const row of rows) {
		const repo = repoOf(row.info.cwd, repos);
		(groups.find((g) => g.repo === repo)?.rows ?? other).push(row);
	}
	return other.length > 0 ? [...groups, { rows: other }] : groups;
}
