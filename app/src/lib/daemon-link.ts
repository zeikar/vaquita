import type { CloseReason, ConnectionHandlers } from './connection';
import { updateAction, type DaemonUpdate } from './daemon-update';
import { NotRunningError, type Endpoint } from './endpoint';
import { CODE_BUSY, type ErrorMessage, type SessionInfo } from './protocol';
import type { CoreOut } from './session-core';

export type Status =
	| 'connecting'
	| 'starting'
	| 'restarting'
	| 'connected'
	| 'not-running'
	| 'version-mismatch'
	| 'disconnected';

// The part of the manager's state the link sets: the connection's status
// line and the restart offer.
export interface LinkState {
	status: Status;
	daemonV?: number;
	message?: string;
	// Set while the daemon is not the vaquitad this app ships and replacing
	// it, which ends its running sessions, is left to the user.
	update?: DaemonUpdate;
}

// The part of DaemonConnection the manager uses; it is also its cores' out.
export interface ConnectionLike extends CoreOut {
	close(): void;
	create(cwd: string, cmd: string, name: string, cols: number, rows: number): void;
	subscribe(sid: number): void;
	kill(sid: number): void;
	seen(sid: number): void;
	reposAdd(path: string): void;
	reposRemove(path: string): void;
	reopen(sid: number, cols: number, rows: number): void;
	dismiss(sid: number): void;
	shutdown(idle: boolean): void;
}

export interface LinkDeps {
	readEndpoint: () => Promise<Endpoint>;
	// Starts the daemon; the rejection message is shown in the status line.
	startDaemon: () => Promise<void>;
	// The build of the vaquitad this app ships; null when the app does not
	// manage the daemon, as in a dev run.
	appBuild: () => Promise<string | null>;
	// Rejects when the app could not start a daemon of its own; asked before
	// one is stopped.
	checkRestart: () => Promise<void>;
	// Stops the daemon at endpoint, by a signal or, without one, by waiting
	// for it to exit after it agreed to a shutdown request, and starts the
	// app's own, resolving once it has written its endpoint file.
	restartDaemon: (endpoint: Endpoint, signal: boolean) => Promise<void>;
	connect: (endpoint: Endpoint, handlers: ConnectionHandlers) => ConnectionLike;
}

// A connection's messages about sessions; the link takes the handshake and
// the close.
export type SessionHandlers = Omit<ConnectionHandlers, 'ready' | 'closed'>;

// What the link needs of the manager.
export interface LinkHost {
	state(): LinkState;
	set(patch: Partial<LinkState>): void;
	// The handlers of conn's session messages; conn is set before any runs.
	handlers(conn: () => ConnectionLike): SessionHandlers;
	// conn has finished its handshake with the daemon's list.
	ready(conn: ConnectionLike, list: SessionInfo[]): void;
	// The connection has ended; its part of the teardown.
	teardown(): void;
	// The sessions a daemon restart would end.
	running(): number;
}

const RETRY_MS = [1000, 2000, 4000];
const RETRY_STEADY_MS = 5000;
// DaemonConnection does not time out a daemon that accepts the socket but never answers hello.
const READY_TIMEOUT_MS = 5000;
// A daemon that agrees to a shutdown closes the connection at once.
const SHUTDOWN_TIMEOUT_MS = 5000;

// Keeps the manager connected to a daemon: it connects and retries, starts
// the daemon when none runs, and replaces one that is not the vaquitad this
// app ships.
export class DaemonLink {
	private conn: ConnectionLike | null = null;
	// conn once its handshake is done; requests go only through it.
	private readyConn: ConnectionLike | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private readyTimer: ReturnType<typeof setTimeout> | null = null;
	private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
	// Bumped per attempt and on stop(), so callbacks of an abandoned attempt are ignored.
	private attempt = 0;
	private failures = 0;
	// A start was attempted since the last ready; re-armed by the next ready.
	private startTried = false;
	// Asked once, before the first connection; undefined until then.
	private appBuild?: string | null;
	// There is one automatic restart per app run at most, so a restart that
	// brings back the same build never loops.
	private autoRestarted = false;
	// How the last restart ended, its error if it failed, for the next ready
	// to tell the user when the daemon is still not the app's.
	private restarted?: { error?: string };
	// The ready connection's daemon, as its endpoint and hello described it.
	private daemon?: { endpoint: Endpoint; build?: string };
	// The daemon a shutdown request went to: its closing the connection is
	// its agreement.
	private shuttingDown?: Endpoint;

	constructor(
		private readonly deps: LinkDeps,
		private readonly host: LinkHost,
	) {}

	get ready(): ConnectionLike | null {
		return this.readyConn;
	}

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

	private get state(): LinkState {
		return this.host.state();
	}

	private set(patch: Partial<LinkState>): void {
		this.host.set(patch);
	}

	private clearTimers(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		if (this.readyTimer) clearTimeout(this.readyTimer);
		if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
		this.retryTimer = this.readyTimer = this.shutdownTimer = null;
	}

