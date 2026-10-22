import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { IBufferNamespace, IDisposable, IEvent, IParser, ITerminalAddon, IUnicodeHandling } from '@xterm/xterm';
import { FRAME_REPLAY, type Exit, type Frame, type Live, type Replay } from './protocol';
import { paletteColor, rgbReply, theme } from './theme';

// What the core needs of a terminal: an xterm.js Terminal in the app, a
// headless one in tests. Either must be created with allowProposedApi, which
// parser, unicode and the headless buffer require.
export interface TermLike {
	readonly cols: number;
	readonly rows: number;
	readonly buffer: IBufferNamespace;
	readonly parser: IParser;
	readonly unicode: IUnicodeHandling;
	readonly onData: IEvent<string>;
	readonly onBinary: IEvent<string>;
	readonly onWriteParsed: IEvent<void>;
	write(data: string | Uint8Array, callback: () => void): void;
	input(data: string, wasUserInput?: boolean): void;
	resize(cols: number, rows: number): void;
	loadAddon(addon: ITerminalAddon): void;
}

// The connection a core sends through; replaced by attach on a reconnect.
export interface CoreOut {
	ack(sid: number, gen: number, off: number): void;
	input(sid: number, gen: number, bytes: Uint8Array): void;
	resize(sid: number, cols: number, rows: number): void;
}

const ACK_BYTES = 64 * 1024;
const ACK_DELAY_MS = 100;
const NUDGE_DELAY_MS = 400;

const PROBE_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

const encoder = new TextEncoder();

export interface Size {
	cols: number;
	rows: number;
}

// SessionCore sits between one session's daemon subscription and its
// terminal: it writes replay and live output, answers the status probe and
// the colour queries itself, keeps the terminal's replies to replayed output
// from reaching the session, acks what xterm has parsed and resizes the
// session.
export class SessionCore {
	// null until a replay of the current epoch.
	gen: number | null = null;
	writable = false;
	ended = false;
	reports = 0;
	// Replays after the first, whatever their gen: the only way this client
	// skips output, as the daemon sends a generation's bytes in order.
	resets = 0;
	// Ring offset after the last frame queued.
	off = 0;
	// Replay writes xterm has not parsed yet; the gate stays shut while any
	// are, as their queries were answered when they were live.
	pendingReplay = 0;
	// Runs for every onData the gate lets through, before it is sent, except
	// for the core's own replies. xterm's replies (DA1, CPR, focus reports)
	// cannot be told from user input through its API, so it runs for those too.
	beforeData?: () => void;

	// Bumped by detach: the next connection starts at generation 1 again, so
	// the gen alone cannot tell its callbacks from the old one's.
	private epoch = 0;
	private prefixDue = false;
	// Set by a writable live; the nudge waits until the replay is parsed.
	private nudgeDue = false;
	private proposed: Size | null = null;
	private lastAcked = 0;
	private consumed = 0;
	private ackTimer: ReturnType<typeof setTimeout> | null = null;
	private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
	private nudgeSize: Size | null = null;
	private replayed = false;
	private replying = false;
	private readonly handlers: IDisposable[];

	constructor(
		private readonly term: TermLike,
		readonly sid: number,
		private out: CoreOut,
	) {
		// Before anything is written, so that every cell is measured alike.
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = '11';
		// Replies go through onData, so the gate holds them back during a
		// replay like xterm's own. A browser xterm answers colour queries
		// only once open() has created its theme service, and hidden sessions
		// are never opened. Once opened, xterm tries OSC handlers newest first
		// and stops at the first that returns true, so these, registered after
		// its own, answer and there is no double reply.
		this.handlers = [
			term.parser.registerOscHandler(7501, (data) => this.status(data)),
			term.parser.registerOscHandler(10, (data) => this.dynamicColor(10, theme.foreground, data)),
			term.parser.registerOscHandler(11, (data) => this.dynamicColor(11, theme.background, data)),
			term.parser.registerOscHandler(12, (data) => this.dynamicColor(12, theme.cursor, data)),
			term.parser.registerOscHandler(4, (data) => this.paletteQuery(data)),
			term.onData((d) => this.onData(d)),
			term.onBinary((d) => this.onBinary(d)),
		];
	}

