// The one daemon request a connection has in flight (a subscribe or a
// create), the create waiting behind it, and the sids to subscribe after.

export interface CreateRequest {
	cwd: string;
	cmd: string;
	name: string;
	// The record's sid when the create is a reopen.
	reopen?: number;
}

export type Request = { kind: 'subscribe'; sid: number } | ({ kind: 'create' } & CreateRequest);

export class RequestSlot {
	private outstanding: Request | null = null;
	private pendingCreate?: CreateRequest;
	private queue: number[] = [];

	// The form stays disabled while this holds, so whatever ends the create
	// (its replay, an error, a lost connection) enables it again.
	get creating(): boolean {
		return this.pendingCreate !== undefined || this.outstanding?.kind === 'create';
	}

	// The record being reopened by the create in flight.
	get outstandingReopen(): number | undefined {
		return this.outstanding?.kind === 'create' ? this.outstanding.reopen : undefined;
	}

	// Drops the previous connection's requests; queue is the new one's.
	reset(queue: number[] = []): void {
		this.outstanding = null;
		this.pendingCreate = undefined;
		this.queue = queue;
	}

	enqueue(sid: number): void {
		this.queue.push(sid);
	}

	// Refused while another create waits or is in flight.
	requestCreate(req: CreateRequest): boolean {
		if (this.creating) return false;
		this.pendingCreate = req;
		return true;
	}

	// The request to send now, which becomes the outstanding one; null while
	// one is in flight. A waiting create goes first, then the next queued sid
	// that wanted() still accepts; the others are dropped.
	take(wanted: (sid: number) => boolean): Request | null {
		if (this.outstanding) return null;
		if (this.pendingCreate) {
			this.outstanding = { kind: 'create', ...this.pendingCreate };
			this.pendingCreate = undefined;
			return this.outstanding;
		}
		for (let sid = this.queue.shift(); sid !== undefined; sid = this.queue.shift()) {
			if (wanted(sid)) return (this.outstanding = { kind: 'subscribe', sid });
		}
		return null;
	}

	// Frees the slot if it holds sid's subscribe.
	subscribeDone(sid: number): boolean {
		if (this.outstanding?.kind !== 'subscribe' || this.outstanding.sid !== sid) return false;
		this.outstanding = null;
		return true;
	}

	// Frees the slot if it holds a create, and returns that create.
	createDone(): CreateRequest | undefined {
		const o = this.outstanding;
		if (o?.kind !== 'create') return undefined;
		this.outstanding = null;
		return o;
	}
}
