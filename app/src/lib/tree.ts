import type { IconName } from './icons';

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

const GREY = '#999';
const words = (s: string) => new Set(s.split(' '));
const CODE = words('ts tsx js jsx mjs cjs rs go py rb java kt swift c h cc cpp hpp cs php css scss lua zig');
const MARKUP = words('svelte vue html');
const PROSE = words('md markdown rst');
const IMAGE = words('png jpg jpeg gif webp avif heic bmp tiff ico svg');
const VIDEO = words('mp4 mov m4v webm mkv avi');
const AUDIO = words('mp3 wav flac aac ogg m4a aiff');
const CONFIG = words('json jsonc toml yaml yml ini conf cfg xml plist');
const CONFIG_NAMES = words('makefile dockerfile .editorconfig .gitignore .gitattributes .npmrc .prettierrc');
const SHELL = words('sh bash zsh fish command');

// A row's icon and its colour, by the entry's kind: its name for the few
// files known by name, else its extension, case aside.
export function fileIcon(name: string, dir: boolean, open: boolean): { icon: IconName; tint: string } {
	if (dir) return { icon: open ? 'folder-open' : 'folder', tint: 'var(--accent)' };
	const lower = name.toLowerCase();
	// A leading dot starts a name, not an extension: `.zshrc` has none.
	const dot = lower.lastIndexOf('.');
	const ext = dot > 0 ? lower.slice(dot + 1) : '';
	if (lower === '.env' || lower.startsWith('.env.') || ext === 'lock' || lower === 'package-lock.json')
		return { icon: 'lock-closed', tint: GREY };
	if (CONFIG_NAMES.has(lower) || CONFIG.has(ext)) return { icon: 'cog-6-tooth', tint: GREY };
	if (MARKUP.has(ext)) return { icon: 'code-bracket', tint: '#e0805a' };
	if (CODE.has(ext)) return { icon: 'code-bracket', tint: '#6aa9e0' };
	if (PROSE.has(ext)) return { icon: 'document-text', tint: '#c9a96a' };
	if (ext === 'txt') return { icon: 'document-text', tint: GREY };
	if (IMAGE.has(ext)) return { icon: 'photo', tint: '#7cc47c' };
	if (VIDEO.has(ext)) return { icon: 'film', tint: '#a39ac0' };
	if (AUDIO.has(ext)) return { icon: 'musical-note', tint: '#a39ac0' };
	if (SHELL.has(ext)) return { icon: 'command-line-outline', tint: GREY };
	return { icon: 'document', tint: GREY };
}