	replay(m: Replay): void {
		// Callbacks of the previous generation are ignored by their gen tag, so
		// they must not be counted either.
		this.pendingReplay = 0;
		this.nudgeDue = false;
		// The gate opens again on this generation's live.
		this.writable = false;
		this.cutNudge();
		this.gen = m.gen;
		this.off = m.from;
		this.prefixDue = true;
		this.lastAcked = m.from;
		this.cancelAck();
		if (m.cols !== this.term.cols || m.rows !== this.term.rows) this.term.resize(m.cols, m.rows);
		if (this.replayed) {
			this.resets++;
			// Queued rather than term.reset(), which would run at once: output
			// still in xterm's write queue would land on the fresh screen.
			this.queue(m.gen, '\x1bc', true, null);
		}
		this.replayed = true;
	}

	frame(f: Frame): void {
		if (this.gen === null || f.gen !== this.gen || f.sid !== this.sid) return;
		if (f.type === FRAME_REPLAY && this.prefixDue) {
			// The daemon sends the prefix, possibly empty, first in every
			// replay. It is not part of the ring, so it is not acked.
			this.prefixDue = false;
			this.queue(f.gen, f.payload, true, null);
			return;
		}
		this.off += f.payload.length;
		this.queue(f.gen, f.payload, f.type === FRAME_REPLAY, this.off);
	}

	live(m: Live): void {
		if (this.gen === null || m.gen !== this.gen) return;
		this.off = m.off;
		this.writable = !m.ro;
		this.nudgeDue = this.writable;
		if (this.nudgeDue && this.pendingReplay === 0) this.replayDone();
	}

	// The daemon ends the subscription with the exit and answers a later
	// resize with no-session.
	exit(_m: Exit): void {
		this.ended = true;
		this.stopNudge();
	}

	// The view's input (Shift+Enter, dropped paths) takes the same gate as
	// typing.
	sendInput(text: string): void {
		this.term.input(text, true);
	}

	// cols and rows are what the view proposes; the core resizes the terminal
	// itself so that it can hold the change back while replay bytes are parsed
	// at the size the daemon announced.
	fitted(cols: number, rows: number): void {
		this.proposed = { cols, rows };
		this.applyProposed();
	}

	// After detach nothing reaches the old connection's out: timers are
	// cancelled, the gate is shut and frames are dropped until a replay.
	detach(): void {
		this.epoch++;
		this.gen = null;
		this.writable = false;
		this.pendingReplay = 0;
		this.nudgeDue = false;
		this.cancelAck();
		this.cutNudge();
	}

	attach(out: CoreOut): void {
		this.out = out;
	}

	dispose(): void {
		this.detach();
		for (const h of this.handlers) h.dispose();
	}

	// The gen input is sent under, or null while the gate is shut.
	private inputGen(): number | null {
		return this.pendingReplay > 0 || !this.writable || this.ended ? null : this.gen;
	}

	private onData(d: string): void {
		const gen = this.inputGen();
		if (gen === null) return;
		if (!this.replying) this.beforeData?.();
		this.out.input(this.sid, gen, encoder.encode(d));
	}

