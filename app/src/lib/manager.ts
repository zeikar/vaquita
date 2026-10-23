import type { IDisposable } from '@xterm/xterm';
import type { CloseReason, ConnectionHandlers } from './connection';
import { NotRunningError, type Endpoint } from './endpoint';
import { notificationFor, shouldShow, type Notifier, type Target } from './notify';
import {
	CODE_NO_SESSION,
	CODE_ORPHANS,
	STATE_EXITED,
	STATE_RUNNING,
	type ErrorMessage,
	type Live,
	type Notify,
	type Replay,
	type SessionInfo,
	type Status as StatusMessage,
} from './protocol';
import { RequestSlot, type CreateRequest } from './requests';
import { SessionCore, type CoreOut, type Size, type TermLike } from './session-core';
import { load, save } from './storage';

export type Status = 'connecting' | 'starting' | 'connected' | 'not-running' | 'version-mismatch' | 'disconnected';

// A terminal the manager disposes with its session.
export interface ManagedTerm extends TermLike {
	dispose(): void;
}

// What the manager needs of a session's on-screen view.
export interface ViewLike {
	// The size the pane would give the terminal, once it can be measured.
	proposed(): Size | undefined;
	dispose(): void;
}

// What the UI shows of a session. SessionCore's fields are plain, so they are
// copied here whenever they may have changed.
export interface SessionRow<V> {
	info: SessionInfo;
	// From the session's latest live; false before one.
	ro: boolean;
	reports: number;
	resets: number;
	// Present once the session has a terminal.
	view?: V;
}

export interface ManagerState<V = ViewLike> {
	status: Status;
	daemonV?: number;
	sessions: SessionRow<V>[];
	selected?: number;
	message?: string;
	// A create waits or is in flight; the form is disabled until it resolves.
	creating: boolean;
	// Whether the window has focus: the selected session is only looked at
	// while it has.
	focused: boolean;
}

// The part of DaemonConnection the manager uses; it is also its cores' out.
export interface ConnectionLike extends CoreOut {
	close(): void;
	create(cwd: string, cmd: string, name: string, cols: number, rows: number): void;
	subscribe(sid: number): void;
	kill(sid: number): void;
	seen(sid: number): void;
}

export interface ManagerDeps<T extends ManagedTerm, V extends ViewLike> {
	readEndpoint: () => Promise<Endpoint>;
	// Starts the daemon; the rejection message is shown in the status line.
	startDaemon: () => Promise<void>;
	connect: (endpoint: Endpoint, handlers: ConnectionHandlers) => ConnectionLike;
	createTerminal: (cols: number, rows: number) => T;
	createView: (term: T, core: SessionCore) => V;
	notifier: Notifier;
}

interface Entry<T, V> {
	info: SessionInfo;
	core?: SessionCore;
	term?: T;
	view?: V;
	parsed?: IDisposable;
	// A subscribe was sent, or a create answered, on the current connection.
	subscribed: boolean;
	ro: boolean;
	// The reports count last published.
	shownReports: number;
	// Made from a create's replay that came before any list showing the
	// session; a list sent before the create must not remove it.
	unlisted: boolean;
}

const RETRY_MS = [1000, 2000, 4000];
const RETRY_STEADY_MS = 5000;
// DaemonConnection does not time out a daemon that accepts the socket but never answers hello.
const READY_TIMEOUT_MS = 5000;
const SELECTED_KEY = 'vaquita.selected';
const DEFAULT_SIZE: Size = { cols: 120, rows: 40 };

function newEntry<T, V>(info: SessionInfo): Entry<T, V> {
	return { info, subscribed: false, ro: false, shownReports: 0, unlisted: false };
}

export class SessionManager<T extends ManagedTerm = ManagedTerm, V extends ViewLike = ViewLike> {
	private state: ManagerState<V> = { status: 'connecting', sessions: [], creating: false, focused: true };
	private readonly subscribers = new Set<(s: ManagerState<V>) => void>();
	private conn: ConnectionLike | null = null;
	// conn once its handshake is done; requests go only through it.
	private readyConn: ConnectionLike | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private readyTimer: ReturnType<typeof setTimeout> | null = null;
	// Bumped per attempt and on stop(), so callbacks of an abandoned attempt are ignored.
	private attempt = 0;
	private failures = 0;
	// A start was attempted since the last ready; re-armed by the next ready.
	private startTried = false;
	private entries = new Map<number, Entry<T, V>>();
	private readonly requests = new RequestSlot();
	private lastSize = DEFAULT_SIZE;
	// Whether a session list has been applied yet, and the click that came before.
	private listed = false;
	private pendingClick?: Target;

	constructor(private readonly deps: ManagerDeps<T, V>) {}

