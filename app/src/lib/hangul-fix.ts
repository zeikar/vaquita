import type { IDisposable, ITerminalOptions } from '@xterm/xterm';
import { HangulComposer, owns } from './hangul';

// What the fix needs of an opened xterm Terminal, whose element and textarea
// are undefined until open().
export interface HangulHost {
	readonly element: HTMLElement;
	readonly textarea: HTMLTextAreaElement;
	readonly cols: number;
	readonly rows: number;
	readonly buffer: { readonly active: { readonly cursorX: number; readonly cursorY: number } };
	readonly options: Pick<ITerminalOptions, 'fontFamily' | 'fontSize' | 'theme'>;
	onCursorMove(cb: () => void): IDisposable;
	onWriteParsed(cb: () => void): IDisposable;
}

export interface HangulFix {
	// Emits the pending syllable, if any.
	flush(): void;
	dispose(): void;
}

// installHangulFix feeds the textarea's Hangul input events to a
// HangulComposer before xterm sees them and draws the pending syllable over the
// cursor. Owned events are only stopped, never cancelled: the textarea must
// still hold the text that the IME goes on replacing.
export function installHangulFix(host: HangulHost, emit: (text: string) => void): HangulFix {
	const { element, textarea } = host;
	const { fontFamily, fontSize, theme } = host.options;
	const overlay = document.createElement('div');
	overlay.className = 'hangul-pending';
	Object.assign(overlay.style, {
		position: 'absolute',
		pointerEvents: 'none',
		zIndex: '10',
		display: 'none',
		textDecoration: 'underline',
		fontFamily: fontFamily ?? '',
		fontSize: fontSize ? `${fontSize}px` : '',
		color: theme?.foreground ?? '',
		background: theme?.background ?? '',
	});
	element.appendChild(overlay);

	// xterm moves its textarea to the cursor only during a composition, which
	// never starts here.
	const place = () => {
		const screen = element.querySelector('.xterm-screen');
		if (!screen) return;
		const base = element.getBoundingClientRect();
		const r = screen.getBoundingClientRect();
		const w = r.width / host.cols;
		const h = r.height / host.rows;
		const { cursorX, cursorY } = host.buffer.active;
		overlay.style.left = `${r.left - base.left + cursorX * w}px`;
		overlay.style.top = `${r.top - base.top + cursorY * h}px`;
		overlay.style.height = overlay.style.lineHeight = `${h}px`;
	};

	const composer = new HangulComposer({
		emit,
		onPending: (text) => {
			overlay.textContent = text;
			if (text) place();
			overlay.style.display = text ? 'block' : 'none';
		},
		bounce: () => {
			textarea.blur();
			textarea.focus();
		},
	});

	// Capture on the element runs before xterm's listeners on the textarea.
	const onBeforeInput = (e: Event) => {
		const { inputType, data } = e as InputEvent;
		if (e.target === textarea && owns(inputType, data ?? '', composer.pending !== '')) e.stopPropagation();
	};
	const onInput = (e: Event) => {
		const { inputType, data } = e as InputEvent;
		if (e.target === textarea && composer.input(inputType, data ?? '')) e.stopPropagation();
	};
	const flush = () => composer.flush();
	const commit = () => composer.commit();
	// The flushed syllable is echoed later; the overlay follows the cursor or it
	// covers the echo.
	const follow = () => {
		if (composer.pending) place();
	};

	element.addEventListener('beforeinput', onBeforeInput, true);
	element.addEventListener('input', onInput, true);
	element.addEventListener('mousedown', commit, true);
	textarea.addEventListener('blur', flush);
	window.addEventListener('blur', commit);
	const subscriptions = [host.onCursorMove(follow), host.onWriteParsed(follow)];

	return {
		flush,
		dispose: () => {
			element.removeEventListener('beforeinput', onBeforeInput, true);
			element.removeEventListener('input', onInput, true);
			element.removeEventListener('mousedown', commit, true);
			textarea.removeEventListener('blur', flush);
			window.removeEventListener('blur', commit);
			for (const s of subscriptions) s.dispose();
			overlay.remove();
		},
	};
}
