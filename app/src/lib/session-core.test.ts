import { Terminal } from '@xterm/headless';
import type { ITerminalAddon } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_LIVE, FRAME_REPLAY, type Exit, type Frame, type Live, type Replay } from './protocol';
import { SessionCore, type CoreOut, type TermLike } from './session-core';
import { paletteColor, rgbReply, theme } from './theme';

const SID = 3;
const PROBE_REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';
const DA1_REPLY = '\x1b[?1;2c';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class RecordingOut implements CoreOut {
	acks: [number, number, number][] = [];
	inputs: [number, number, string][] = [];
	resizes: [number, number, number][] = [];

	ack(sid: number, gen: number, off: number) {
		this.acks.push([sid, gen, off]);
	}
	input(sid: number, gen: number, bytes: Uint8Array) {
		this.inputs.push([sid, gen, decoder.decode(bytes)]);
	}
	resize(sid: number, cols: number, rows: number) {
		this.resizes.push([sid, cols, rows]);
	}
	get calls() {
		return this.acks.length + this.inputs.length + this.resizes.length;
	}
}

// Holds every write until the test releases its callback, so that callbacks
// can run late and out of order; the rest is a real headless terminal. The
// held data is never parsed.
class HeldTerm implements TermLike {
	readonly real = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
	readonly held: (() => void)[] = [];

	get cols() {
		return this.real.cols;
	}
	get rows() {
		return this.real.rows;
	}
	get buffer() {
		return this.real.buffer;
	}
	get parser() {
		return this.real.parser;
	}
	get unicode() {
		return this.real.unicode;
	}
	get onData() {
		return this.real.onData;
	}
	get onWriteParsed() {
		return this.real.onWriteParsed;
	}
	write(_data: string | Uint8Array, callback: () => void) {
		this.held.push(callback);
	}
	input(data: string, wasUserInput?: boolean) {
		this.real.input(data, wasUserInput);
	}
	resize(cols: number, rows: number) {
		this.real.resize(cols, rows);
	}
	loadAddon(addon: ITerminalAddon) {
		this.real.loadAddon(addon);
	}
	release(i: number) {
		this.held[i]();
	}
}

function replay(gen: number, from: number, to = from, cols = 80, rows = 24): Replay {
	return { t: 'replay', sid: SID, gen, from, to, cols, rows };
}

function live(gen: number, off: number, ro = false): Live {
	return { t: 'live', sid: SID, gen, off, ro };
}

function frame(type: number, gen: number, data: string | Uint8Array, sid = SID): Frame {
	return { type, sid, gen, payload: typeof data === 'string' ? encoder.encode(data) : data };
}

const prefix = (gen: number) => frame(FRAME_REPLAY, gen, '');

const exit: Exit = { t: 'exit', sid: SID, code: 0 };

// xterm parses its write queue from a zero-delay timer.
const flush = () => vi.advanceTimersByTime(0);

function screen(term: TermLike): string {
	const b = term.buffer.active;
	const lines: string[] = [];
	for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? '');
	return lines.join('\n').trimEnd();
}

function setup() {
	const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
	const out = new RecordingOut();
	const core = new SessionCore(term, SID, out);
	return { term, out, core };
}

// A core in a writable generation 1 whose empty replay has been written and
// whose nudge is over, with nothing recorded.
function writable() {
	const s = setup();
	s.core.replay(replay(1, 0));
	s.core.frame(prefix(1));
	s.core.live(live(1, 0));
	flush();
	vi.advanceTimersByTime(400);
	s.out.resizes.length = 0;
	return s;
}