	subscribe = (run: (s: ManagerState<V>) => void): (() => void) => {
		this.subscribers.add(run);
		run(this.state);
		return () => this.subscribers.delete(run);
	};

	start(): void {
		this.stop();
		void this.connect();
	}

	stop(): void {
		this.attempt++;
		this.clearTimers();
		this.conn?.close();
		this.conn = null;
		this.teardown();
	}

	select(sid: number): void {
		save(SELECTED_KEY, String(sid));
		// An exited session of this daemon run keeps its screen but was never subscribed.
		const e = this.entries.get(sid);
		if (e && !e.core && !e.subscribed && this.readyConn) {
			this.requests.enqueue(sid);
			this.pump();
		}
		this.publish({ selected: sid });
		this.seeSelected();
	}

	setFocused(focused: boolean): void {
		if (focused === this.state.focused) return;
		this.set({ focused });
		this.seeSelected();
	}

	// Selects the session a clicked notification was about, if it is still
	// there: a sid with another inc is another session, from a restarted
	// daemon. The missed summary has no target. A click that comes before the
	// first session list waits for it, the latest one only.
	openNotified(target?: Target): void {
		if (!target) return;
		if (!this.listed) {
			this.pendingClick = target;
			return;
		}
		if (this.entries.get(target.sid)?.info.inc === target.inc) this.select(target.sid);
	}

	// Refused without a connection and while another create waits or is in flight.
	create(cwd: string, cmd: string, name: string): void {
		if (!this.readyConn || !this.requests.requestCreate({ cwd, cmd, name })) return;
		this.pump();
		this.publish();
	}

	kill(sid: number): void {
		this.readyConn?.kill(sid);
	}

	// Shows a message from outside the manager in the status line.
	report(message: string): void {
		this.set({ message });
	}

	private set(patch: Partial<ManagerState<V>>): void {
		this.state = { ...this.state, ...patch, creating: this.requests.creating };
		for (const run of this.subscribers) run(this.state);
	}

	private publish(patch: Partial<ManagerState<V>> = {}): void {
		this.set({ ...patch, sessions: this.rows() });
	}

	private rows(): SessionRow<V>[] {
		return [...this.entries.values()]
			.sort((a, b) => a.info.sid - b.info.sid)
			.map((e) => {
				e.shownReports = e.core?.reports ?? 0;
				return { info: e.info, ro: e.ro, reports: e.shownReports, resets: e.core?.resets ?? 0, view: e.view };
			});
	}

	private clearTimers(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		if (this.readyTimer) clearTimeout(this.readyTimer);
		this.retryTimer = this.readyTimer = null;
	}

	private async connect(): Promise<void> {
		const id = ++this.attempt;
		// Keep the retry status visible between attempts rather than flickering to "connecting".
		if (this.state.status !== 'disconnected' && this.state.status !== 'not-running') {
			this.set({ status: 'connecting', message: undefined });
		}
		let endpoint: Endpoint;
		try {
			endpoint = await this.deps.readEndpoint();
		} catch (e) {
			if (id !== this.attempt) return;
			if (e instanceof NotRunningError) {
				// Keep the start failure's message on screen through the retries.
				if (this.startTried) this.retry('not-running', this.state.message);
				else await this.startDaemon(id);
			} else this.retry('disconnected', e instanceof Error ? e.message : String(e));
			return;
		}
		if (id !== this.attempt) return;
		// Every handler does nothing once this attempt has been abandoned.
		const current =<A extends unknown[]>(fn: (...a: A) => void) => (...a: A): void => {
			if (id === this.attempt) fn(...a);
		};
		let conn: ConnectionLike;
		try {
			conn = this.deps.connect(endpoint, {
				ready: current((list) => this.onReady(conn, list)),
				sessions: current((list) => this.onSessions(list)),
				replay: current((m) => this.onReplay(conn, m)),
				live: current((m) => this.onLive(m)),
				exit: current((m) => this.entries.get(m.sid)?.core?.exit(m)),
				error: current((m) => this.onError(m)),
				status: current((m) => this.onStatus(m)),
				notify: current((m) => this.onNotify(m)),
				frame: current((f) => this.entries.get(f.sid)?.core?.frame(f)),
				closed: current((reason) => this.onClosed(reason)),
			});
		} catch (e) {
			// e.g. a malformed url from a partial endpoint file; without this the loop would die.
			this.retry('disconnected', e instanceof Error ? e.message : String(e));
			return;
		}
		this.conn = conn;
		this.readyTimer = setTimeout(() => {
			this.attempt++;
			conn.close();
			this.teardown();
			this.retry('disconnected', 'no answer to hello');
		}, READY_TIMEOUT_MS);
	}

