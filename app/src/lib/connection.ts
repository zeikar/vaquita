import {
	CLIENT_GUI,
	CODE_VERSION,
	FRAME_INPUT,
	FRAME_LIVE,
	FRAME_REPLAY,
	VERSION,
	decodeFrame,
	encodeFrame,
	parseMessage,
	UnknownMessageError,
	splitInput,
	type ClientMessage,
	type DaemonMessage,
	type ErrorMessage,
	type Exit,
	type Frame,
	type Live,
	type Replay,
	type SessionInfo,
} from './protocol';

export interface SocketLike {
	binaryType: string;
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onclose: ((ev: { code: number; reason: string }) => void) | null;
	onerror: (() => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export type CloseReason =
	| { kind: 'version'; daemonV: number }
	| { kind: 'closed' | 'failed'; detail: string };

export interface ConnectionHandlers {
	ready(list: SessionInfo[]): void;
	sessions(list: SessionInfo[]): void;
	replay(m: Replay): void;
	live(m: Live): void;
	exit(m: Exit): void;
	error(m: ErrorMessage): void;
	frame(f: Frame): void;
	closed(reason: CloseReason): void;
}

type State = 'hello' | 'sessions' | 'ready' | 'closed';

const CLOSE_PROTOCOL_ERROR = 1002;

export class DaemonConnection {
	private readonly socket: SocketLike;
	private state: State = 'hello';

	constructor(
		endpoint: { url: string; token: string },
		private readonly handlers: ConnectionHandlers,
		factory: SocketFactory = defaultFactory,
	) {
		this.socket = factory(endpoint.url);
		this.socket.binaryType = 'arraybuffer';
		this.socket.onopen = () => {
			if (this.state === 'hello') {
				this.sendJSON({ t: 'hello', v: VERSION, token: endpoint.token, client: CLIENT_GUI });
			}
		};
		this.socket.onmessage = (ev) => this.onMessage(ev.data);
		// An error is always followed by a close event, which reports.
		this.socket.onerror = () => {};
		this.socket.onclose = (ev) => {
			const detail = `code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''}`;
			this.finish({ kind: this.state === 'ready' ? 'closed' : 'failed', detail });
		};
	}

	create(cwd: string, cmd: string, name: string, cols: number, rows: number): void {
		// The daemon treats missing cwd/cmd/name as "use the default".
		this.sendReady({
			t: 'create',
			...(cwd && { cwd }),
			...(cmd && { cmd }),
			...(name && { name }),
			cols,
			rows,
		});
	}

	subscribe(sid: number): void {
		this.sendReady({ t: 'subscribe', sid });
	}

	unsubscribe(sid: number): void {
		this.sendReady({ t: 'unsubscribe', sid });
	}

	ack(sid: number, gen: number, off: number): void {
		this.sendReady({ t: 'ack', sid, gen, off });
	}

	resize(sid: number, cols: number, rows: number): void {
		this.sendReady({ t: 'resize', sid, cols, rows });
	}

	kill(sid: number): void {
		this.sendReady({ t: 'kill', sid });
	}

	input(sid: number, gen: number, bytes: Uint8Array): void {
		if (this.state !== 'ready') return;
		for (const payload of splitInput(bytes)) {
			this.socket.send(encodeFrame({ type: FRAME_INPUT, sid, gen, payload }));
		}
	}

	close(): void {
		if (this.state === 'closed') return;
		this.socket.close(1000);
		// Report now rather than waiting for a close event that a dead socket may never deliver.
		this.finish({ kind: 'closed', detail: 'closed locally' });
	}

	private sendJSON(m: ClientMessage): void {
		this.socket.send(JSON.stringify(m));
	}

	private sendReady(m: ClientMessage): void {
		if (this.state === 'ready') this.sendJSON(m);
	}

	private finish(reason: CloseReason): void {
		if (this.state === 'closed') return;
		this.state = 'closed';
		this.handlers.closed(reason);
	}

	private fail(detail: string): void {
		if (this.state === 'closed') return;
		this.socket.close(CLOSE_PROTOCOL_ERROR, 'protocol error');
		this.finish({ kind: 'failed', detail });
	}

	// Only parsing and decoding are guarded: a throwing handler is a bug in the
	// caller, not a protocol error, and must not close the socket.
	private onMessage(data: unknown): void {
		if (this.state === 'closed') return;
		let m: DaemonMessage | null;
		let f: Frame | null = null;
		try {
			if (typeof data === 'string') m = this.parse(data);
			else {
				m = null;
				f = this.decode(data);
			}
		} catch (e) {
			this.fail(e instanceof Error ? e.message : String(e));
			return;
		}
		if (m !== null) this.onMessageParsed(m);
		else if (f !== null) this.handlers.frame(f);
	}

	private onMessageParsed(m: DaemonMessage): void {
		switch (this.state) {
			case 'hello':
				if (m.t === 'error' && m.code === CODE_VERSION) {
					this.socket.close(1000);
					this.finish({ kind: 'version', daemonV: m.v ?? 0 });
				} else if (m.t === 'hello' && m.v === VERSION) {
					this.state = 'sessions';
				} else if (m.t === 'hello') {
					this.fail(`handshake: unexpected hello version ${m.v}`);
				} else {
					this.fail('handshake: expected hello');
				}
				return;
			case 'sessions':
				if (m.t !== 'sessions') return this.fail('handshake: expected sessions');
				this.state = 'ready';
				this.handlers.ready(m.list);
				return;
			case 'ready':
				this.dispatch(m);
		}
	}

	// Before ready an unknown message is a failed handshake; after, it is skipped
	// so a newer daemon can add message types.
	private parse(text: string): DaemonMessage | null {
		try {
			return parseMessage(text);
		} catch (e) {
			if (this.state === 'ready' && e instanceof UnknownMessageError) {
				console.warn(e.message);
				return null;
			}
			throw e;
		}
	}

	private dispatch(m: DaemonMessage): void {
		switch (m.t) {
			case 'sessions':
				return this.handlers.sessions(m.list);
			case 'replay':
				return this.handlers.replay(m);
			case 'live':
				return this.handlers.live(m);
			case 'exit':
				return this.handlers.exit(m);
			case 'error':
				return this.handlers.error(m);
			case 'hello':
				console.warn('ignoring a second hello');
		}
	}

	private decode(data: unknown): Frame | null {
		if (this.state !== 'ready') throw new Error('handshake: binary message before ready');
		if (!(data instanceof ArrayBuffer)) throw new Error('binary message is not an ArrayBuffer');
		const f = decodeFrame(data);
		if (f.type !== FRAME_LIVE && f.type !== FRAME_REPLAY) {
			console.warn(`ignoring frame of type ${f.type}`);
			return null;
		}
		return f;
	}
}
