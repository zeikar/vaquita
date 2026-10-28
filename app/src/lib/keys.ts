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

// The handler for xterm's attachCustomKeyEventHandler: true lets xterm handle
// the event, false means it was handled here (or must not be handled at all).
export function keyHandler(send: (text: string) => void): (ev: KeyboardEvent) => boolean {
	return (ev) => {
		if (swallowsKeypress(ev)) return false;
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

export function isPrevTabShortcut(ev: KeyboardEvent): boolean {
	return isCtrlTab(ev, true);
}

export function isNextTabShortcut(ev: KeyboardEvent): boolean {
	return isCtrlTab(ev, false);
}
