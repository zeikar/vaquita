// Hangul jamo (conjoining, compatibility, extended A and B) and syllables.
const HANGUL = /^[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힣ힰ-퟿]+$/;

// Whether an input event is the composer's rather than xterm's: a backspace
// only while a syllable is pending (otherwise xterm sends it), an insertion
// only of Hangul.
export function owns(inputType: string, data: string, pendingNonEmpty: boolean): boolean {
	if (inputType === 'deleteContentBackward') return pendingNonEmpty;
	return (inputType === 'insertText' || inputType === 'insertReplacementText') && HANGUL.test(data);
}

export interface ComposerOut {
	// A finished syllable, to be sent as typed input.
	emit(text: string): void;
	// The syllable being composed, '' once there is none.
	onPending(text: string): void;
	// Makes the IME end its composition, so that the next jamo starts a new
	// syllable.
	bounce(): void;
}

// HangulComposer works around WebKit's macOS Korean IME, which sends no
// composition events: a syllable starts with an insertText and every later jamo
// replaces it with an insertReplacementText, which xterm ignores. The composer
// holds the syllable and emits it once the next one starts or anything else is
// about to be sent.
export class HangulComposer {
	pending = '';
	// The syllable the last flush emitted, until an insertText starts a new one.
	// WebKit can confirm it once more with an insertReplacementText (after an
	// Enter, say), which with nothing pending would send it again.
	private lastFlushed = '';

	constructor(private readonly out: ComposerOut) {}

	// Returns whether the event was the composer's.
	input(inputType: string, data: string): boolean {
		if (!owns(inputType, data, this.pending !== '')) return false;
		if (inputType === 'insertText') {
			this.lastFlushed = '';
			this.flush();
			this.set(data);
		} else if (inputType === 'insertReplacementText') {
			if (this.pending === '' && data === this.lastFlushed) return true;
			this.set(data);
		} else {
			this.set('');
		}
		return true;
	}

	// pending is cleared before the emit, which can run flush again through the
	// terminal's onData.
	flush(): void {
		if (this.pending === '') return;
		const text = this.pending;
		this.lastFlushed = text;
		this.set('');
		this.out.emit(text);
	}

	// For a click or an app switch, which the IME never sees: it would go on
	// composing the syllable that was just emitted.
	commit(): void {
		if (this.pending === '') return;
		this.flush();
		this.out.bounce();
	}

	private set(text: string): void {
		this.pending = text;
		this.out.onPending(text);
	}
}
