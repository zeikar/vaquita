import { describe, expect, it } from 'vitest';
import {
	FRAME_INPUT,
	FRAME_LIVE,
	FRAME_REPLAY,
	HEADER_SIZE,
	MAX_PAYLOAD,
	decodeFrame,
	encodeFrame,
	parseMessage,
	splitInput,
} from './protocol';

function toBuffer(b: Uint8Array): ArrayBuffer {
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe('frames', () => {
	const sid = 0x01020304;
	const gen = 0xfedcba98;

	it.each([FRAME_LIVE, FRAME_REPLAY, FRAME_INPUT])('round-trips type %d with big-endian ids', (type) => {
		const payload = new Uint8Array([1, 2, 3, 255]);
		const enc = encodeFrame({ type, sid, gen, payload });
		expect(Array.from(enc.subarray(0, HEADER_SIZE))).toEqual([type, 1, 2, 3, 4, 0xfe, 0xdc, 0xba, 0x98]);
		const dec = decodeFrame(toBuffer(enc));
		expect(dec.type).toBe(type);
		expect(dec.sid).toBe(sid);
		expect(dec.gen).toBe(gen);
		expect(Array.from(dec.payload)).toEqual([1, 2, 3, 255]);
	});

	it('decodes a hand-written header', () => {
		const buf = new Uint8Array([0x02, 0, 0, 0, 7, 0x80, 0, 0, 1, 0x41]).buffer;
		const dec = decodeFrame(buf);
		expect(dec).toMatchObject({ type: 0x02, sid: 7, gen: 0x80000001 });
		expect(Array.from(dec.payload)).toEqual([0x41]);
	});

	it('returns the payload as a view of the input buffer', () => {
		const buf = toBuffer(encodeFrame({ type: FRAME_LIVE, sid: 1, gen: 1, payload: new Uint8Array([9]) }));
		expect(decodeFrame(buf).payload.buffer).toBe(buf);
	});

	it('accepts an empty and a maximal payload', () => {
		expect(decodeFrame(new ArrayBuffer(HEADER_SIZE)).payload.length).toBe(0);
		const max = encodeFrame({ type: FRAME_INPUT, sid: 1, gen: 1, payload: new Uint8Array(MAX_PAYLOAD) });
		expect(decodeFrame(toBuffer(max)).payload.length).toBe(MAX_PAYLOAD);
	});

	it('rejects a buffer shorter than the header', () => {
		expect(() => decodeFrame(new ArrayBuffer(HEADER_SIZE - 1))).toThrow();
	});

	it('rejects a payload over 64KB on decode and encode', () => {
		expect(() => decodeFrame(new ArrayBuffer(HEADER_SIZE + MAX_PAYLOAD + 1))).toThrow();
		expect(() =>
			encodeFrame({ type: FRAME_INPUT, sid: 1, gen: 1, payload: new Uint8Array(MAX_PAYLOAD + 1) }),
		).toThrow();
	});
});

describe('splitInput', () => {
	it.each([
		[0, []],
		[1, [1]],
		[MAX_PAYLOAD, [MAX_PAYLOAD]],
		[MAX_PAYLOAD + 1, [MAX_PAYLOAD, 1]],
		[2 * MAX_PAYLOAD + 5, [MAX_PAYLOAD, MAX_PAYLOAD, 5]],
	])('splits %i bytes into slices of %j', (n, lengths) => {
		const parts = splitInput(new Uint8Array(n));
		expect(parts.map((p) => p.length)).toEqual(lengths);
	});

	it('keeps byte order across slices', () => {
		const input = new Uint8Array(MAX_PAYLOAD + 2).map((_, i) => i % 251);
		const joined = new Uint8Array(input.length);
		let at = 0;
		for (const p of splitInput(input)) {
			joined.set(p, at);
			at += p.length;
		}
		expect(joined).toEqual(input);
	});
});

describe('parseMessage', () => {
	it('round-trips a live with ro true', () => {
		const m = { t: 'live', sid: 3, gen: 1, off: 4096, ro: true };
		expect(parseMessage(JSON.stringify(m))).toEqual(m);
	});

	it('parses a sessions list with orphans', () => {
		const info = {
			sid: 1, inc: 'a', cwd: '/tmp/repo', cmd: 'sh', name: 'n', cols: 80, rows: 24,
			state: 'exited', pid: 10, code: 0, orphans: [11],
		};
		expect(parseMessage(JSON.stringify({ t: 'sessions', list: [info] }))).toEqual({ t: 'sessions', list: [info] });
	});

	it.each([
		['status', { t: 'status', sid: 3, status: { state: 'input', kind: 'permission', msg: 'Run make?' }, unread: false }],
		['notify', { t: 'notify', sid: 3, kind: 'error', msg: 'build failed' }],
		['repos list', { t: 'repos', list: ['/tmp/repo', '/tmp/repo-feature'] }],
		['empty repos list', { t: 'repos', list: [] }],
		['missed summary', { t: 'notify', kind: 'missed', count: 2 }],
	])('round-trips a %s', (_, m) => {
		expect(parseMessage(JSON.stringify(m))).toEqual(m);
	});

	it('keeps the null of a status that clears the row', () => {
		expect(parseMessage('{"t":"status","sid":3,"status":null,"unread":false}')).toEqual({
			t: 'status', sid: 3, status: null, unread: false,
		});
	});

	it('parses a sessions list with a status and unread', () => {
		const info = {
			sid: 1, inc: 'a', cwd: '/tmp/repo', cmd: 'sh', name: '', cols: 80, rows: 24,
			state: 'running', pid: 10, code: 0, status: { state: 'done', msg: 'ok' }, unread: true,
		};
		expect(parseMessage(JSON.stringify({ t: 'sessions', list: [info] }))).toEqual({ t: 'sessions', list: [info] });
	});

	it('rejects an unknown type, a client-only type and non-JSON', () => {
		expect(() => parseMessage('{"t":"nope"}')).toThrow();
		expect(() => parseMessage('{"t":"subscribe","sid":1}')).toThrow();
		expect(() => parseMessage('{"t":"seen","sid":1}')).toThrow();
		expect(() => parseMessage('not json')).toThrow();
		expect(() => parseMessage('null')).toThrow();
	});
});
