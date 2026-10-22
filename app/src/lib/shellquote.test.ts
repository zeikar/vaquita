import { describe, expect, it } from 'vitest';
import { shellQuote, shellQuoteAll } from './shellquote';

describe('shellQuote', () => {
	it('quotes a path with a space', () => {
		expect(shellQuote('/tmp/my file.txt')).toBe("'/tmp/my file.txt'");
	});

	it('escapes a single quote', () => {
		expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
	});
});

describe('shellQuoteAll', () => {
	it('joins paths with a space and ends with one', () => {
		expect(shellQuoteAll(['/tmp/a', '/tmp/b c'])).toBe("'/tmp/a' '/tmp/b c' ");
	});

	it('refuses a path with control characters', () => {
		expect(() => shellQuoteAll(['/tmp/x\x15touch /tmp/pwned\r'])).toThrow('control character');
		expect(() => shellQuoteAll(['/tmp/ok', '/tmp/a\x7fb'])).toThrow('control character');
	});
});
