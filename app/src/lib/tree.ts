import type { Entry } from './files';

export function joinPath(dir: string, name: string): string {
	return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

// Rust sorts and caps by plain lowercase names; the rows are ordered here again so that file2 comes
// before file10. It can differ from Rust's order only past the cap, as the cap is a prefix of that
// order.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function orderEntries(entries: readonly Entry[]): Entry[] {
	return [...entries].sort((a, b) => Number(b.dir) - Number(a.dir) || collator.compare(a.name, b.name));
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
