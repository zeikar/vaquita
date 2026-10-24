export interface MenuItem {
	label: string;
	run: () => void;
	danger?: boolean;
	// Runs on a second click; the first one arms it and keeps the menu open.
	confirm?: boolean;
	disabled?: boolean;
}

// A menu's top-left corner in CSS pixels of the viewport, as clientX / clientY.
export interface MenuAt {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

// The gap a shifted menu keeps from the viewport's edge, so its shadow shows.
const EDGE = 4;

// Where a menu of size opened at at goes: shifted left or up, as far as it
// overflows the viewport and a little more, but never past its top-left corner.
export function clampToViewport(at: MenuAt, size: Size, viewport: Size): MenuAt {
	const fit = (p: number, len: number, room: number) => (p + len <= room ? p : Math.max(0, room - len - EDGE));
	return { x: fit(at.x, size.width, viewport.width), y: fit(at.y, size.height, viewport.height) };
}
