// Same quoting as shellJoin in daemon/cmd/vaquitad/shellquote.go.
export function shellQuote(path: string): string {
	return "'" + path.replace(/'/g, "'\\''") + "'";
}

// The tty and the line editor act on control characters before the shell parses
// anything, so quoting cannot make them safe to type.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

// One trailing space so the next typed word does not stick to the last path.
export function shellQuoteAll(paths: string[]): string {
	const bad = paths.find((p) => CONTROL.test(p));
	if (bad !== undefined) throw new Error(`path with a control character: ${JSON.stringify(bad)}`);
	return paths.map(shellQuote).join(' ') + ' ';
}
