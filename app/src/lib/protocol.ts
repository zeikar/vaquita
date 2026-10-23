// Mirrors daemon/internal/protocol; the Go code is the contract.

export const VERSION = 1;
export const CLIENT_GUI = 'gui';

export const HEADER_SIZE = 9;
export const MAX_PAYLOAD = 64 * 1024;

export const FRAME_LIVE = 0x01;
export const FRAME_REPLAY = 0x02;
export const FRAME_INPUT = 0x10;

export const CODE_VERSION = 'version';
export const CODE_NO_SESSION = 'no-session';
export const CODE_INPUT_OVERFLOW = 'input-overflow';
export const CODE_BAD_REQUEST = 'bad-request';
export const CODE_ORPHANS = 'orphans';
export const CODE_BAD_PATH = 'bad-path';
export const CODE_CONVERSATION_LIVE = 'conversation-live';

export const STATE_RUNNING = 'running';
export const STATE_EXITED = 'exited';

// Client to daemon.
export interface ClientHello {
	t: 'hello';
	v: number;
	token?: string;
	client?: string;
}
export interface Create {
	t: 'create';
	cwd?: string;
	cmd?: string;
	name?: string;
	cols: number;
	rows: number;
}
export interface Subscribe {
	t: 'subscribe';
	sid: number;
}
export interface Unsubscribe {
	t: 'unsubscribe';
	sid: number;
}
export interface Ack {
	t: 'ack';
	sid: number;
	gen: number;
	off: number;
}
export interface Resize {
	t: 'resize';
	sid: number;
	cols: number;
	rows: number;
}
export interface Kill {
	t: 'kill';
	sid: number;
}
export interface Seen {
	t: 'seen';
	sid: number;
}
export interface ReposAdd {
	t: 'repos.add';
	path: string;
}
export interface ReposRemove {
	t: 'repos.remove';
	path: string;
}
// Starts a new session from the restorable record sid, like a Create; the
// connection that sent it is subscribed to the new session.
export interface Reopen {
	t: 'reopen';
	sid: number;
	cols: number;
	rows: number;
}
export interface Dismiss {
	t: 'dismiss';
	sid: number;
}
export type ClientMessage =
	| ClientHello
	| Create
	| Subscribe
	| Unsubscribe
	| Ack
	| Resize
	| Kill
	| Seen
	| ReposAdd
	| ReposRemove
	| Reopen
	| Dismiss;

// Daemon to client.
export interface DaemonHello {
	t: 'hello';
	v: number;
}
export interface SessionInfo {
	sid: number;
	inc: string;
	cwd: string;
	cmd: string;
	name: string;
	cols: number;
	rows: number;
	state: string;
	pid: number;
	code: number;
	orphans?: number[];
	// Left out when the row shows nothing, which is all an older daemon sends.
	status?: StatusInfo;
	unread?: boolean;
	// A record from an earlier daemon run: no PTY here and no orphans, so
	// Reopen and Dismiss accept it. Left out otherwise.
	restorable?: boolean;
	// The topic Claude Code gave the session as its window title; left out
	// when there is none, which is all an older daemon sends. A row is titled
	// by its name, else this, else its cmd.
	title?: string;
}
// What a session's row shows. kind (permission or question) refines input
// and auth; msg is the text to show.
export interface StatusInfo {
	state: 'working' | 'input' | 'auth' | 'done' | 'error';
	kind?: string;
	msg?: string;
}
export interface Sessions {
	t: 'sessions';
	list: SessionInfo[];
}
export interface Replay {
	t: 'replay';
	sid: number;
	gen: number;
	from: number;
	to: number;
	cols: number;
	rows: number;
}
export interface Live {
	t: 'live';
	sid: number;
	gen: number;
	off: number;
	ro: boolean;
}
export interface Exit {
	t: 'exit';
	sid: number;
	code: number;
}
export interface ErrorMessage {
	t: 'error';
	code: string;
	v?: number;
	sid?: number;
	pids?: number[];
}
// A change of one session's row; a null status clears it.
export interface Status {
	t: 'status';
	sid: number;
	status: StatusInfo | null;
	unread: boolean;
}
// missed summarizes, in count, the notifications raised while no GUI was
// connected, and names no session.
export interface Notify {
	t: 'notify';
	sid?: number;
	kind: 'done' | 'error' | 'input' | 'auth' | 'missed';
	msg?: string;
	count?: number;
}
// The registered repo list; never null on the wire.
export interface Repos {
	t: 'repos';
	list: string[];
}
export type DaemonMessage =
	| DaemonHello
	| Sessions
	| Replay
	| Live
	| Exit
	| ErrorMessage
	| Status
	| Notify
	| Repos;

const DAEMON_TYPES = new Set(['hello', 'sessions', 'replay', 'live', 'exit', 'error', 'status', 'notify', 'repos']);

export class UnknownMessageError extends Error {}

export function parseMessage(text: string): DaemonMessage {
	const m = JSON.parse(text);
	if (m === null || typeof m !== 'object' || !DAEMON_TYPES.has(m.t)) {
		throw new UnknownMessageError(`parse message: unknown type ${JSON.stringify(m?.t)}`);
	}
	return m as DaemonMessage;
}

export interface Frame {
	type: number;
	sid: number;
	gen: number;
	payload: Uint8Array;
}

export function encodeFrame(f: Frame): Uint8Array {
	if (f.payload.length > MAX_PAYLOAD) throw new Error('protocol: frame payload over 64KB');
	const out = new Uint8Array(HEADER_SIZE + f.payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, f.type);
	view.setUint32(1, f.sid, false);
	view.setUint32(5, f.gen, false);
	out.set(f.payload, HEADER_SIZE);
	return out;
}

export function decodeFrame(buf: ArrayBuffer): Frame {
	if (buf.byteLength < HEADER_SIZE) throw new Error('protocol: frame shorter than its header');
	if (buf.byteLength - HEADER_SIZE > MAX_PAYLOAD) throw new Error('protocol: frame payload over 64KB');
	const view = new DataView(buf);
	return {
		type: view.getUint8(0),
		sid: view.getUint32(1, false),
		gen: view.getUint32(5, false),
		payload: new Uint8Array(buf, HEADER_SIZE),
	};
}

// The daemon rejects bigger input frames, so pastes and dropped paths are cut here.
export function splitInput(bytes: Uint8Array): Uint8Array[] {
	const parts: Uint8Array[] = [];
	for (let i = 0; i < bytes.length; i += MAX_PAYLOAD) {
		parts.push(bytes.subarray(i, i + MAX_PAYLOAD));
	}
	return parts;
}
