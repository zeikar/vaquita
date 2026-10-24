import { components } from './groups';

// A short form of cwd for a row: under the home directory it starts with ~, and
// with more than two components left every one but the last is cut to its first
// character (a dot-dir keeps the dot and the next one). home is only known inside
// Tauri; without it paths stay absolute. An empty cwd is the home directory, where
// the daemon starts such a session.
export function shortPath(cwd: string, home?: string): string {
	let parts = components(cwd);
	let prefix = '';
	const h = home === undefined ? [] : components(home);
	if (parts.length === 0) return '~';
	if (home !== undefined && h.length > 0 && h.every((p, i) => p === parts[i])) {
		parts = parts.slice(h.length);
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
