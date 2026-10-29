import { load } from './storage';

// The file panel's remembered width and whether it is hidden.
export const PANEL_WIDTH = 'vaquita.file-panel-width';
export const PANEL_HIDDEN = 'vaquita.file-panel-hidden';

export const PANEL_DEFAULT_WIDTH = 260;
// Narrower cuts file names to a few letters; wider leaves the terminal little room.
const MIN_WIDTH = 180;
const MAX_WIDTH = 600;

export function clampPanelWidth(w: number): number {
	return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
}

export function parsePanelWidth(s: string | null): number {
	const w = Number(s);
	return s === null || s === '' || !Number.isFinite(w) ? PANEL_DEFAULT_WIDTH : clampPanelWidth(w);
}

export function loadPanelWidth(): number {
	return parsePanelWidth(load(PANEL_WIDTH));
}
