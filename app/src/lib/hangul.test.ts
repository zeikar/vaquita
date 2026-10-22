import { describe, expect, it } from 'vitest';
import { HangulComposer, owns } from './hangul';

function setup() {
	const emitted: string[] = [];
	const pendings: string[] = [];
	const bounces: number[] = [];
	const composer = new HangulComposer({
		emit: (text) => void emitted.push(text),
		onPending: (text) => void pendings.push(text),
		bounce: () => void bounces.push(emitted.length),
	});
	return { composer, emitted, pendings, bounces };
}

describe('HangulComposer', () => {
	it('emits a syllable once, when the next one starts', () => {
		const { composer, emitted, pendings } = setup();
		const steps: [string, string, string[]][] = [
			['insertText', 'ㅇ', []],
			['insertReplacementText', '아', []],
			['insertReplacementText', '안', []],
			// WebKit confirms the syllable before the next one starts.
			['insertReplacementText', '안', []],
			['insertText', 'ㄴ', ['안']],
			['insertReplacementText', '녀', ['안']],
			['insertReplacementText', '녕', ['안']],
		];
		for (const [type, data, after] of steps) {
			expect(composer.input(type, data)).toBe(true);
			expect(emitted).toEqual(after);
		}
		expect(composer.pending).toBe('녕');
		expect(pendings.at(-1)).toBe('녕');
	});

	it('flushes the pending syllable and ignores a late confirm of it', () => {
		const { composer, emitted, pendings } = setup();
		composer.input('insertText', 'ㅌ');
		composer.input('insertReplacementText', '테');
		// What the view does before xterm forwards an Enter.
		composer.flush();
		expect(emitted).toEqual(['테']);
		expect(composer.pending).toBe('');
		expect(pendings.at(-1)).toBe('');

		expect(composer.input('insertReplacementText', '테')).toBe(true);
		expect(emitted).toEqual(['테']);
		expect(composer.pending).toBe('');

		expect(composer.input('insertReplacementText', '텍')).toBe(true);
		expect(composer.pending).toBe('텍');
		expect(emitted).toEqual(['테']);
	});

	it('ignores a replacement with the syllable already emitted after a backspace', () => {
		const { composer, emitted } = setup();
		composer.input('insertText', '안');
		composer.input('insertText', 'ㄴ');
		composer.input('deleteContentBackward', '');
		expect(composer.input('insertReplacementText', '안')).toBe(true);
		composer.flush();
		expect(emitted).toEqual(['안']);
		expect(composer.pending).toBe('');
	});

	it('owns a backspace only while it holds a syllable', () => {
		const { composer, emitted } = setup();
		composer.input('insertText', 'ㄱ');
		expect(composer.input('deleteContentBackward', '')).toBe(true);
		expect(composer.pending).toBe('');
		expect(composer.input('deleteContentBackward', '')).toBe(false);
		expect(owns('deleteContentBackward', '', false)).toBe(false);
		expect(emitted).toEqual([]);
	});

	it('commits by emitting and then bouncing, only with a syllable pending', () => {
		const { composer, emitted, bounces } = setup();
		composer.commit();
		expect(emitted).toEqual([]);
		expect(bounces).toEqual([]);

		composer.input('insertText', '가');
		composer.commit();
		expect(emitted).toEqual(['가']);
		// The bounce came after the emit.
		expect(bounces).toEqual([1]);
		expect(composer.pending).toBe('');
	});

	it('leaves Latin input to xterm', () => {
		const { composer, emitted, pendings } = setup();
		expect(owns('insertText', 'a', false)).toBe(false);
		expect(composer.input('insertText', 'a')).toBe(false);
		expect(composer.input('insertReplacementText', 'a')).toBe(false);
		expect(emitted).toEqual([]);
		expect(pendings).toEqual([]);
	});
});
