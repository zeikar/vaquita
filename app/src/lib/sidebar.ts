import { load } from './storage';

// The sidebar's remembered width and whether it is hidden.
export const SIDEBAR_WIDTH = 'vaquita.sidebar-width';
export const SIDEBAR_HIDDEN = 'vaquita.sidebar-hidden';

export const DEFAULT_WIDTH = 280;
// Narrower cuts the rows' titles to a few letters; wider leaves the terminal
// little room in a small window.
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export function clampWidth(w: number): number {
	return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
}

export function parseWidth(s: string | null): number {
	const w = Number(s);
	return s === null || s === '' || !Number.isFinite(w) ? DEFAULT_WIDTH : clampWidth(w);
}

export function loadWidth(): number {
	return parseWidth(load(SIDEBAR_WIDTH));
}
