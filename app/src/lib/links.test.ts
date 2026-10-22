import { describe, expect, it } from 'vitest';
import { openExternal } from './links';

function opened(uri: string): string[] {
	const got: string[] = [];
	openExternal(uri, () => {}, (u) => void got.push(u));
	return got;
}

describe('openExternal', () => {
	it('opens http, https and mailto', () => {
		expect(opened('http://example.com/a')).toEqual(['http://example.com/a']);
		expect(opened('https://example.com')).toEqual(['https://example.com']);
		expect(opened('mailto:a@example.com')).toEqual(['mailto:a@example.com']);
	});

	it('reports an opener that rejects', async () => {
		const errors: unknown[] = [];
		openExternal('https://example.com', (e) => errors.push(e), () => Promise.reject(new Error('no handler')));
		await new Promise((r) => setTimeout(r, 0));
		expect(errors).toHaveLength(1);
		expect((errors[0] as Error).message).toBe('no handler');
	});

	it('ignores other schemes and non-URLs', () => {
		for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'tel:123', 'ssh://host', 'not a url', '']) {
			expect(opened(u)).toEqual([]);
		}
	});
});