	private onReady(conn: ConnectionLike, list: SessionInfo[]): void {
		this.clearTimers();
		this.failures = 0;
		this.startTried = false;
		this.readyConn = conn;
		// A sid with another inc is another session, from a restarted daemon.
		const entries = new Map<number, Entry<T, V>>();
		for (const info of list) {
			const e = this.entries.get(info.sid);
			if (e?.info.inc !== info.inc) {
				entries.set(info.sid, newEntry(info));
				continue;
			}
			this.entries.delete(info.sid);
			e.info = info;
			e.core?.attach(conn);
			entries.set(info.sid, e);
		}
		for (const e of this.entries.values()) this.disposeEntry(e);
		this.entries = entries;

		const stored = load(SELECTED_KEY);
		const want = this.state.selected ?? (stored === null ? undefined : Number(stored));
		const selected = want !== undefined && entries.has(want) ? want : undefined;
		const running = list
			.filter((i) => i.state === STATE_RUNNING && i.sid !== selected)
			.map((i) => i.sid)
			.sort((a, b) => a - b);
		this.requests.reset(selected === undefined ? running : [selected, ...running]);
		this.pump();
		this.publish({ status: 'connected', selected, message: undefined });
		// The selected session may have become unread while no GUI was connected.
		this.seeSelected();
		this.listed = true;
		const click = this.pendingClick;
		this.pendingClick = undefined;
		this.openNotified(click);
	}

	private onSessions(list: SessionInfo[]): void {
		const listed = new Set<number>();
		for (const info of list) {
			listed.add(info.sid);
			const e = this.entries.get(info.sid);
			if (e) {
				e.info = info;
				e.unlisted = false;
				continue;
			}
			this.entries.set(info.sid, newEntry(info));
			if (info.state === STATE_RUNNING) this.requests.enqueue(info.sid);
		}
		for (const [sid, e] of this.entries) {
			if (listed.has(sid) || e.unlisted) continue;
			this.entries.delete(sid);
			this.disposeEntry(e);
		}
		this.pump();
		this.publish();
	}

	private onReplay(conn: ConnectionLike, m: Replay): void {
		const e = this.entries.get(m.sid);
		if (e?.core) {
			// The outstanding subscribe's replay, or a generation reset.
			e.core.replay(m);
			this.publish();
			return;
		}
		// A core is made when its subscribe is sent, so a replay for a sid
		// without one is the creator's subscription to the new session.
		const req = this.requests.createDone();
		if (!req) return;
		// The daemon's writer can pump the new subscription before it sends
		// the list that shows the session.
		const entry = e ?? this.addUnlisted(m, req);
		entry.subscribed = true;
		this.ensureCore(entry, conn).replay(m);
		this.pump();
		this.select(m.sid);
	}

	private addUnlisted(m: Replay, req: CreateRequest): Entry<T, V> {
		const e = newEntry<T, V>({
			sid: m.sid, inc: '', cwd: req.cwd, cmd: req.cmd, name: req.name,
			cols: m.cols, rows: m.rows, state: STATE_RUNNING, pid: 0, code: 0,
		});
		e.unlisted = true;
		this.entries.set(m.sid, e);
		return e;
	}

	private onLive(m: Live): void {
		const e = this.entries.get(m.sid);
		if (e?.core) {
			e.core.live(m);
			e.ro = m.ro;
		}
		if (this.requests.subscribeDone(m.sid)) this.pump();
		this.publish();
	}

	private onError(m: ErrorMessage): void {
		let message: string | undefined;
		if (m.code === CODE_ORPHANS) {
			message = `session ${m.sid} left processes behind: ${(m.pids ?? []).join(', ')}`;
		} else if (m.sid !== undefined && this.requests.subscribeDone(m.sid)) {
			// A record kept from an earlier daemon run is listed as exited and
			// has no screen; one of this run's exited sessions still has one.
			const record = m.code === CODE_NO_SESSION && this.entries.get(m.sid)?.info.state === STATE_EXITED;
			if (!record) message = `subscribe ${m.sid} failed (${m.code})`;
		} else if (m.sid === undefined && this.requests.createDone()) {
			message = `create failed (${m.code})`;
		} else {
			message = m.sid === undefined ? `daemon error (${m.code})` : `session ${m.sid}: daemon error (${m.code})`;
		}
		this.pump();
		this.publish(message === undefined ? {} : { message });
	}

