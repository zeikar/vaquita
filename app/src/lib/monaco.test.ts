import { describe, expect, it } from 'vitest';
import { languageFor, type Monaco } from './monaco';

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