	// xterm sends X10 and default-encoded mouse reports here, one byte per
	// char.
	private onBinary(d: string): void {
		const gen = this.inputGen();
		if (gen === null) return;
		this.out.input(this.sid, gen, Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff));
	}

	// end is the ring offset after data, or null for bytes outside the ring.
	// The callback does nothing once the epoch or generation has moved on.
	private queue(gen: number, data: string | Uint8Array, replay: boolean, end: number | null): void {
		const epoch = this.epoch;
		// Counted before the write: right after user input xterm parses a
		// write, and runs its callback, before write returns.
		if (replay) this.pendingReplay++;
		this.term.write(data, () => {
			if (epoch !== this.epoch || gen !== this.gen) return;
			if (end !== null) this.consumedTo(gen, end);
			if (replay && --this.pendingReplay === 0 && this.nudgeDue) this.replayDone();
		});
	}

	private consumedTo(gen: number, end: number): void {
		this.consumed = end;
		if (end - this.lastAcked >= ACK_BYTES) this.sendAck(gen);
		else this.ackTimer ??= setTimeout(() => this.sendAck(gen), ACK_DELAY_MS);
	}

	private sendAck(gen: number): void {
		this.cancelAck();
		this.lastAcked = this.consumed;
		this.out.ack(this.sid, gen, this.consumed);
	}

	private cancelAck(): void {
		if (this.ackTimer !== null) clearTimeout(this.ackTimer);
		this.ackTimer = null;
	}

	// A size proposed while the replay was being written is applied first, so
	// that the nudge starts from it.
	private replayDone(): void {
		this.nudgeDue = false;
		if (this.ended) return;
		this.applyProposed();
		this.nudge();
	}

	private applyProposed(): void {
		const p = this.proposed;
		if (p === null || this.ended || !this.writable || this.pendingReplay > 0) return;
		if (p.cols === this.term.cols && p.rows === this.term.rows) return;
		this.term.resize(p.cols, p.rows);
		this.out.resize(this.sid, p.cols, p.rows);
	}

	// One column narrower and back after a while: a program on the alternate
	// screen redraws only on SIGWINCH, and resizing to the size the session
	// already has sends none.
	private nudge(): void {
		const { cols, rows } = this.term;
		// xterm's minimum is 2 columns, so there is always one to take away.
		this.out.resize(this.sid, cols - 1, rows);
		this.stopNudge();
		this.nudgeSize = { cols, rows };
		this.nudgeTimer = setTimeout(() => {
			this.nudgeTimer = null;
			this.out.resize(this.sid, this.term.cols, this.term.rows);
		}, NUDGE_DELAY_MS);
	}

	// A nudge cut short leaves the session a column narrow, the size the next
	// replay announces. Unless the view has proposed a size, the one the nudge
	// would have restored is applied once the core is writable again.
	private cutNudge(): void {
		if (this.nudgeTimer === null) return;
		this.proposed ??= this.nudgeSize;
		this.stopNudge();
	}

	private stopNudge(): void {
		if (this.nudgeTimer !== null) clearTimeout(this.nudgeTimer);
		this.nudgeTimer = null;
	}

	// OSC 7501: a probe is answered with what this terminal understands; any
	// other payload is a status report, counted and swallowed.
	private status(data: string): boolean {
		if (data === '?') this.reply(PROBE_REPLY);
		else this.reports++;
		return true;
	}

	// A set is left to xterm.
	private dynamicColor(n: number, color: string, data: string): boolean {
		if (data !== '?') return false;
		this.reply(`\x1b]${n};${rgbReply(color)}\x1b\\`);
		return true;
	}

	// Only a sequence of nothing but idx;? pairs is answered here; one that
	// sets any colour is left to xterm whole.
	private paletteQuery(data: string): boolean {
		const parts = data.split(';');
		if (parts.length % 2 !== 0) return false;
		let reply = '';
		for (let i = 0; i < parts.length; i += 2) {
			if (!/^\d{1,3}$/.test(parts[i]) || parts[i + 1] !== '?') return false;
			const idx = Number(parts[i]);
			if (idx > 255) return false;
			reply += `\x1b]4;${idx};${rgbReply(paletteColor(idx))}\x1b\\`;
		}
		this.reply(reply);
		return true;
	}

	// A query answered while a Hangul syllable is held must not send it early:
	// the IME goes on composing it.
	private reply(s: string): void {
		this.replying = true;
		try {
			this.term.input(s, false);
		} finally {
			this.replying = false;
		}
	}
}
