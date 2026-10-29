import { components } from './groups';

// What is left of parts under base, or undefined when they are not under it.
// Whole components are compared, so /Users/meow is not under /Users/me.
function below(parts: string[], base?: string): string[] | undefined {
	const b = base === undefined ? [] : components(base);
	return b.length > 0 && b.every((p, i) => p === parts[i]) ? parts.slice(b.length) : undefined;
}

// A short form of cwd for a row: under the home directory it starts with ~, and
// with more than two components left every one but the last is cut to its first
// character (a dot-dir keeps the dot and the next one). home is only known inside
// Tauri; without it paths stay absolute. An empty cwd is the home directory, where
// the daemon starts such a session.
export function shortPath(cwd: string, home?: string): string {
	let parts = components(cwd);
	let prefix = '';
	if (cwd === '') return '~';
	if (parts.length === 0) return '/';
	const underHome = below(parts, home);
	if (underHome !== undefined) {
		parts = underHome;
		prefix = '~';
		if (parts.length === 0) return '~';
	}
	if (parts.length > 2) {
		parts = parts.map((p, i) =>
			i === parts.length - 1 ? p : Array.from(p).slice(0, p.startsWith('.') ? 2 : 1).join(''),
		);
	}
	return prefix + '/' + parts.join('/');
}

// A file tab's path for its path bar, in full but from the tab's repo folder
// when it is in it, else from ~ under the home folder. The folders come apart
// from the name, so that they can be cut short before it is.
export function barPath(path: string, repo?: string, home?: string): { dir: string; name: string } {
	const parts = components(path);
	const name = parts.pop() ?? '/';
	const slashed = (ps: string[]) => ps.map((p) => p + '/').join('');
	const inRepo = below(parts, repo);
	if (inRepo !== undefined) return { dir: slashed(inRepo), name };
	const underHome = below(parts, home);
	return { dir: underHome !== undefined ? '~/' + slashed(underHome) : '/' + slashed(parts), name };
}
