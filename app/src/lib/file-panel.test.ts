import { describe, expect, it } from 'vitest';
import { clampPanelWidth, PANEL_DEFAULT_WIDTH, parsePanelWidth } from './file-panel';

describe('file panel width', () => {
	it('stays within bounds', () => {
		expect(clampPanelWidth(100)).toBe(180);
		expect(clampPanelWidth(1000)).toBe(600);
		expect(clampPanelWidth(300.4)).toBe(300);
	});

	it('falls back to the default for nothing stored or a bad value', () => {
		expect(parsePanelWidth(null)).toBe(PANEL_DEFAULT_WIDTH);
		expect(parsePanelWidth('')).toBe(PANEL_DEFAULT_WIDTH);
		expect(parsePanelWidth('wide')).toBe(PANEL_DEFAULT_WIDTH);
		expect(parsePanelWidth('320')).toBe(320);
		expect(parsePanelWidth('9999')).toBe(600);
	});
});
