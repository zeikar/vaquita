// xterm runs the custom key handler before its composition helper, so an Enter
// that belongs to an IME (keyCode 229 is how WKWebView can report the one right
// after compositionend) must be left alone or the pending syllable is lost.
function isShiftEnter(ev: KeyboardEvent): boolean {
	return ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.isComposing && ev.keyCode !== 229;
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
// the event, false means it was handled here.
export function keyHandler(send: (text: string) => void): (ev: KeyboardEvent) => boolean {
	return (ev) => {
		if (swallowsKeypress(ev)) return false;
		const s = translateKey(ev);
		if (s === null) return true;
		send(s);
		return false;
	};
}