	private onStatus(m: StatusMessage): void {
		const e = this.entries.get(m.sid);
		if (!e) return;
		const status = m.status ?? undefined;
		e.info = { ...e.info, status, unread: m.unread };
		this.publish();
		// Only what a seen changes is seen: an unread, or an input view, which
		// may be Codex's plan prompt that a seen releases (a seen on any other
		// input view changes nothing). What a seen changes is never unread and
		// never an input view, so the daemon's answer is not seen in turn,
		// unless it also carries a change that arrived meanwhile, which is seen
		// once like any other. A list may have shown this view already, so
		// whether it is new is not asked.
		if (m.sid === this.state.selected && (m.unread || status?.state === 'input')) this.seeSelected();
	}

	private onNotify(m: Notify): void {
		if (!shouldShow(m, this.state.selected, this.state.focused)) return;
		const info = m.sid === undefined ? undefined : this.entries.get(m.sid)?.info;
		this.deps.notifier.show(notificationFor(info, m));
	}

	// Tells the daemon the user is looking at the selected session. A row
	// with neither unread nor a status gets none: an older daemon, which
	// never sends either, answers a seen with a bad-request error.
	private seeSelected(): void {
		const sid = this.state.selected;
		const info = sid === undefined ? undefined : this.entries.get(sid)?.info;
		if (sid !== undefined && this.state.focused && (info?.unread || info?.status)) this.readyConn?.seen(sid);
	}

	// Sends the next request unless one is in flight. A queued sid that is
	// gone or already subscribed (a session this connection created) is
	// dropped, so a created session is never subscribed twice.
	private pump(): void {
		const conn = this.readyConn;
		if (!conn) return;
		const next = this.requests.take((sid) => this.entries.get(sid)?.subscribed === false);
		if (next?.kind === 'create') {
			const { cols, rows } = this.createSize();
			conn.create(next.cwd, next.cmd, next.name, cols, rows);
		} else if (next?.kind === 'subscribe') {
			const e = this.entries.get(next.sid)!;
			e.subscribed = true;
			this.ensureCore(e, conn);
			conn.subscribe(next.sid);
		}
	}

	// The selected view's proposal, else the last one: a new session starts
	// at the size the pane will show it at.
	private createSize(): Size {
		const sel = this.state.selected;
		this.lastSize = (sel === undefined ? undefined : this.entries.get(sel)?.view?.proposed()) ?? this.lastSize;
		return this.lastSize;
	}

	// A core from an earlier connection is kept, so the screen survives a
	// reconnect and the new subscription's replay is written over it.
	private ensureCore(e: Entry<T, V>, out: CoreOut): SessionCore {
		if (e.core) return e.core;
		const term = this.deps.createTerminal(e.info.cols, e.info.rows);
		const core = new SessionCore(term, e.info.sid, out);
		e.term = term;
		e.core = core;
		e.view = this.deps.createView(term, core);
		// Reports are counted while xterm parses, outside any handler here.
		e.parsed = term.onWriteParsed(() => {
			if (core.reports !== e.shownReports) this.publish();
		});
		return core;
	}

	private disposeEntry(e: Entry<T, V>): void {
		e.parsed?.dispose();
		e.view?.dispose();
		e.core?.dispose();
		e.term?.dispose();
	}

	// Everything tied to one connection, reset in this one place whenever it
	// ends: cores stop sending through it, and nothing queued or waiting is
	// sent on the next one.
	private teardown(): void {
		this.readyConn = null;
		this.requests.reset();
		for (const e of this.entries.values()) {
			e.core?.detach();
			e.subscribed = false;
		}
	}

	private onClosed(reason: CloseReason): void {
		this.clearTimers();
		this.teardown();
		if (reason.kind === 'version') {
			this.conn = null;
			this.set({ status: 'version-mismatch', daemonV: reason.daemonV, message: undefined });
			return;
		}
		// A daemon that is down can also show up as a connection that fails before ready.
		if (reason.kind === 'failed' && !this.startTried) {
			void this.startDaemon(this.attempt);
			return;
		}
		// Keep the start failure's message rather than replace it with the close code.
		if (reason.kind === 'failed' && this.state.status === 'not-running') this.retry('not-running', this.state.message);
		else this.retry('disconnected', reason.detail);
	}

	// One attempt per not-running episode; success re-runs the connect loop at once.
	private async startDaemon(id: number): Promise<void> {
		this.startTried = true;
		this.clearTimers();
		this.conn = null;
		this.set({ status: 'starting', message: undefined });
		try {
			await this.deps.startDaemon();
		} catch (e) {
			if (id === this.attempt) this.retry('not-running', e instanceof Error ? e.message : String(e));
			return;
		}
		if (id === this.attempt) void this.connect();
	}

	private retry(status: Status, message?: string): void {
		this.clearTimers();
		this.conn = null;
		const delay = RETRY_MS[this.failures] ?? RETRY_STEADY_MS;
		this.failures++;
		this.set({ status, message });
		this.retryTimer = setTimeout(() => void this.connect(), delay);
	}
}
