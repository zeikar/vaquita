import { Terminal } from '@xterm/headless';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ConnectionHandlers } from './connection';
import type { ConnectionLike } from './daemon-link';
import type { Endpoint } from './endpoint';
import { SessionManager, type ManagerState } from './manager';
import type { Notice } from './notify';
import { FRAME_REPLAY, type Live, type Replay, type SessionInfo } from './protocol';
import type { SessionCore, Size } from './session-core';

// What the SessionManager tests share: a fake connection and view, the
// messages a daemon sends, and managers started on them.

export class FakeConnection implements ConnectionLike {
	closed = false;
	// subscribe, create and kill, in the order sent.
	requests: (string | number)[][] = [];
	constructor(
		readonly endpoint: Endpoint,
		readonly emit: ConnectionHandlers,
	) {}
	close(): void {
		this.closed = true;
	}
	create(cwd: string, cmd: string, name: string, cols: number, rows: number): void {
		this.requests.push(['create', cwd, cmd, name, cols, rows]);
	}
	subscribe(sid: number): void {
		this.requests.push(['subscribe', sid]);
	}
	kill(sid: number): void {
		this.requests.push(['kill', sid]);
	}
	repoAdds: string[] = [];
	repoRemoves: string[] = [];
	dismisses: number[] = [];
	reposAdd(path: string): void {
		this.repoAdds.push(path);
	}
	reposRemove(path: string): void {
		this.repoRemoves.push(path);
	}
	reopen(sid: number, cols: number, rows: number): void {
		this.requests.push(['reopen', sid, cols, rows]);
	}
	dismiss(sid: number): void {
		this.dismisses.push(sid);
	}
	renames: [number, string][] = [];
	rename(sid: number, name: string): void {
		this.renames.push([sid, name]);
	}
	shutdowns: boolean[] = [];
	shutdown(idle: boolean): void {
		this.shutdowns.push(idle);
	}
	// Kept apart from requests: a seen is no request the daemon answers in turn.
	seens: number[] = [];
	seen(sid: number): void {
		this.seens.push(sid);
	}
	ack(): void {}
	input(): void {}
	resize(): void {}
	get subscribes(): number[] {
		return this.requests.filter((r) => r[0] === 'subscribe').map((r) => r[1] as number);
	}
}

class FakeView {
	size: Size | undefined;
	disposed = false;
	constructor(
		readonly term: Terminal,
		readonly core: SessionCore,
	) {}
	proposed(): Size | undefined {
		return this.size;
	}
	dispose(): void {
		this.disposed = true;
	}
}

export const ep: Endpoint = { url: 'ws://127.0.0.1:1/ws', token: 't', pid: 1 };
export const info = (sid: number, inc = 'i', state = 'running', restorable?: boolean): SessionInfo => ({
	sid, inc, cwd: '/tmp/repo', cmd: 'sh', name: '', cols: 80, rows: 24, state, pid: 2, code: 0,
	...(restorable ? { restorable } : {}),
});
export const record = (sid: number): SessionInfo => ({ ...info(sid, 'old', 'exited', true), cmd: 'claude', name: 'w' });
export const replay = (sid: number, gen = 1): Replay => ({ t: 'replay', sid, gen, from: 0, to: 0, cols: 80, rows: 24 });
export const live = (sid: number, ro = false): Live => ({ t: 'live', sid, gen: 1, off: 0, ro });

// The daemon's answer to a subscribe of an idle session.
export function answer(c: FakeConnection, sid: number, ro = false) {
	c.emit.replay(replay(sid));
	c.emit.frame({ type: FRAME_REPLAY, sid, gen: 1, payload: new Uint8Array() });
	c.emit.live(live(sid, ro));
}

const rejectStart = async () => {
	throw new Error('hint');
};

export function setup(
	readEndpoint: () => Promise<Endpoint> = async () => ep,
	connectHook: () => void = () => {},
	startDaemon: () => Promise<void> = rejectStart,
	{
		appBuild = async (): Promise<string | null> => null,
		checkRestart = async () => {},
		restartDaemon = async (_endpoint: Endpoint, _signal: boolean) => {},
	} = {},
) {
	const conns: FakeConnection[] = [];
	const notes: Notice[] = [];
	const read = vi.fn(readEndpoint);
	const start = vi.fn(startDaemon);
	const check = vi.fn(checkRestart);
	const restart = vi.fn(restartDaemon);
	const m = new SessionManager({
		readEndpoint: read,
		startDaemon: start,
		appBuild,
		checkRestart: check,
		restartDaemon: restart,
		connect: (endpoint, handlers) => {
			connectHook();
			const c = new FakeConnection(endpoint, handlers);
			conns.push(c);
			return c;
		},
		createTerminal: (cols, rows) => new Terminal({ cols, rows, allowProposedApi: true }),
		createView: (term, core) => new FakeView(term, core),
		notifier: { show: (n) => notes.push(n) },
	});
	let state!: ManagerState<FakeView>;
	let emits = 0;
	m.subscribe((s) => {
		state = s;
		emits++;
	});
	const row = (sid: number) => state.sessions.find((r) => r.info.sid === sid);
	return { m, conns, notes, read, start, check, restart, state: () => state, row, emits: () => emits };
}

// Started, with the first connection past its handshake.
export async function connected(list: SessionInfo[], selected?: number) {
	if (selected !== undefined) localStorage.setItem('vaquita.selected', String(selected));
	const t = setup();
	t.m.start();
	await vi.advanceTimersByTimeAsync(0);
	t.conns[0].emit.ready(list);
	return { ...t, c: t.conns[0] };
}

// The connection that replaces the current one after it closes.
export async function reconnect(t: Awaited<ReturnType<typeof connected>>, list: SessionInfo[], build?: string) {
	t.conns.at(-1)!.emit.closed({ kind: 'closed', detail: 'code 1006' });
	await vi.advanceTimersByTimeAsync(1000);
	const c = t.conns.at(-1)!;
	c.emit.ready(list, build);
	return c;
}

// Fake timers and an empty localStorage for each test of the calling file.
export function fakeTimersAndStorage(): void {
	beforeEach(() => {
		vi.useFakeTimers();
		const store = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
}
