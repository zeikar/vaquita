import { describe, expect, it } from 'vitest';
import type { ClipboardSelectionType } from '@xterm/addon-clipboard';
import { clipboardProvider } from './clipboard-provider';

const SYSTEM = 'c' as ClipboardSelectionType;

describe('clipboardProvider', () => {
	it('writes a live copy once and ignores a replayed one', async () => {
		let replaying = true;
		const got: string[] = [];
		const p = clipboardProvider(() => replaying, () => {}, async (t) => void got.push(t));
		await p.writeText(SYSTEM, 'old');
		expect(got).toEqual([]);
		replaying = false;
		await p.writeText(SYSTEM, 'new');
		expect(got).toEqual(['new']);
	});

	it('reads as empty', async () => {
		const p = clipboardProvider(() => false, () => {}, async () => {});
		expect(await p.readText(SYSTEM)).toBe('');
	});
});
