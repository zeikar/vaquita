import type { Notify, SessionInfo } from './protocol';

// The session a notification's click selects. A restarted daemon can give
// its sid to another session, so the inc goes with it. A type alias, not an
// interface: the notification plugin carries it in an extra typed
// Record<string, unknown>, which an interface without an index signature
// does not satisfy.
export type Target = { sid: number; inc: string };

export interface Notice {
	title: string;
	body: string;
	// Absent for the missed summary, whose click only brings the window up.
	target?: Target;
}

export interface Notifier {
	show(n: Notice): void;
}

// What the sidebar and notifications call a session; the daemon sends no title.
export const sessionTitle = (info: SessionInfo | undefined) => info?.name || info?.cmd || 'shell';

const SUFFIX = { done: 'done', error: 'failed', input: 'needs input', auth: 'needs login' };

// The notification m asks for. info is the row of m's session, which the
// daemon lists before it notifies about it; the missed summary has none.
export function notificationFor(info: SessionInfo | undefined, m: Notify): Notice {
	if (m.kind === 'missed') {
		const n = m.count ?? 0;
		return { title: 'vaquita', body: `${n} notification${n === 1 ? '' : 's'} while you were away` };
	}
	return {
		title: `${sessionTitle(info)} ${SUFFIX[m.kind]}`,
		body: m.msg ?? '',
		target: info && { sid: info.sid, inc: info.inc },
	};
}

// Checks what a clicked notification hands back, which has been through the OS.
export function isTarget(v: unknown): v is Target {
	return (
		typeof v === 'object' && v !== null && typeof (v as Target).sid === 'number' && typeof (v as Target).inc === 'string'
	);
}

// A notification about the session the user is looking at is not shown.
export function shouldShow(m: Notify, selected: number | undefined, focused: boolean): boolean {
	return !(focused && m.sid !== undefined && m.sid === selected);
}
