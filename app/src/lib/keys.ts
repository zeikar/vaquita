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

// Ctrl+Tab and Ctrl+Shift+Tab are the menu's tab switching. WKWebView gives a
// modified key to the page first, and xterm would type a Tab (or send ESC [ Z)
// and cancel the event; left alone, WebKit passes it on to the menu.
function isMenuTabKey(ev: KeyboardEvent): boolean {
	return ev.key === 'Tab' && ev.ctrlKey && !ev.metaKey && !ev.altKey;
}

// The handler for xterm's attachCustomKeyEventHandler: true lets xterm handle
// the event, false means it was handled here (or must not be handled at all).
export function keyHandler(send: (text: string) => void): (ev: KeyboardEvent) => boolean {
	return (ev) => {
		if (swallowsKeypress(ev) || isMenuTabKey(ev)) return false;
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

// Cmd+Shift+[ and Cmd+Shift+], the previous and next tab as in Chrome; an
// alias of the menu's Ctrl+Shift+Tab and Ctrl+Tab that only the page sees. By
// code, since Shift turns the key into { or }.
function isCmdShiftCode(ev: KeyboardEvent, code: string): boolean {
	return ev.code === code && ev.metaKey && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !belongsToIME(ev);
}

export function isPrevTabShortcut(ev: KeyboardEvent): boolean {
	return isCmdShiftCode(ev, 'BracketLeft');
}

export function isNextTabShortcut(ev: KeyboardEvent): boolean {
	return isCmdShiftCode(ev, 'BracketRight');
}
