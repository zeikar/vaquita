import { describe, expect, it } from 'vitest';
import { ago, explicitResumeId, heldConversations, matchesTitle, resumeCommand, validId } from './conversations';
import type { Conversation } from './files';
import type { SessionInfo } from './protocol';

const idA = '1e384cb4-cf8e-4a61-b8be-9bbd9f093a8c';
const idB = '01a166f1-5cfb-7552-a0bd-cd891592ca64';

function info(over: Partial<SessionInfo>): SessionInfo {
	return { sid: 1, inc: 'x', cwd: '/tmp/repo', cmd: '', name: '', cols: 80, rows: 24, state: 'exited', pid: 10, code: -1, ...over };
}

describe('validId', () => {
	it('accepts a uuid of either case', () => {
		expect(validId(idA)).toBe(true);
		expect(validId(idA.toUpperCase())).toBe(true);
	});

	it('refuses a short, a non-hex and a quoted id', () => {
		expect(validId(idA.slice(0, 35))).toBe(false);
		expect(validId(idA.slice(0, 35) + 'g')).toBe(false);
		expect(validId(`'${idA}'`)).toBe(false);
		expect(validId('')).toBe(false);
	});
});

describe('resumeCommand', () => {
	it('resumes each agent by its own syntax', () => {
		expect(resumeCommand('claude', idA)).toBe(`claude --resume ${idA}`);
		expect(resumeCommand('codex', idA)).toBe(`codex resume ${idA}`);
	});

	it('throws on an id that is not uuid-shaped', () => {
		expect(() => resumeCommand('claude', `${idA}; rm -rf /tmp/repo`)).toThrow();
	});
});

describe('explicitResumeId', () => {
	it('reads the agent and the id, bare or single-quoted', () => {
		expect(explicitResumeId(`claude --resume ${idA}`)).toEqual({ agent: 'claude', id: idA });
		expect(explicitResumeId(`claude --resume '${idA}'`)).toEqual({ agent: 'claude', id: idA });
		expect(explicitResumeId(`codex resume ${idA}`)).toEqual({ agent: 'codex', id: idA });
		expect(explicitResumeId(`'codex' resume ${idA}`)).toEqual({ agent: 'codex', id: idA });
	});

	it('gives nothing without an id', () => {
		expect(explicitResumeId('claude')).toBeUndefined();
		expect(explicitResumeId('codex resume --last')).toBeUndefined();
		expect(explicitResumeId('claude --resume notanid')).toBeUndefined();
	});

	it('takes neither the other agent’s syntax nor an id inside a quoted prompt', () => {
		expect(explicitResumeId(`codex --resume ${idA}`)).toBeUndefined();
		expect(explicitResumeId(`claude resume ${idA}`)).toBeUndefined();
		expect(explicitResumeId(`claude 'say --resume ${idA}'`)).toBeUndefined();
	});
});

describe('heldConversations', () => {
	const held = (...list: SessionInfo[]) => heldConversations(list);

	it('holds a running session’s conversation', () => {
		expect(held(info({ sid: 3, state: 'running', cmd: 'claude', conversation: idA })).get(idA)).toEqual({ sid: 3, how: 'running' });
	});

	it('holds the id of a running session’s command when it has no conversation', () => {
		expect(held(info({ sid: 3, state: 'running', cmd: `claude --resume ${idA}` })).get(idA)).toEqual({ sid: 3, how: 'running' });
		expect(held(info({ sid: 4, state: 'running', cmd: `codex resume ${idB}` })).get(idB)).toEqual({ sid: 4, how: 'running' });
	});

	it('holds the command’s id of a running session only while its agent is the command’s', () => {
		const cmd = `codex resume ${idA}`;
		expect(held(info({ state: 'running', cmd, agent: 'claude' })).size).toBe(0);
		expect(held(info({ sid: 2, state: 'running', cmd, agent: 'codex' })).get(idA)).toEqual({ sid: 2, how: 'running' });
	});

	it('holds a restorable record’s conversation', () => {
		expect(held(info({ sid: 5, restorable: true, cmd: 'claude', conversation: idA })).get(idA)).toEqual({ sid: 5, how: 'record' });
	});

	it('holds a restorable Codex record’s typed id, not a Claude one’s', () => {
		expect(held(info({ sid: 5, restorable: true, cmd: `codex resume ${idA}` })).get(idA)).toEqual({ sid: 5, how: 'record' });
		expect(held(info({ restorable: true, cmd: `claude --resume ${idA}` })).size).toBe(0);
		expect(held(info({ restorable: true, cmd: `codex resume ${idA}`, agent: 'claude' })).size).toBe(0);
	});

	it('holds a session with orphans by its command’s id, whatever its agent', () => {
		expect(held(info({ sid: 6, orphans: [123], cmd: `claude --resume ${idA}` })).get(idA)).toEqual({ sid: 6, how: 'orphans' });
		expect(held(info({ sid: 7, orphans: [123], cmd: `codex resume ${idA}`, agent: 'claude' })).get(idA)).toEqual({ sid: 7, how: 'orphans' });
	});

	it('holds a record with orphans and an exited session of this run with orphans', () => {
		expect(held(info({ sid: 8, orphans: [123], cmd: 'claude', conversation: idA })).get(idA)).toEqual({ sid: 8, how: 'orphans' });
		expect(held(info({ sid: 9, orphans: [123], cols: 80, code: 0, cmd: 'codex', agent: 'codex', conversation: idB })).get(idB)).toEqual({ sid: 9, how: 'orphans' });
	});

	it('holds nothing for an exited session of this run without orphans', () => {
		expect(held(info({ cmd: 'claude', code: 0, conversation: idA })).size).toBe(0);
	});

	it('lets running beat orphans and orphans beat a record, in either order', () => {
		const running = info({ sid: 1, state: 'running', cmd: 'claude', conversation: idA });
		const orphans = info({ sid: 2, orphans: [123], cmd: 'claude', conversation: idA });
		const record = info({ sid: 3, restorable: true, cmd: 'claude', conversation: idA });
		expect(held(record, running).get(idA)).toEqual({ sid: 1, how: 'running' });
		expect(held(running, record).get(idA)).toEqual({ sid: 1, how: 'running' });
		expect(held(record, orphans).get(idA)).toEqual({ sid: 2, how: 'orphans' });
		expect(held(orphans, running).get(idA)).toEqual({ sid: 1, how: 'running' });
	});
});

describe('ago', () => {
	const now = Date.UTC(2026, 10, 1, 12, 0, 0);

	it('counts minutes, hours and days, then gives the UTC date', () => {
		expect(ago(now - 10_000, now)).toBe('now');
		expect(ago(now - 5 * 60_000, now)).toBe('5m');
		expect(ago(now - 3 * 3_600_000, now)).toBe('3h');
		expect(ago(now - 6 * 86_400_000, now)).toBe('6d');
		expect(ago(now - 40 * 86_400_000, now)).toBe('2026-09-22');
	});
});

describe('matchesTitle', () => {
	const c: Conversation = { agent: 'claude', id: idA, title: 'Fix the Build', cwd: '/tmp/repo', last_active: 0 };

	it('matches a substring whatever its case, and all on an empty query', () => {
		expect(matchesTitle(c, 'the build')).toBe(true);
		expect(matchesTitle(c, 'BUILD')).toBe(true);
		expect(matchesTitle(c, 'tests')).toBe(false);
		expect(matchesTitle(c, '')).toBe(true);
	});
});
