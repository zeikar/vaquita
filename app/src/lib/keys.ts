// Whether a key belongs to an IME: keyCode 229 is how WKWebView can report the
// one right after compositionend, when isComposing is already false.
export function belongsToIME(ev: KeyboardEvent): boolean {
	return ev.isComposing || ev.keyCode === 229;
}

// xterm runs the custom key handler before its composition helper, so an Enter
// that belongs to an IME must be left alone or the pending syllable is lost.
function isShiftEnter(ev: KeyboardEvent): boolean {
	return ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !belongsToIME(ev);
}

// Shift+Enter is sent as ESC CR, which Claude Code reads as "newline without
// submit". xterm would send a plain CR.
export function translateKey(ev: KeyboardEvent): string | null {
	return ev.type === 'keydown' && isShiftEnter(ev) ? '\x1b\r' : null;
}

// xterm fires a keypress for Enter after a keydown its custom handler rejected,
// and would turn that into CR, so the keypress has to be rejected too.
export function swallowsKeypress(ev: KeyboardEvent): boolean {
	return ev.type === 'keypress' && isShiftEnter(ev);
}

// Cmd and an arrow, with or without Shift or Option. xterm sends nothing for
// these and leaves the key to WebKit, which moves the caret of xterm's hidden
// textarea (⌘← is AppKit's moveToLeftEndOfLine:), away from the syllable the
// Korean input method goes on replacing there (hangul-fix.ts).
function isCmdArrow(ev: KeyboardEvent): boolean {
	return ev.type === 'keydown' && ev.metaKey && !ev.ctrlKey && ev.key.startsWith('Arrow') && !belongsToIME(ev);
}

// Cmd+Left and Cmd+Right alone go to the ends of the line, as in a text field:
// sent as Ctrl+A and Ctrl+E, which a shell and both agents' prompts read so.
function lineEnd(ev: KeyboardEvent): string | null {
	if (!isCmdArrow(ev) || ev.altKey || ev.shiftKey) return null;
	return ev.key === 'ArrowLeft' ? '\x01' : ev.key === 'ArrowRight' ? '\x05' : null;
}

// A Cmd press while an IME composes. On a keydown during a composition xterm
// sends the composed text at once, unless the key is the IME's own (229) or
// Shift, Ctrl or Option, and sends it again when the composition ends, with
// the next key: the syllable was typed twice. Cmd is as much a modifier as
// those three, so xterm must not see its keydown (xterm.js issue 6244).
function isCmdWhileComposing(ev: KeyboardEvent): boolean {
	return ev.type === 'keydown' && ev.key === 'Meta' && ev.isComposing;
}

// The handler for xterm's attachCustomKeyEventHandler: true lets xterm handle
// the event, false means it was handled here (or must not be handled at all).
// commit ends the syllable being composed, as a click does.
export function keyHandler(send: (text: string) => void, commit: () => void): (ev: KeyboardEvent) => boolean {
	return (ev) => {
		if (swallowsKeypress(ev) || isCmdWhileComposing(ev)) return false;
		if (isCmdArrow(ev)) {
			// Cancelled, so the hidden textarea's caret stays where it is.
			ev.preventDefault();
			const end = lineEnd(ev);
			if (end !== null) {
				// The input method may not end its syllable for a key it does not
				// act on, and would go on composing the one sent here.
				commit();
				send(end);
			}
			return false;
		}
		const s = translateKey(ev);
		if (s === null) return true;
		send(s);
		return false;
	};
}

// Cmd and a letter alone. Lower-cased for Caps Lock; Shift, Ctrl and Option
// make it another shortcut, left to whoever has it.
function isCmd(ev: KeyboardEvent, letter: string): boolean {
	return ev.key.toLowerCase() === letter && ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !belongsToIME(ev);
}

// Cmd+T, the new-session shortcut.
export function isNewSessionShortcut(ev: KeyboardEvent): boolean {
	return isCmd(ev, 't');
}

// Cmd+B, which hides and shows the sidebar, as in VS Code.
export function isSidebarShortcut(ev: KeyboardEvent): boolean {
	return isCmd(ev, 'b');
}

// Cmd+S, which saves the file tab shown.
export function isSaveShortcut(ev: KeyboardEvent): boolean {
	return isCmd(ev, 's');
}

// Ctrl+Tab and Ctrl+Shift+Tab, the next and previous tab as in Chrome. They
// cannot be menu keys: AppKit binds them to the key-view loop, which WKWebView
// runs unless the page cancels the key.
function isCtrlTab(ev: KeyboardEvent, shift: boolean): boolean {
	return ev.key === 'Tab' && ev.ctrlKey && ev.shiftKey === shift && !ev.metaKey && !ev.altKey && !belongsToIME(ev);
}

// Option+Cmd+Left and Option+Cmd+Right, the same two as in Chrome. AppKit
// binds nothing to them, and the menu's items already have their keys.
function isCmdOptionArrow(ev: KeyboardEvent, key: string): boolean {
	return ev.key === key && ev.metaKey && ev.altKey && !ev.ctrlKey && !ev.shiftKey && !belongsToIME(ev);
}

export function isPrevTabShortcut(ev: KeyboardEvent): boolean {
	return isCtrlTab(ev, true) || isCmdOptionArrow(ev, 'ArrowLeft');
}

export function isNextTabShortcut(ev: KeyboardEvent): boolean {
	return isCtrlTab(ev, false) || isCmdOptionArrow(ev, 'ArrowRight');
}

// Cmd+1 to Cmd+9, the tab at that position. A page shortcut like Cmd+T: AppKit
// binds nothing to Cmd+digit and the page sees the key before any menu would.
export function tabNumber(ev: KeyboardEvent): number | undefined {
	if (!ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey || belongsToIME(ev)) return undefined;
	return /^[1-9]$/.test(ev.key) ? Number(ev.key) : undefined;
}
