import type { CloseReason, ConnectionHandlers } from './connection';
import { NotRunningError, type Endpoint } from './endpoint';
import type { SessionInfo } from './protocol';
import type { TermLike } from './session-core';

export type Status = 'connecting' | 'connected' | 'not-running' | 'version-mismatch' | 'disconnected';

export interface ManagerState {
	status: Status;
	daemonV?: number;
	sessions: SessionInfo[];
	selected?: number;
	message?: string;
}

// The part of DaemonConnection the manager uses.
export interface ConnectionLike {
	close(): void;
}

export interface ManagerDeps {
	readEndpoint: () => Promise<Endpoint>;
	connect: (endpoint: Endpoint, handlers: ConnectionHandlers) => ConnectionLike;
	createTerminal: (cols: number, rows: number) => TermLike;
}

const RETRY_MS = [1000, 2000, 4000];
const RETRY_STEADY_MS = 5000;
// DaemonConnection does not time out a daemon that accepts the socket but never answers hello.
const READY_TIMEOUT_MS = 5000;

export class SessionManager {
	private state: ManagerState = { status: 'connecting', sessions: [] };
	private readonly subscribers = new Set<(s: ManagerState) => void>();
	private conn: ConnectionLike | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private readyTimer: ReturnType<typeof setTimeout> | null = null;
	// Bumped per attempt and on stop(), so callbacks of an abandoned attempt are ignored.
	private attempt = 0;
	private failures = 0;

	constructor(private readonly deps: ManagerDeps) {}

	subscribe = (run: (s: ManagerState) => void): (() => void) => {
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
	}

	private set(patch: Partial<ManagerState>): void {
		this.state = { ...this.state, ...patch };
		for (const run of this.subscribers) run(this.state);
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
			if (e instanceof NotRunningError) this.retry('not-running');
			else this.retry('disconnected', e instanceof Error ? e.message : String(e));
			return;
		}
		if (id !== this.attempt) return;
		const live = () => id === this.attempt;
		let conn: ConnectionLike;
		try {
			conn = this.deps.connect(endpoint, {
				ready: (list) => {
					if (!live()) return;
					this.clearTimers();
					this.failures = 0;
					this.set({ status: 'connected', sessions: list, message: undefined });
				},
				sessions: (list) => live() && this.set({ sessions: list }),
				replay: () => {},
				live: () => {},
				exit: () => {},
				error: () => {},
				frame: () => {},
				closed: (reason) => live() && this.onClosed(reason),
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
			this.retry('disconnected', 'no answer to hello');
		}, READY_TIMEOUT_MS);
	}

	private onClosed(reason: CloseReason): void {
		this.clearTimers();
		if (reason.kind === 'version') {
			this.conn = null;
			this.set({ status: 'version-mismatch', daemonV: reason.daemonV, message: undefined });
			return;
		}
		this.retry('disconnected', reason.detail);
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
