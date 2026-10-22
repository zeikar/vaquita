// Same quoting as shellJoin in daemon/cmd/vaquitad/shellquote.go.
export function shellQuote(path: string): string {
	return "'" + path.replace(/'/g, "'\\''") + "'";
}

// One trailing space so the next typed word does not stick to the last path.
export function shellQuoteAll(paths: string[]): string {
	return paths.map(shellQuote).join(' ') + ' ';
}