function heldSetup() {
	const term = new HeldTerm();
	const out = new RecordingOut();
	const core = new SessionCore(term, SID, out);
	return { term, out, core };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('SessionCore queries', () => {
	it('answers a live DA1 but no query in the replay before it', () => {
		const { out, core } = setup();
		const replayed = '\x1b]7501;?\x1b\\\x1b]11;?\x1b\\\x1b[c';
		core.replay(replay(1, 0, replayed.length));
		core.frame(prefix(1));
		core.frame(frame(FRAME_REPLAY, 1, replayed));
		core.live(live(1, replayed.length));
		core.frame(frame(FRAME_LIVE, 1, '\x1b[c'));
		flush();
		expect(out.inputs).toEqual([[SID, 1, DA1_REPLY]]);
	});

	it('answers the status probe and DA1 in order, one input each', () => {
		const { out, core } = writable();
		core.frame(frame(FRAME_LIVE, 1, '\x1b]7501;?\x1b\\\x1b[c'));
		flush();
		expect(out.inputs).toEqual([
			[SID, 1, PROBE_REPLY],
			[SID, 1, DA1_REPLY],
		]);
	});

	it('answers colour queries from the theme', () => {
		const { out, core } = writable();
		core.frame(frame(FRAME_LIVE, 1, '\x1b]11;?\x1b\\'));
		core.frame(frame(FRAME_LIVE, 1, '\x1b]10;?\x1b\\\x1b]12;?\x1b\\'));
		core.frame(frame(FRAME_LIVE, 1, '\x1b]4;1;?\x1b\\'));
		core.frame(frame(FRAME_LIVE, 1, '\x1b]4;0;?;196;?\x1b\\'));
		flush();
		expect(out.inputs.map((i) => i[2])).toEqual([
			'\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\',
			`\x1b]10;${rgbReply(theme.foreground)}\x1b\\`,
			`\x1b]12;${rgbReply(theme.cursor)}\x1b\\`,
			`\x1b]4;1;${rgbReply(theme.red)}\x1b\\`,
			`\x1b]4;0;${rgbReply(theme.black)}\x1b\\\x1b]4;196;${rgbReply(paletteColor(196))}\x1b\\`,
		]);
	});

	it('counts a status report without answering or drawing it', () => {
		const { term, out, core } = writable();
		core.frame(frame(FRAME_LIVE, 1, '\x1b]7501;state=working\x1b\\'));
		flush();
		expect(core.reports).toBe(1);
		expect(out.inputs).toEqual([]);
		expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('');
	});
});

describe('SessionCore acks and generations', () => {
	it('batches acks of ring bytes, leaving out the prefix, and acks 64KB at once', () => {
		const { out, core } = setup();
		core.replay(replay(1, 100, 100 + 3072));
		core.frame(frame(FRAME_REPLAY, 1, '\x1b[?25h'));
		for (let i = 0; i < 3; i++) core.frame(frame(FRAME_REPLAY, 1, 'x'.repeat(1024)));
		core.live(live(1, 100 + 3072));
		flush();
		vi.advanceTimersByTime(99);
		expect(out.acks).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(out.acks).toEqual([[SID, 1, 3172]]);

		core.frame(frame(FRAME_LIVE, 1, new Uint8Array(65536).fill(0x61)));
		flush();
		expect(out.acks).toEqual([
			[SID, 1, 3172],
			[SID, 1, 3172 + 65536],
		]);
	});

	it('neither writes nor acks a frame before the first replay or of another gen or sid', () => {
		const { term, out, core } = setup();
		core.frame(frame(FRAME_LIVE, 1, 'early'));
		flush();
		core.replay(replay(2, 0));
		core.frame(prefix(2));
		core.live(live(2, 0));
		core.frame(frame(FRAME_LIVE, 1, 'stale'));
		core.frame(frame(FRAME_LIVE, 2, 'other', SID + 1));
		flush();
		vi.advanceTimersByTime(1000);
		expect(screen(term)).toBe('');
		expect(out.acks).toEqual([]);
		expect(core.off).toBe(0);
	});

	it('clears the screen for a new generation once the queue drains and restarts off', () => {
		const { term, out, core } = setup();
		core.replay(replay(1, 0, 5));
		core.frame(prefix(1));
		core.frame(frame(FRAME_REPLAY, 1, 'hello'));
		core.live(live(1, 5));
		flush();
		expect(screen(term)).toBe('hello');

		// Still queued when the next generation starts.
		core.frame(frame(FRAME_LIVE, 1, '\r\nworld'));
		core.replay(replay(2, 500));
		expect(core.off).toBe(500);
		core.frame(prefix(2));
		core.live(live(2, 500));
		flush();
		expect(screen(term)).toBe('');
		expect(term.buffer.active.length).toBe(term.rows);
		expect(core.resets).toBe(1);
		expect(term.unicode.activeVersion).toBe('11');

		core.frame(frame(FRAME_LIVE, 2, 'abc'));
		flush();
		vi.advanceTimersByTime(100);
		expect(out.acks).toEqual([[SID, 2, 503]]);
	});
});

describe('SessionCore input and size', () => {
	it('nudges the size after a writable live only', () => {
		const { out, core } = setup();
		core.replay(replay(1, 0));
		core.frame(prefix(1));
		core.live(live(1, 0));
		flush();
		expect(out.resizes).toEqual([[SID, 79, 24]]);
		vi.advanceTimersByTime(399);
		expect(out.resizes).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(out.resizes).toEqual([
			[SID, 79, 24],
			[SID, 80, 24],
		]);

		const ro = setup();
		ro.core.replay(replay(1, 0));
		ro.core.frame(prefix(1));
		ro.core.live(live(1, 0, true));
		flush();
		vi.advanceTimersByTime(1000);
		expect(ro.out.resizes).toEqual([]);
	});

	it('cuts a nudge in progress short at a new generation and nudges once', () => {
		const { out, core } = setup();
		core.replay(replay(1, 0));
		core.frame(prefix(1));
		core.live(live(1, 0));
		flush();
		vi.advanceTimersByTime(200);
		core.replay(replay(2, 0));
		core.frame(prefix(2));
		core.live(live(2, 0));
		flush();
		vi.advanceTimersByTime(399);
		expect(out.resizes).toEqual([
			[SID, 79, 24],
			[SID, 79, 24],
		]);
		vi.advanceTimersByTime(1000);
		expect(out.resizes).toEqual([
			[SID, 79, 24],
			[SID, 79, 24],
			[SID, 80, 24],
		]);
	});

	it('sends input only once the replay has been written, with the current gen', () => {
		const { out, core } = setup();
		core.replay(replay(4, 0));
		core.frame(prefix(4));
		core.live(live(4, 0));
		core.sendInput('x');
		expect(out.inputs).toEqual([]);
		flush();
		core.sendInput('x');
		expect(out.inputs).toEqual([[SID, 4, 'x']]);
	});

	it('applies a proposed size only when it differs', () => {
		const { term, out, core } = writable();
		core.fitted(80, 24);
		expect(out.resizes).toEqual([]);
		core.fitted(100, 30);
		expect([term.cols, term.rows]).toEqual([100, 30]);
		expect(out.resizes).toEqual([[SID, 100, 30]]);
	});

	it('holds a proposed size until the core is writable, then nudges from it', () => {
		const { term, out, core } = setup();
		core.fitted(100, 30);
		expect(out.resizes).toEqual([]);
		expect([term.cols, term.rows]).toEqual([80, 24]);
		core.replay(replay(1, 0));
		core.frame(prefix(1));
		core.live(live(1, 0));
		flush();
		expect(out.resizes).toEqual([
			[SID, 100, 30],
			[SID, 99, 30],
		]);
		vi.advanceTimersByTime(400);
		expect(out.resizes).toEqual([
			[SID, 100, 30],
			[SID, 99, 30],
			[SID, 100, 30],
		]);
	});

	it('restores the size a nudge cut short by a new generation or a reconnect would have', () => {
		const { term, out, core } = setup();
		core.replay(replay(1, 0));
		core.frame(prefix(1));
		core.live(live(1, 0));
		flush();
		// The daemon restarts the subscription at the nudged size.
		core.replay(replay(2, 0, 0, 79, 24));
		core.frame(prefix(2));
		core.live(live(2, 0));
		flush();
		vi.advanceTimersByTime(400);
		expect([term.cols, term.rows]).toEqual([80, 24]);
		expect(out.resizes).toEqual([
			[SID, 79, 24],
			[SID, 80, 24],
			[SID, 79, 24],
			[SID, 80, 24],
		]);

		const r = setup();
		r.core.replay(replay(1, 0));
		r.core.frame(prefix(1));
		r.core.live(live(1, 0));
		flush();
		r.core.detach();
		const outB = new RecordingOut();
		r.core.attach(outB);
		r.core.replay(replay(1, 0, 0, 79, 24));
		r.core.frame(prefix(1));
		r.core.live(live(1, 0));
		flush();
		vi.advanceTimersByTime(400);
		expect([r.term.cols, r.term.rows]).toEqual([80, 24]);
		expect(outB.resizes).toEqual([
			[SID, 80, 24],
			[SID, 79, 24],
			[SID, 80, 24],
		]);
	});

	it('keeps the gate shut from a new replay until its live, ignoring a live of another gen', () => {
		const { out, core } = writable();
		core.replay(replay(2, 0));
		core.frame(prefix(2));
		flush();
		core.sendInput('x');
		core.live(live(1, 0));
		core.sendInput('y');
		expect(out.inputs).toEqual([]);
		expect(out.resizes).toEqual([]);
		core.live(live(2, 0));
		core.sendInput('z');
		expect(out.inputs).toEqual([[SID, 2, 'z']]);
	});

	it('sends no input or resize after the exit', () => {
		const { term, out, core } = writable();
		core.exit(exit);
		core.sendInput('x');
		core.fitted(100, 30);
		vi.advanceTimersByTime(1000);
		expect(out.inputs).toEqual([]);
		expect(out.resizes).toEqual([]);
		expect([term.cols, term.rows]).toEqual([80, 24]);
	});

	it('stops a nudge at the exit and never nudges a session that has exited', () => {
		const { out, core } = setup();
		core.replay(replay(1, 0));
		core.frame(prefix(1));
		core.live(live(1, 0));
		flush();
		core.exit(exit);
		vi.advanceTimersByTime(1000);
		expect(out.resizes).toEqual([[SID, 79, 24]]);

		// Subscribing to a session that has exited: its replay, live and exit
		// all arrive before xterm has parsed the replay.
		const late = setup();
		late.core.fitted(100, 30);
		late.core.replay(replay(1, 0));
		late.core.frame(prefix(1));
		late.core.live(live(1, 0));
		late.core.exit(exit);
		flush();
		vi.advanceTimersByTime(1000);
		expect(late.out.resizes).toEqual([]);
	});
});

describe('SessionCore callbacks across connections and generations', () => {
	it('ignores callbacks and timers of a detached connection', () => {
		const { term, out: outA, core } = heldSetup();
		core.replay(replay(1, 0));
		core.frame(prefix(1)); // held 0
		core.live(live(1, 0));
		core.frame(frame(FRAME_LIVE, 1, 'a'.repeat(10))); // held 1
		core.frame(frame(FRAME_LIVE, 1, 'b'.repeat(7))); // held 2
		term.release(0); // starts A's nudge
		term.release(1); // arms A's ack timer
		const callsA = outA.calls;

		core.detach();
		const outB = new RecordingOut();
		core.attach(outB);
		vi.advanceTimersByTime(1000);
		expect(outA.calls).toBe(callsA);
		expect(outA.acks).toEqual([]);
		// Timers call out when they fire, so a leaked one would reach B.
		expect(outB.calls).toBe(0);

		// Generation 1 again, as every new subscription starts.
		core.replay(replay(1, 0, 20)); // held 3: the RIS
		core.frame(prefix(1)); // held 4
		core.frame(frame(FRAME_REPLAY, 1, 'c'.repeat(20))); // held 5
		core.live(live(1, 20));
		term.release(2);
		vi.advanceTimersByTime(100);
		expect(outA.calls).toBe(callsA);
		expect(outB.calls).toBe(0);
		expect(core.pendingReplay).toBe(3);

		term.release(3);
		term.release(4);
		term.release(5);
		vi.advanceTimersByTime(99);
		expect(outB.acks).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(outB.acks).toEqual([[SID, 1, 20]]);
		vi.advanceTimersByTime(1000);
		expect(outA.calls).toBe(callsA);
		expect(outB.resizes).toEqual([
			[SID, 79, 24],
			[SID, 80, 24],
		]);
		expect(core.resets).toBe(1);
	});

	it('drops the nudge an earlier generation asked for until its own live', () => {
		const { term, out, core } = heldSetup();
		core.replay(replay(1, 0));
		core.frame(prefix(1)); // held 0
		core.live(live(1, 0));
		core.replay(replay(2, 0)); // held 1: the RIS
		core.frame(prefix(2)); // held 2
		term.release(0);
		term.release(1);
		term.release(2);
		expect(out.resizes).toEqual([]);
		core.live(live(2, 0));
		expect(out.resizes).toEqual([[SID, 79, 24]]);
	});

	it('counts only the current generation in the replay gate', () => {
		const { term, out, core } = heldSetup();
		core.replay(replay(1, 0));
		core.frame(prefix(1)); // held 0
		core.replay(replay(2, 0)); // held 1: the RIS
		core.frame(prefix(2)); // held 2
		core.live(live(2, 0));
		expect(core.pendingReplay).toBe(2);
		expect(core.resets).toBe(1);

		term.release(1);
		core.sendInput('y');
		expect(out.inputs).toEqual([]);
		term.release(2);
		core.sendInput('x');
		expect(out.inputs).toEqual([[SID, 2, 'x']]);
		expect(out.resizes).toEqual([[SID, 79, 24]]);

		term.release(0);
		expect(core.pendingReplay).toBe(0);
		vi.advanceTimersByTime(400);
		expect(out.resizes).toEqual([
			[SID, 79, 24],
			[SID, 80, 24],
		]);
		expect(out.inputs).toHaveLength(1);
		expect(out.acks).toEqual([]);
	});

	it('applies a size proposed during the replay before the nudge', () => {
		const { term, out, core } = heldSetup();
		core.replay(replay(1, 0));
		core.frame(prefix(1)); // held 0
		core.live(live(1, 0));
		core.fitted(100, 30);
		expect(out.resizes).toEqual([]);
		expect([term.cols, term.rows]).toEqual([80, 24]);

		term.release(0);
		expect([term.cols, term.rows]).toEqual([100, 30]);
		expect(out.resizes).toEqual([
			[SID, 100, 30],
			[SID, 99, 30],
		]);
		vi.advanceTimersByTime(400);
		expect(out.resizes).toEqual([
			[SID, 100, 30],
			[SID, 99, 30],
			[SID, 100, 30],
		]);
	});
});
