import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { ViewLike } from './manager';
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
	private visible = false;

	constructor(
		private readonly term: Terminal,
		private readonly core: SessionCore,
	) {}

	attach(container: HTMLElement): void {
		if (this.container) return;
		this.container = container;
		this.term.open(container);
		this.fit = new FitAddon();
		this.term.loadAddon(this.fit);
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
