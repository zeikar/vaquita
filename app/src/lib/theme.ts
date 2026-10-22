import type { ITheme } from '@xterm/xterm';

export const theme = {
	background: '#1e1e1e',
	foreground: '#d4d4d4',
	cursor: '#ffffff',
	black: '#000000',
	red: '#cd3131',
	green: '#0dbc79',
	yellow: '#e5e510',
	blue: '#2472c8',
	magenta: '#bc3fbc',
	cyan: '#11a8cd',
	white: '#e5e5e5',
	brightBlack: '#666666',
	brightRed: '#f14c4c',
	brightGreen: '#23d18b',
	brightYellow: '#f5f543',
	brightBlue: '#3b8eea',
	brightMagenta: '#d670d6',
	brightCyan: '#29b8db',
	brightWhite: '#e5e5e5',
} satisfies ITheme;

const ansi = [
	theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
	theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
	theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
];

const cube = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];

function hex(r: number, g: number, b: number): string {
	return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// xterm answers colour queries with 16-bit channels; an 8-bit channel is
// widened by repeating it, so ff becomes ffff.
export function rgbReply(color: string): string {
	const [r, g, b] = [1, 3, 5].map((i) => color.slice(i, i + 2).repeat(2));
	return `rgb:${r}/${g}/${b}`;
}

// The 256-colour palette xterm uses: the theme's 16 colours, a 6x6x6 cube,
// then a 24-step grey ramp.
export function paletteColor(index: number): string {
	if (index < 16) return ansi[index];
	if (index < 232) {
		const i = index - 16;
		return hex(cube[Math.floor(i / 36)], cube[Math.floor(i / 6) % 6], cube[i % 6]);
	}
	const v = 8 + (index - 232) * 10;
	return hex(v, v, v);
}
