import type { IDisposable } from '@xterm/xterm';
import { DaemonLink, type ConnectionLike, type LinkDeps, type LinkState } from './daemon-link';
import { runningCount } from './daemon-update';
import { notificationFor, sessionTitle, shouldShow, type Notifier, type Target } from './notify';
import {
	CODE_BAD_PATH,
	CODE_CONVERSATION_LIVE,
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

export interface ManagerState<V = ViewLike> extends LinkState {
	sessions: SessionRow<V>[];
	// The registered repos; the last list the daemon sent, kept across reconnects.
	repos: string[];
	// Whether the daemon has sent a repo list this run: the empty one the
	// manager starts with is not a list the daemon sent.
	reposListed: boolean;
	selected?: number;
	// A create waits or is in flight; the form is disabled until it resolves.
	creating: boolean;
	// Whether the window has focus: the selected session is only looked at
	// while it has.
	focused: boolean;
	// What came of something the user did, or a failure the connection's
	// status does not explain. It goes after a while or when clicked, where
	// message lasts as long as the status it explains.
	report?: Report;
}

// Only a failure is shown red.
export type Tone = 'info' | 'error';

export interface Report {
	text: string;
	tone: Tone;
}

// A failure stays longer, for someone who looked away.
const REPORT_MS: Record<Tone, number> = { info: 8_000, error: 60_000 };

export interface ManagerDeps<T extends ManagedTerm, V extends ViewLike> extends LinkDeps {
	createTerminal: (cols: number, rows: number) => T;
	createView: (term: T, core: SessionCore, cwd: string) => V;
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

const SELECTED_KEY = 'vaquita.selected';
const DEFAULT_SIZE: Size = { cols: 120, rows: 40 };

function newEntry<T, V>(info: SessionInfo): Entry<T, V> {
	return { info, subscribed: false, ro: false, shownReports: 0, unlisted: false };
}

export class SessionManager<T extends ManagedTerm = ManagedTerm, V extends ViewLike = ViewLike> {
	private state: ManagerState<V> = { status: 'connecting', sessions: [], repos: [], reposListed: false, creating: false, focused: true };
	private readonly subscribers = new Set<(s: ManagerState<V>) => void>();
	private covered = false;
	// Requests go only through its ready connection.
	private readonly link: DaemonLink;
	private entries = new Map<number, Entry<T, V>>();
	private readonly requests = new RequestSlot();
	private lastSize = DEFAULT_SIZE;
	// Whether a session list has been applied yet, and the click that came before.
	private listed = false;
	private pendingClick?: Target;
	private reportTimer?: ReturnType<typeof setTimeout>;

	constructor(private readonly deps: ManagerDeps<T, V>) {
		this.link = new DaemonLink(deps, {
			state: () => this.state,
			set: (patch) => this.set(patch),
			handlers: (conn) => ({
				sessions: (list) => this.onSessions(list),
				replay: (m) => this.onReplay(conn(), m),
				live: (m) => this.onLive(m),
				exit: (m) => this.entries.get(m.sid)?.core?.exit(m),
				error: (m) => this.onError(m),
				status: (m) => this.onStatus(m),
				notify: (m) => this.onNotify(m),
				repos: (list) => this.set({ repos: list, reposListed: true }),
				frame: (f) => this.entries.get(f.sid)?.core?.frame(f),
			}),
			ready: (conn, list) => this.onReady(conn, list),
			teardown: () => this.teardown(),
			running: () => runningCount(Array.from(this.entries.values(), (e) => e.info)),
		});
	}

	subscribe = (run: (s: ManagerState<V>) => void): (() => void) => {
		this.subscribers.add(run);
		run(this.state);
		return () => this.subscribers.delete(run);
	};

	start(): void {
		this.link.start();
	}

	stop(): void {
		this.link.stop();
		clearTimeout(this.reportTimer);
	}

	select(sid: number): void {
		save(SELECTED_KEY, String(sid));
		// An exited session of this daemon run keeps its screen but was never subscribed.
		const e = this.entries.get(sid);
		if (e && !e.core && !e.subscribed && this.link.ready) {
			this.requests.enqueue(sid);
			this.pump();
		}
		this.publish({ selected: sid });
		this.seeSelected();
	}

	// A file tab covers the terminal: the selected session is then not looked
	// at, though the window has focus. Not state: nothing renders it.
	setCovered(covered: boolean): void {
		if (covered === this.covered) return;
		this.covered = covered;
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
	// Resolves true once the session exists, false if it was refused or failed.
	create(cwd: string, cmd: string, name: string): Promise<boolean> {
		if (!this.link.ready) return Promise.resolve(false);
		const { requests } = this;
		return new Promise((resolve) => {
			if (!requests.requestCreate({ cwd, cmd, name, done: resolve })) return resolve(false);
			this.pump();
			this.publish();
		});
	}

	kill(sid: number): void {
		this.link.ready?.kill(sid);
	}

	addRepo(path: string): void {
		this.link.ready?.reposAdd(path);
	}

	removeRepo(path: string): void {
		this.link.ready?.reposRemove(path);
	}

	// Replaces the daemon with the vaquitad this app ships, for the offer's
	// button. Its running sessions end; they stay listed and can be reopened.
	restartDaemon(): void {
		if (this.state.update) void this.link.restart(false);
	}

	// Starts a new session from a record of an earlier run, through the create
	// slot; refused like a create, and for a row that is not restorable.
	reopen(sid: number): void {
		const info = this.entries.get(sid)?.info;
		if (!this.link.ready || !info?.restorable) return;
		if (!this.requests.requestCreate({ cwd: info.cwd, cmd: info.cmd, name: info.name, reopen: sid })) return;
		this.pump();
		this.publish();
	}

	dismiss(sid: number): void {
		this.link.ready?.dismiss(sid);
	}

	// An empty name clears the session's, so it is titled by its agent again.
	rename(sid: number, name: string): void {
		this.link.ready?.rename(sid, name);
	}

	// Shows text in the status line for a while, in place of any earlier report.
	report(text: string, tone: Tone = 'error'): void {
		clearTimeout(this.reportTimer);
		this.reportTimer = setTimeout(() => this.dismissReport(), REPORT_MS[tone]);
		this.set({ report: { text, tone } });
	}

	dismissReport(): void {
		clearTimeout(this.reportTimer);
		this.set({ report: undefined });
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

	private onReady(conn: ConnectionLike, list: SessionInfo[]): void {
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
		const req = this.requests.createDone(true);
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
		// The sidebar shows no sids, so messages name a session by its title.
		const who = `session "${sessionTitle(m.sid === undefined ? undefined : this.entries.get(m.sid)?.info)}"`;
		const orphans = `${who} left processes behind: ${(m.pids ?? []).join(', ')}`;
		const reopening = this.requests.outstandingReopen;
		if (m.code === CODE_BAD_PATH) {
			// It answers a repo add, which holds no slot, so it frees no create.
			message = 'repo path must be an absolute path to an existing folder';
		} else if (reopening !== undefined && m.sid === reopening) {
			this.requests.createDone(false);
			if (m.code === CODE_ORPHANS) message = orphans;
			else if (m.code === CODE_CONVERSATION_LIVE) message = `${who}: its conversation is already open in another session`;
			else message = `reopen of ${who} failed (${m.code})`;
		} else if (m.code === CODE_ORPHANS) {
			message = orphans;
		} else if (m.sid !== undefined && this.requests.subscribeDone(m.sid)) {
			// A record kept from an earlier daemon run is listed as exited and
			// has no screen; one of this run's exited sessions still has one.
			const record = m.code === CODE_NO_SESSION && this.entries.get(m.sid)?.info.state === STATE_EXITED;
			if (!record) message = `subscribe to ${who} failed (${m.code})`;
		} else if (m.sid === undefined && this.requests.createDone(false)) {
			message = `create failed (${m.code})`;
		} else {
			message = m.sid === undefined ? `daemon error (${m.code})` : `${who}: daemon error (${m.code})`;
		}
		this.pump();
		this.publish();
		if (message !== undefined) this.report(message);
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
		if (!shouldShow(m, this.state.selected, this.state.focused && !this.covered)) return;
		const info = m.sid === undefined ? undefined : this.entries.get(m.sid)?.info;
		this.deps.notifier.show(notificationFor(info, m));
	}

	// Tells the daemon the user is looking at the selected session. A row
	// with neither unread nor a status gets none: an older daemon, which
	// never sends either, answers a seen with a bad-request error.
	private seeSelected(): void {
		const sid = this.state.selected;
		const info = sid === undefined ? undefined : this.entries.get(sid)?.info;
		if (sid !== undefined && this.state.focused && !this.covered && (info?.unread || info?.status)) this.link.ready?.seen(sid);
	}

	// Sends the next request unless one is in flight. A queued sid that is
	// gone or already subscribed (a session this connection created) is
	// dropped, so a created session is never subscribed twice.
	private pump(): void {
		const conn = this.link.ready;
		if (!conn) return;
		const next = this.requests.take((sid) => this.entries.get(sid)?.subscribed === false);
		if (next?.kind === 'create') {
			const { cols, rows } = this.createSize();
			if (next.reopen !== undefined) conn.reopen(next.reopen, cols, rows);
			else conn.create(next.cwd, next.cmd, next.name, cols, rows);
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
		e.view = this.deps.createView(term, core, e.info.cwd);
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

	// The sessions' part of the link's teardown, whenever a connection ends:
	// cores stop sending through it, and nothing queued or waiting is sent on
	// the next one.
	private teardown(): void {
		this.requests.reset();
		for (const e of this.entries.values()) {
			e.core?.detach();
			e.subscribed = false;
		}
	}
}
