import { describe, expect, it } from 'vitest';
import { agentIcon, agentKind } from './agent';

describe('agentKind', () => {
	it('prefers the recorded agent over cmd', () => {
		expect(agentKind({ agent: 'codex', cmd: 'claude' })).toBe('codex');
		expect(agentKind({ agent: 'claude', cmd: '' })).toBe('claude');
	});
	it('reads the first word of cmd, bare or single-quoted', () => {
		expect(agentKind({ cmd: "'claude' --model x" })).toBe('claude');
		expect(agentKind({ cmd: 'codex resume --last' })).toBe('codex');
		expect(agentKind({ cmd: '  claude' })).toBe('claude');
	});
	it('ignores an unknown recorded agent', () => {
		expect(agentKind({ agent: 'other', cmd: 'codex' })).toBe('codex');
	});
	it('tells a plain shell from another program', () => {
		expect(agentKind({ cmd: '' })).toBe('shell');
		expect(agentKind({ cmd: 'vim' })).toBe('other');
	});
});

describe('agentIcon', () => {
	it('maps each kind to its icon', () => {
		expect(agentIcon('claude')).toBe('claude');
		expect(agentIcon('codex')).toBe('openai');
		expect(agentIcon('shell')).toBe('command-line');
		expect(agentIcon('other')).toBe('cube');
	});
});
