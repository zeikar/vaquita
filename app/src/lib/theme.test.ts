import { describe, expect, it } from 'vitest';
import { paletteColor, rgbReply, theme } from './theme';

describe('theme', () => {
	it('formats an xterm colour reply with each channel doubled', () => {
		expect(rgbReply('#1e1e1e')).toBe('rgb:1e1e/1e1e/1e1e');
		expect(rgbReply('#cd3141')).toBe('rgb:cdcd/3131/4141');
	});

	it('takes palette entries 0-15 from the theme', () => {
		expect(paletteColor(0)).toBe(theme.black);
		expect(paletteColor(1)).toBe(theme.red);
		expect(paletteColor(15)).toBe(theme.brightWhite);
	});

	it('computes the colour cube and the grey ramp', () => {
		expect(paletteColor(16)).toBe('#000000');
		expect(paletteColor(17)).toBe('#00005f');
		expect(paletteColor(231)).toBe('#ffffff');
		expect(paletteColor(232)).toBe('#080808');
		expect(paletteColor(255)).toBe('#eeeeee');
	});
});
