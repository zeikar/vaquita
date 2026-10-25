import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { clipboardProvider } from './clipboard-provider';
import { installHangulFix, type HangulFix } from './hangul-fix';
import { keyHandler } from './keys';
import { activateUri, type LinkText } from './file-links';
import type { ViewLike } from './manager';
import { pathLinkProvider } from './path-link-provider';
import type { SessionCore, Size } from './session-core';
import { theme } from './theme';

export function createTerminal(cols: number, rows: number): Terminal {
	return new Terminal({
		cols,
		rows,
		// session-core uses the parser, unicode and buffer APIs.
		allowProposedApi: true,
		scrollback: 2000,
		theme,
		fontFamily: 'SF Mono, Menlo, monospace',
		fontSize: 13,
		// Plain drag selects only when the app has mouse reporting off; Option forces it.
		macOptionClickForcesSelection: true,
	});
}

// TermView is a session terminal's DOM side. The terminal is opened the first
// time its session is shown and stays open, as xterm cannot un-open; while
// hidden it has no WebGL context (xterm draws with its DOM renderer) and no
// resize observer.
export class TermView implements ViewLike {
	private container?: HTMLElement;
	private fit?: FitAddon;
	private webgl?: WebglAddon;
	private observer?: ResizeObserver;
	private hangul?: HangulFix;
	private visible = false;

	constructor(
		private readonly term: Terminal,
		private readonly core: SessionCore,
		private readonly report: (message: string) => void,
		private readonly cwd: string,
	) {}

	// Types text into the session, e.g. dropped file paths.
	sendInput(text: string): void {
		this.core.sendInput(text);
	}

	attach(container: HTMLElement): void {
		if (this.container) return;
		this.container = container;
		this.term.open(container);
		this.hangul = this.installHangul();
		// The held syllable goes out ahead of whatever xterm sends next: Enter,
		// arrows, Ctrl keys, a paste, the Shift+Enter translation.
		this.core.beforeData = this.hangul.flush;
		this.fit = new FitAddon();
		this.term.loadAddon(this.fit);
		// Output chooses both the visible text and the URI, so a link opens only on
		// Cmd+click and its URI is shown as a tooltip while hovered. For OSC 8
		// hyperlinks xterm passes the link's URI to linkHandler, not the visible text.
		// Without allowNonHttpProtocols xterm would drop file: links; activateUri is
		// the one gate that decides what a click opens.
		const activate = (e: MouseEvent, uri: LinkText) => activateUri(e, uri, this.report);
		const hover = (_e: MouseEvent, uri: string) => {
			container.title = uri;
		};
		const leave = () => {
			container.title = '';
		};
		this.term.options.linkHandler = { activate, hover, leave, allowNonHttpProtocols: true };
		this.term.loadAddon(new WebLinksAddon(activate, { hover, leave }));
		this.term.registerLinkProvider(pathLinkProvider(this.term.buffer, this.cwd, { activate, hover, leave }));
		this.term.loadAddon(new ClipboardAddon(undefined, clipboardProvider(() => this.core.pendingReplay > 0, this.report)));
		this.term.attachCustomKeyEventHandler(keyHandler((text) => this.core.sendInput(text)));
		// The pane can show a view before it has created the view's element.
		if (this.visible) this.start(container);
	}

	show(): void {
		if (this.visible) return;
		this.visible = true;
		if (this.container) this.start(this.container);
	}

	hide(): void {
		this.visible = false;
		this.stop();
	}

	focus(): void {
		this.term.focus();
	}

	// fit() is never called: it would resize the terminal itself, hiding the
	// change from the core, which resizes the terminal and the session.
	refit(): void {
		const d = this.proposed();
		if (d) this.core.fitted(d.cols, d.rows);
	}

	proposed(): Size | undefined {
		const d = this.fit?.proposeDimensions();
		// NaN while the container has no layout size.
		return d && !isNaN(d.cols) && !isNaN(d.rows) ? d : undefined;
	}

	dispose(): void {
		this.hide();
		this.core.beforeData = undefined;
		this.hangul?.dispose();
		this.hangul = undefined;
	}

	private installHangul(): HangulFix {
		const term = this.term;
		// open() has created the element and the textarea; cols and rows are
		// read through getters as the terminal resizes.
		return installHangulFix(
			{
				element: term.element!,
				textarea: term.textarea!,
				get cols() {
					return term.cols;
				},
				get rows() {
					return term.rows;
				},
				buffer: term.buffer,
				options: term.options,
				onCursorMove: term.onCursorMove,
				onWriteParsed: term.onWriteParsed,
			},
			(text) => term.input(text, true),
		);
	}

	private start(container: HTMLElement): void {
		try {
			this.webgl = new WebglAddon();
			// A disposed addon fires nothing, so a loss is always the current one's.
			this.webgl.onContextLoss(() => this.dropWebgl());
			this.term.loadAddon(this.webgl);
		} catch (e) {
			// Without WebGL2 xterm keeps drawing with its DOM renderer.
			this.dropWebgl();
			console.warn('WebGL renderer unavailable:', e);
		}
		this.refit();
		this.observer = new ResizeObserver(() => this.refit());
		this.observer.observe(container);
		this.term.focus();
	}

	private stop(): void {
		this.dropWebgl();
		this.observer?.disconnect();
		this.observer = undefined;
	}

	private dropWebgl(): void {
		this.webgl?.dispose();
		this.webgl = undefined;
	}
}
