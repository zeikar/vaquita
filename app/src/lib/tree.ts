export function joinPath(dir: string, name: string): string {
	return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

// The folders the tree shows: the root and each expanded folder under it whose ancestors up to the
// root are all expanded too. An expanded folder under a collapsed one is not shown, so it is not
// watched or read either, though it stays remembered as expanded.
export function visibleExpanded(root: string, expanded: ReadonlySet<string>): string[] {
	const prefix = joinPath(root, '');
	const under = [...expanded].filter((p) => p.startsWith(prefix) && p.length > prefix.length);
	// Shorter paths first, so a parent is decided before its children.
	under.sort((a, b) => a.length - b.length);
	const shown = new Set([root]);
	const out = [root];
	for (const p of under) {
		const parent = p.slice(0, p.lastIndexOf('/')) || '/';
		if (shown.has(parent)) {
			shown.add(p);
			out.push(p);
		}
	}
	return out;
}
