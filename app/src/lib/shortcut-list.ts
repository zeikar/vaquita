// The one list of the app's own shortcuts, which the overlay shows. Its tests
// tie it to what takes each key: windowShortcut and the accelerators in menu.rs
// both ways, the terminal's keyHandler only for the keys listed. The
// standard macOS ones the default menu brings (Quit, Hide, Copy, Full Screen)
// are not listed.

// The `key` a KeyboardEvent carries and its four modifiers. For a key the menu
// takes it is the key as the accelerator writes it, so ⌘⇧[ is '[' with shift,
// though WebKit reports '}' for that press: the list never matches a real event
// for a menu key, only the label and the accelerator.
export interface Chord {
	key: string;
	ctrl?: boolean;
	alt?: boolean;
	meta?: boolean;
	shift?: boolean;
}

const ARROWS: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };

// As docs/app.md writes a key: ⌃ ⌥ ⌘ ⇧, then the key.
export function chordLabel(c: Chord): string {
	const key = ARROWS[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
	return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.meta ? '⌘' : ''}${c.shift ? '⇧' : ''}${key}`;
}

// Who takes the key: the window handler, the menu, the terminal's key handler,
// or the mouse (a label with no chord).
export type Key = { by: 'window' | 'menu' | 'terminal'; chord: Chord } | { by: 'mouse'; label: string };

export interface Entry {
	does: string;
	keys: Key[];
	// The keys are one run (⌘1 to ⌘9), shown as first–last.
	range?: true;
}

export interface Section {
	title: string;
	entries: Entry[];
}

const window_ = (chord: Chord): Key => ({ by: 'window', chord });
const menu = (chord: Chord): Key => ({ by: 'menu', chord });
const terminal = (chord: Chord): Key => ({ by: 'terminal', chord });

export const SHORTCUTS: Section[] = [
	{
		title: 'Sessions',
		entries: [
			{ does: 'New session', keys: [window_({ key: 't', meta: true })] },
			{ does: 'New Claude session', keys: [window_({ key: 'c', meta: true, shift: true })] },
			{ does: 'New Codex session', keys: [window_({ key: 'x', meta: true, shift: true })] },
		],
	},
	{
		title: 'Tabs',
		entries: [
			{ does: 'Show tab 1 to 9', range: true, keys: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => window_({ key: String(n), meta: true })) },
			{
				does: 'Next tab',
				keys: [window_({ key: 'Tab', ctrl: true }), window_({ key: 'ArrowRight', alt: true, meta: true }), menu({ key: ']', meta: true, shift: true })],
			},
			{
				does: 'Previous tab',
				keys: [window_({ key: 'Tab', ctrl: true, shift: true }), window_({ key: 'ArrowLeft', alt: true, meta: true }), menu({ key: '[', meta: true, shift: true })],
			},
			{ does: 'Close tab', keys: [menu({ key: 'w', meta: true })] },
			{ does: 'Save file', keys: [window_({ key: 's', meta: true })] },
		],
	},
	{
		title: 'Repos',
		entries: [
			{ does: 'Next repo', keys: [window_({ key: 'ArrowDown', alt: true, meta: true })] },
			{ does: 'Previous repo', keys: [window_({ key: 'ArrowUp', alt: true, meta: true })] },
		],
	},
	{
		title: 'Panels',
		entries: [
			{ does: 'Toggle sidebar', keys: [window_({ key: 'b', meta: true })] },
			{ does: 'Toggle files', keys: [menu({ key: 'b', alt: true, meta: true })] },
		],
	},
	{
		title: 'Terminal',
		entries: [
			{ does: 'Start and end of line', keys: [terminal({ key: 'ArrowLeft', meta: true }), terminal({ key: 'ArrowRight', meta: true })] },
			{ does: 'New line without sending', keys: [terminal({ key: 'Enter', shift: true })] },
			{ does: 'Open a link or path', keys: [{ by: 'mouse', label: '⌘-click' }] },
		],
	},
];

// The chords one party takes, in list order.
export function chordsBy(by: 'window' | 'menu' | 'terminal'): Chord[] {
	return SHORTCUTS.flatMap((s) => s.entries.flatMap((e) => e.keys.flatMap((k) => (k.by === by ? [k.chord] : []))));
}

// A menu chord as Tauri writes an accelerator, which is how menu.rs has it.
export function accelerator(c: Chord): string {
	return ['CmdOrCtrl', c.shift ? 'Shift' : '', c.alt ? 'Alt' : '', c.key.length === 1 ? c.key.toUpperCase() : c.key].filter(Boolean).join('+');
}
