import { describe, expect, it, vi } from 'vitest';
import { DaemonConnection, type CloseReason, type ConnectionHandlers, type SocketLike } from './connection';
import { FRAME_INPUT, FRAME_REPLAY, decodeFrame, encodeFrame, type SessionInfo } from './protocol';

class FakeSocket implements SocketLike {
	binaryType = 'blob';
	sent: (string | Uint8Array)[] = [];
	closeCalls: { code?: number; reason?: string }[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: ((ev: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;

	send(data: string | Uint8Array) {
		this.sent.push(data);
	}
	close(code?: number, reason?: string) {
		this.closeCalls.push({ code, reason });
	}
	open() {
		this.onopen?.();
	}
	receiveText(json: string) {
		this.onmessage?.({ data: json });
	}
	receiveBinary(bytes: Uint8Array) {
		this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
	}
	serverClose(code: number, reason: string) {
		this.onclose?.({ code, reason });
	}
}

const info: SessionInfo = {
	sid: 1, inc: 'a', cwd: '/tmp/repo', cmd: '', name: 'x', cols: 80, rows: 24, state: 'running', pid: 5, code: 0,
};

function setup() {
	const socket = new FakeSocket();
	const closed: CloseReason[] = [];
	const h = {
		ready: vi.fn(), sessions: vi.fn(), replay: vi.fn(), live: vi.fn(), exit: vi.fn(), error: vi.fn(), frame: vi.fn(),
		status: vi.fn(), notify: vi.fn(), repos: vi.fn(),
		closed: (r: CloseReason) => closed.push(r),
	} satisfies ConnectionHandlers;
	const conn = new DaemonConnection({ url: 'ws://127.0.0.1:1', token: 'tok' }, h, () => socket);
	return { socket, closed, h, conn };
}

function ready() {
	const s = setup();
	s.socket.open();
	s.socket.receiveText('{"t":"hello","v":1}');
	s.socket.receiveText(JSON.stringify({ t: 'sessions', list: [info] }));
	s.socket.sent.length = 0;
	return s;
}

describe('DaemonConnection', () => {
	it('sends hello first and nothing else before ready', () => {
		const { socket, conn } = setup();
		expect(socket.binaryType).toBe('arraybuffer');
		socket.open();
		conn.subscribe(1);
		expect(socket.sent).toEqual([JSON.stringify({ t: 'hello', v: 1, token: 'tok', client: 'gui' })]);
	});

	it('calls ready with the first sessions list', () => {
		const { socket, h } = setup();
		socket.open();
		socket.receiveText('{"t":"hello","v":1}');
		expect(h.ready).not.toHaveBeenCalled();
		socket.receiveText(JSON.stringify({ t: 'sessions', list: [info] }));
		expect(h.ready).toHaveBeenCalledWith([info], undefined);
	});

	it("passes the hello's build to ready", () => {
		const { socket, h } = setup();
		socket.open();
		socket.receiveText('{"t":"hello","v":1,"build":"0.1.0"}');
		socket.receiveText(JSON.stringify({ t: 'sessions', list: [] }));
		expect(h.ready).toHaveBeenCalledWith([], '0.1.0');
	});

	it('reports a version error', () => {
		const { socket, closed } = setup();
		socket.open();
		socket.receiveText('{"t":"error","code":"version","v":2}');
		socket.serverClose(1000, 'protocol version mismatch');
		expect(closed).toEqual([{ kind: 'version', daemonV: 2 }]);
	});

	it('fails on a binary message before the handshake completes', () => {
		const { socket, closed } = setup();
		socket.open();
		socket.receiveBinary(new Uint8Array(9));
		expect(socket.closeCalls).toHaveLength(1);
		expect(closed).toHaveLength(1);
		expect(closed[0].kind).toBe('failed');
	});

	it('fails when the socket closes before ready', () => {
		const { socket, closed } = setup();
		socket.onerror?.();
		socket.serverClose(1008, 'bad token');
		expect(closed).toEqual([{ kind: 'failed', detail: 'code 1008: bad token' }]);
	});

	it('fails on malformed JSON before and after ready', () => {
		const a = setup();
		a.socket.open();
		a.socket.receiveText('nope');
		expect(a.closed[0].kind).toBe('failed');
		const b = ready();
		b.socket.receiveText('nope');
		expect(b.closed[0].kind).toBe('failed');
	});

	it('dispatches live messages and replay frames after ready', () => {
		const { socket, h } = ready();
		socket.receiveText('{"t":"live","sid":1,"gen":3,"off":10,"ro":true}');
		expect(h.live).toHaveBeenCalledWith({ t: 'live', sid: 1, gen: 3, off: 10, ro: true });
		socket.receiveBinary(encodeFrame({ type: FRAME_REPLAY, sid: 1, gen: 3, payload: new Uint8Array([65, 66]) }));
		const f = h.frame.mock.calls[0][0];
		expect([f.type, f.sid, f.gen, Array.from(f.payload)]).toEqual([FRAME_REPLAY, 1, 3, [65, 66]]);
	});

	it('dispatches status and notify after ready', () => {
		const { socket, h } = ready();
		socket.receiveText('{"t":"status","sid":1,"status":null,"unread":false}');
		expect(h.status).toHaveBeenCalledWith({ t: 'status', sid: 1, status: null, unread: false });
		socket.receiveText('{"t":"notify","kind":"missed","count":2}');
		expect(h.notify).toHaveBeenCalledWith({ t: 'notify', kind: 'missed', count: 2 });
	});

	it('dispatches repos after ready', () => {
		const { socket, h } = ready();
		socket.receiveText('{"t":"repos","list":["/tmp/repo"]}');
		expect(h.repos).toHaveBeenCalledWith(['/tmp/repo']);
	});

	it('sends the repo, reopen, dismiss, rename and shutdown messages only when ready', () => {
		const a = setup();
		a.socket.open();
		a.conn.reposAdd('/tmp/repo');
		a.conn.reposRemove('/tmp/repo');
		a.conn.reopen(7, 120, 40);
		a.conn.dismiss(7);
		a.conn.rename(7, 'fix login');
		a.conn.shutdown(true);
		expect(a.socket.sent).toHaveLength(1);
		const b = ready();
		b.conn.reposAdd('/tmp/repo');
		b.conn.reposRemove('/tmp/repo');
		b.conn.reopen(7, 120, 40);
		b.conn.dismiss(7);
		b.conn.rename(7, 'fix login');
		b.conn.rename(7, '');
		b.conn.shutdown(true);
		b.conn.shutdown(false);
		expect(b.socket.sent).toEqual([
			'{"t":"repos.add","path":"/tmp/repo"}',
			'{"t":"repos.remove","path":"/tmp/repo"}',
			'{"t":"reopen","sid":7,"cols":120,"rows":40}',
			'{"t":"dismiss","sid":7}',
			'{"t":"rename","sid":7,"name":"fix login"}',
			'{"t":"rename","sid":7,"name":""}',
			'{"t":"shutdown","idle":true}',
			'{"t":"shutdown","idle":false}',
		]);
	});

	it('sends seen only when ready', () => {
		const a = setup();
		a.socket.open();
		a.conn.seen(1);
		expect(a.socket.sent).toHaveLength(1);
		const b = ready();
		b.conn.seen(1);
		expect(b.socket.sent).toEqual(['{"t":"seen","sid":1}']);
	});

	it('ignores unknown message types and unexpected frame types after ready', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { socket, h, closed } = ready();
		socket.receiveText('{"t":"future"}');
		socket.receiveBinary(encodeFrame({ type: 0x7f, sid: 1, gen: 1, payload: new Uint8Array(1) }));
		expect(h.frame).not.toHaveBeenCalled();
		expect(closed).toEqual([]);
		warn.mockRestore();
	});

	it('splits a 70000 byte input into two frames carrying the gen', () => {
		const { socket, conn } = ready();
		conn.input(7, 4, new Uint8Array(70000));
		expect(socket.sent).toHaveLength(2);
		const frames = socket.sent.map((s) => {
			const u = s as Uint8Array;
			return decodeFrame(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer);
		});
		expect(frames.map((f) => [f.type, f.sid, f.gen, f.payload.length])).toEqual([
			[FRAME_INPUT, 7, 4, 65536],
			[FRAME_INPUT, 7, 4, 70000 - 65536],
		]);
	});

	it('omits empty optional fields in create', () => {
		const { socket, conn } = ready();
		conn.create('', '', '', 80, 24);
		conn.create('/tmp/repo', 'claude', 'n', 100, 30);
		expect(socket.sent).toEqual([
			'{"t":"create","cols":80,"rows":24}',
			'{"t":"create","cwd":"/tmp/repo","cmd":"claude","name":"n","cols":100,"rows":30}',
		]);
	});

	it('reports a server close once as closed and drops later sends', () => {
		const { socket, conn, closed } = ready();
		socket.serverClose(1001, 'going away');
		socket.serverClose(1001, 'going away');
		conn.ack(1, 1, 5);
		expect(closed).toEqual([{ kind: 'closed', detail: 'code 1001: going away' }]);
		expect(socket.sent).toEqual([]);
	});

	it('reports a local close once', () => {
		const { socket, conn, closed } = ready();
		conn.close();
		socket.serverClose(1000, '');
		expect(closed).toHaveLength(1);
		expect(closed[0].kind).toBe('closed');
	});

	it('reports once and closes with 1002 when a protocol failure is followed by a server close', () => {
		const { socket, closed } = setup();
		socket.open();
		socket.receiveText('{"t":"sessions","list":[]}');
		socket.serverClose(1002, 'protocol error');
		expect(socket.closeCalls).toEqual([{ code: 1002, reason: 'protocol error' }]);
		expect(closed).toEqual([{ kind: 'failed', detail: 'handshake: expected hello' }]);
	});

	it('names the version of a mismatched hello', () => {
		const { socket, closed } = setup();
		socket.open();
		socket.receiveText('{"t":"hello","v":9}');
		expect(closed).toEqual([{ kind: 'failed', detail: 'handshake: unexpected hello version 9' }]);
	});

	it('closes the socket on a version error and reports once despite the following close', () => {
		const { socket, closed } = setup();
		socket.open();
		socket.receiveText('{"t":"error","code":"version","v":2}');
		socket.serverClose(1000, 'protocol version mismatch');
		expect(socket.closeCalls).toHaveLength(1);
		expect(closed).toHaveLength(1);
	});

	it('calls no handler for messages arriving after closed', () => {
		const { socket, h } = ready();
		socket.serverClose(1001, '');
		socket.receiveText('{"t":"live","sid":1,"gen":1,"off":0,"ro":false}');
		socket.receiveBinary(encodeFrame({ type: FRAME_REPLAY, sid: 1, gen: 1, payload: new Uint8Array(1) }));
		expect(h.live).not.toHaveBeenCalled();
		expect(h.frame).not.toHaveBeenCalled();
	});

	it('sends no input before ready or after close', () => {
		const a = setup();
		a.socket.open();
		a.conn.input(1, 1, new Uint8Array(3));
		expect(a.socket.sent).toHaveLength(1);
		const b = ready();
		b.conn.close();
		b.conn.input(1, 1, new Uint8Array(3));
		expect(b.socket.sent).toEqual([]);
	});

	it('does not close the socket when a handler throws', () => {
		const { socket, h, closed } = ready();
		h.live.mockImplementation(() => {
			throw new Error('handler bug');
		});
		expect(() => socket.receiveText('{"t":"live","sid":1,"gen":1,"off":0,"ro":false}')).toThrow('handler bug');
		expect(socket.closeCalls).toEqual([]);
		expect(closed).toEqual([]);
	});
});
