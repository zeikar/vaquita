import { describe, expect, it } from 'vitest';
import { writeClipboard } from './clipboard';

describe('writeClipboard', () => {
	it('passes the text to the writer', async () => {
		const got: string[] = [];
		await writeClipboard('hello', async (t) => void got.push(t));
		expect(got).toEqual(['hello']);
	});

	it('rejects with the writer failure', async () => {
		await expect(writeClipboard('x', () => Promise.reject(new Error('denied')))).rejects.toThrow('denied');
	});
});
