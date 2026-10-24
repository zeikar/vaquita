import { describe, expect, it } from 'vitest';
import { clampToViewport } from './menu';

const viewport = { width: 800, height: 600 };
const size = { width: 160, height: 100 };

describe('clampToViewport', () => {
	it('leaves a menu that fits where it was opened', () => {
		expect(clampToViewport({ x: 10, y: 20 }, size, viewport)).toEqual({ x: 10, y: 20 });
		// Touching the edges is fitting.
		expect(clampToViewport({ x: 640, y: 500 }, size, viewport)).toEqual({ x: 640, y: 500 });
	});

	it('shifts a menu that overflows the right edge left', () => {
		expect(clampToViewport({ x: 700, y: 20 }, size, viewport)).toEqual({ x: 636, y: 20 });
	});

	it('shifts a menu that overflows the bottom edge up', () => {
		expect(clampToViewport({ x: 10, y: 550 }, size, viewport)).toEqual({ x: 10, y: 496 });
	});

	it('shifts both ways in a corner', () => {
		expect(clampToViewport({ x: 790, y: 590 }, size, viewport)).toEqual({ x: 636, y: 496 });
	});

	it('keeps the top-left corner in view for a menu larger than the viewport', () => {
		expect(clampToViewport({ x: 50, y: 50 }, { width: 900, height: 700 }, viewport)).toEqual({ x: 0, y: 0 });
	});
});
