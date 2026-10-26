import { describe, expect, it } from 'vitest';
import { clampWidth, DEFAULT_WIDTH, parseWidth } from './sidebar';

describe('sidebar width', () => {
	it('stays within bounds', () => {
		expect(clampWidth(100)).toBe(200);
		expect(clampWidth(1000)).toBe(480);
		expect(clampWidth(300.4)).toBe(300);
	});

	it('falls back to the default for nothing stored or a bad value', () => {
		expect(parseWidth(null)).toBe(DEFAULT_WIDTH);
		expect(parseWidth('')).toBe(DEFAULT_WIDTH);
		expect(parseWidth('wide')).toBe(DEFAULT_WIDTH);
		expect(parseWidth('320')).toBe(320);
		expect(parseWidth('9999')).toBe(480);
	});
});
