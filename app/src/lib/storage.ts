// The app's remembered choices (selected session, last cwd, collapsed
// groups). localStorage is missing under Node and can refuse access in a
// browser; the choice is then just not remembered.

export function load(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch (e) {
		console.warn(`localStorage read of ${key} failed:`, e);
		return null;
	}
}

export function save(key: string, value: string): void {
	try {
		globalThis.localStorage?.setItem(key, value);
	} catch (e) {
		console.warn(`localStorage write of ${key} failed:`, e);
	}
}
