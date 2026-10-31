import type { Conversation } from './files';
import type { SessionInfo } from './protocol';

type Agent = 'claude' | 'codex';

// The daemon's convid.ValidID: UUID-shaped, 8-4-4-4-12 hex digits of either case.
export function validId(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// The id goes onto a shell command line unquoted, so only a valid one is accepted.
export function resumeCommand(agent: Agent, id: string): string {
	if (!validId(id)) throw new Error(`not a conversation id: ${id}`);
	return agent === 'claude' ? `claude --resume ${id}` : `codex resume ${id}`;
}

// w without one pair of single quotes around it, or '' if it has any other
// quote: a field of a longer quoted word is not a word. The daemon's unquoteWord.
function unquoteWord(w: string): string {
	if (w.length >= 2 && w.startsWith("'") && w.endsWith("'")) w = w.slice(1, -1);
	return w.includes("'") ? '' : w;
}

// The agent and id of a typed `claude --resume <id>` or `codex resume <id>`,
// each word bare or single-quoted, as the daemon's explicitResumeID reads
// Codex's. Only that shape counts, so an id in a quoted prompt is never taken.
export function explicitResumeId(cmd: string): { agent: Agent; id: string } | undefined {
	const w = cmd.trim().split(/\s+/);
	if (w.length < 3) return undefined;
	const agent = unquoteWord(w[0]);
	const sub = unquoteWord(w[1]);
	const id = unquoteWord(w[2]);
	if (!validId(id)) return undefined;
	if ((agent === 'claude' && sub === '--resume') || (agent === 'codex' && sub === 'resume')) return { agent, id };
	return undefined;
}

// How a session holds a conversation: running it, as a record Reopen resumes
// it from, or with processes of it left that may still have it open.
export type Held = { sid: number; how: 'running' | 'record' | 'orphans' };

const rank = { running: 0, orphans: 1, record: 2 } as const;

function heldHow(info: SessionInfo): Held['how'] | undefined {
	// A session whose agent quit back to its shell still holds the conversation:
	// the daemon keeps the id in its record until another agent reports, and
	// refuses to reopen a record with that id while the session runs.
	if (info.state === 'running') return 'running';
	// A record after a crash, or an exited session whose agent outlived the
	// kill: the agent may still have the conversation open, and a create, unlike
	// a reopen, does not check for orphans.
	if (info.orphans?.length) return 'orphans';
	if (info.restorable) return 'record';
	return undefined;
}

// The id a session's typed command names, when the daemon would resume it.
// A session with orphans is only ever blocked by, never reopened, so its id
// stands whatever agent reported last. Otherwise cmd is the launch command and
// agent the last reporter; the daemon's RestoreCommand resumes by the recorded
// agent and drops the typed command, so a `codex resume <id>` record that
// claude reported in reopens as `claude --continue`. And RestoreCommand takes
// a typed id for Codex only: a Claude record without a recorded id reopens as
// `claude --continue`, which may be another conversation.
function typedId(info: SessionInfo, how: Held['how']): string | undefined {
	const typed = explicitResumeId(info.cmd);
	if (!typed) return undefined;
	if (how === 'orphans') return typed.id;
	if (info.agent && info.agent !== typed.agent) return undefined;
	if (how === 'record' && typed.agent !== 'codex') return undefined;
	return typed.id;
}

// The conversations the sessions hold, by id; for one id, a running session
// beats one with orphans, which beats a record.
export function heldConversations(sessions: SessionInfo[]): Map<string, Held> {
	const held = new Map<string, Held>();
	for (const info of sessions) {
		const how = heldHow(info);
		if (!how) continue;
		const id = info.conversation || typedId(info, how);
		if (!id) continue;
		const prev = held.get(id);
		if (!prev || rank[how] < rank[prev.how]) held.set(id, { sid: info.sid, how });
	}
	return held;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// How long ago ms was; past 30 days the UTC date, so it reads the same in any locale.
export function ago(ms: number, now: number): string {
	const d = now - ms;
	if (d < MINUTE) return 'now';
	if (d < HOUR) return `${Math.floor(d / MINUTE)}m`;
	if (d < DAY) return `${Math.floor(d / HOUR)}h`;
	if (d < 30 * DAY) return `${Math.floor(d / DAY)}d`;
	return new Date(ms).toISOString().slice(0, 10);
}

export function matchesTitle(c: Conversation, query: string): boolean {
	return c.title.toLowerCase().includes(query.toLowerCase());
}