	private async connect(): Promise<void> {
		const id = ++this.attempt;
		// Keep the retry status visible between attempts rather than flickering to "connecting".
		if (this.state.status !== 'disconnected' && this.state.status !== 'not-running') {
			this.set({ status: 'connecting', message: undefined });
		}
		if (this.appBuild === undefined) {
			this.appBuild = await this.deps.appBuild().catch((e) => {
				// The app's command cannot fail; without its answer the daemon is left as it is.
				console.warn(`app build unknown: ${e instanceof Error ? e.message : String(e)}`);
				return null;
			});
			if (id !== this.attempt) return;
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
		const on = this.host.handlers(() => conn);
		try {
			conn = this.deps.connect(endpoint, {
				ready: current((list, build) => this.onReady(conn, endpoint, list, build)),
				sessions: current(on.sessions),
				replay: current(on.replay),
				live: current(on.live),
				exit: current(on.exit),
				error: current((m) => this.onError(m, on.error)),
				status: current(on.status),
				notify: current(on.notify),
				repos: current(on.repos),
				frame: current(on.frame),
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

	private onReady(conn: ConnectionLike, endpoint: Endpoint, list: SessionInfo[], build: string | undefined): void {
		this.clearTimers();
		this.failures = 0;
		this.startTried = false;
		this.readyConn = conn;
		this.daemon = { endpoint, build };
		this.host.ready(conn, list);
		this.checkDaemon(build);
	}

	// Acts on whether the daemon that answered, of the given build, is the
	// vaquitad this app ships.
	private checkDaemon(build: string | undefined): void {
		const app = this.appBuild ?? null;
		const running = this.host.running();
		switch (updateAction(app, build, running, this.autoRestarted)) {
			case 'none':
				this.restarted = undefined;
				if (this.state.update) this.set({ update: undefined });
				return;
			case 'restart-now':
				this.autoRestarted = true;
				void this.restart(true);
				return;
			case 'offer':
				this.offer();
		}
	}

	// Shows the restart offer for the ready connection's daemon, which is not
	// the app's, with what the last restart left to say.
	private offer(): void {
		const r = this.restarted;
		const note = r && (r.error === undefined ? 'still running after a restart' : `restart failed: ${r.error}`);
		this.set({ status: 'connected', update: { daemon: this.daemon?.build, app: this.appBuild!, ...(note && { note }) } });
	}

	// Nothing is stopped before the app is known to be able to start its own
	// daemon. A daemon with a build is asked to stop over the connection,
	// which with idle it refuses while a session runs or starts; one older
	// than builds knows no such request and is signalled by its pid.
	async restart(idle: boolean): Promise<void> {
		const conn = this.readyConn;
		const daemon = this.daemon;
		if (!conn || !daemon) return;
		this.restarted = undefined;
		this.set({ status: 'restarting', message: undefined, update: undefined });
		try {
			await this.deps.checkRestart();
		} catch (e) {
			if (conn !== this.readyConn) return;
			this.restarted = { error: e instanceof Error ? e.message : String(e) };
			this.offer();
			return;
		}
		if (conn !== this.readyConn) return;
		if (daemon.build === undefined) {
			this.stop();
			void this.startOwn(daemon.endpoint, true);
			return;
		}
		this.shuttingDown = daemon.endpoint;
		conn.shutdown(idle);
		// A daemon that neither answers nor closes is left running as it is,
		// and the user can try again.
		this.shutdownTimer = setTimeout(() => {
			this.shutdownTimer = null;
			this.shuttingDown = undefined;
			this.restarted = { error: 'no answer to the shutdown request' };
			this.offer();
		}, SHUTDOWN_TIMEOUT_MS);
	}

	// Waits for the daemon at endpoint to be gone, signalling it first with
	// signal, and starts the app's own. Nothing reconnects meanwhile, so that
	// no other start races this one; connecting resumes once it is done.
	private async startOwn(endpoint: Endpoint, signal: boolean): Promise<void> {
		const id = this.attempt;
		this.set({ status: 'restarting' });
		try {
			await this.deps.restartDaemon(endpoint, signal);
		} catch (e) {
			if (id !== this.attempt) return;
			const error = e instanceof Error ? e.message : String(e);
			this.restarted = { error };
			this.retry('disconnected', `daemon restart failed: ${error}`);
			return;
		}
		if (id !== this.attempt) return;
		this.restarted = {};
		void this.connect();
	}

	// The daemon's refusal of an idle shutdown is the link's; every other
	// error goes to the sessions' handler.
	private onError(m: ErrorMessage, sessions: (m: ErrorMessage) => void): void {
		if (m.code === CODE_BUSY && this.shuttingDown) {
			// A session runs or is starting, so the idle shutdown was refused.
			this.shuttingDown = undefined;
			this.clearTimers();
			this.offer();
			return;
		}
		sessions(m);
	}

	// Everything tied to one connection is reset in this one place whenever
	// it ends; the host resets its sessions' part.
	private teardown(): void {
		this.readyConn = null;
		this.daemon = undefined;
		this.shuttingDown = undefined;
		this.host.teardown();
	}

	private onClosed(reason: CloseReason): void {
		const stopped = this.shuttingDown;
		this.clearTimers();
		this.teardown();
		if (stopped) {
			this.conn = null;
			void this.startOwn(stopped, false);
			return;
		}
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
