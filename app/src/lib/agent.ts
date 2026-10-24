import type { SessionInfo } from './protocol';
import type { IconName } from './icons';

export type AgentKind = 'claude' | 'codex' | 'shell' | 'other';

// The recorded agent wins, then the first word of cmd, bare or single-quoted,
// as the daemon's session.RestoreCommand reads it.
export function agentKind(info: Pick<SessionInfo, 'agent' | 'cmd'>): AgentKind {
	if (info.agent === 'claude' || info.agent === 'codex') return info.agent;
	const word = info.cmd.trim().split(/\s/)[0];
	switch (word) {
		case 'claude':
		case "'claude'":
			return 'claude';
		case 'codex':
		case "'codex'":
			return 'codex';
		case '':
			return 'shell';
		default:
			return 'other';
	}
}

export function agentIcon(kind: AgentKind): IconName {
	switch (kind) {
		case 'claude':
			return 'claude';
		case 'codex':
			return 'openai';
		case 'shell':
			return 'command-line';
		case 'other':
			return 'cube';
	}
}
