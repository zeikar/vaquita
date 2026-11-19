import { describe, expect, it } from 'vitest';
import { cursorAt, languageFor, type Monaco } from './monaco';

const monaco = {
	languages: {
		getLanguages: () => [
			{ id: 'typescript', extensions: ['.ts'] },
			{ id: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'] },
			{ id: 'handlebars', extensions: ['.handlebars', '.hbs'] },
			{ id: 'html', extensions: ['.html', '.handlebars.html'] },
		],
	},
} as unknown as Pick<Monaco, 'languages'>;

describe('languageFor', () => {
	it('goes by extension, whatever its case', () => {
		expect(languageFor(monaco, '/tmp/repo/src/main.ts')).toBe('typescript');
		expect(languageFor(monaco, '/tmp/repo/MAIN.TS')).toBe('typescript');
	});

	it('goes by file name for names with no extension', () => {
		expect(languageFor(monaco, '/tmp/repo/Dockerfile')).toBe('dockerfile');
	});

	it('takes the longest extension the name ends with', () => {
		expect(languageFor(monaco, '/tmp/repo/page.handlebars.html')).toBe('html');
	});

	it('is plain text otherwise', () => {
		expect(languageFor(monaco, '/tmp/repo/LICENSE')).toBe('plaintext');
	});
});

describe('cursorAt', () => {
	// Three lines of 4, 0 and 9 characters.
	const lengths = [4, 0, 9];
	const model = { getLineCount: () => lengths.length, getLineMaxColumn: (n: number) => lengths[n - 1] + 1 };

	it('goes to the line and column asked, and to the line’s start with no column', () => {
		expect(cursorAt({ line: 3, col: 2 }, model)).toEqual({ lineNumber: 3, column: 2 });
		expect(cursorAt({ line: 1 }, model)).toEqual({ lineNumber: 1, column: 1 });
	});

	it('keeps a column past the line’s end at its end, and a line past the last on the last', () => {
		expect(cursorAt({ line: 1, col: 40 }, model)).toEqual({ lineNumber: 1, column: 5 });
		expect(cursorAt({ line: 2, col: 3 }, model)).toEqual({ lineNumber: 2, column: 1 });
		expect(cursorAt({ line: 400, col: 5 }, model)).toEqual({ lineNumber: 3, column: 5 });
		expect(cursorAt({ line: 400, col: 99 }, model)).toEqual({ lineNumber: 3, column: 10 });
	});
});
