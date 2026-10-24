import { describe, expect, it } from 'vitest';
import { revealInFinder } from './reveal';

describe('revealInFinder', () => {
	it('passes the path to the revealer', async () => {
		const got: string[] = [];
		await revealInFinder('/tmp/repo', async (p) => void got.push(p));
		expect(got).toEqual(['/tmp/repo']);
	});

	it('rejects with the revealer failure', async () => {
		await expect(revealInFinder('/tmp/gone', () => Promise.reject(new Error('no such file')))).rejects.toThrow('no such file');
	});
});
