// While a panel's edge is dragged neither the terminal nor the editor takes
// the new size: the session is resized, and its agent redraws, once when the
// edge is let go rather than at every step, and Monaco, which flashes its
// scrollbars at each relayout, lays out once too. The caller refits the shown
// terminal and relays out the editor then. Window resizes are not held.
let held = false;

export function holdLayout(on: boolean): void {
	held = on;
}

export function layoutHeld(): boolean {
	return held;
}
