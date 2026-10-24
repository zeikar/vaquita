// node claude-config.mjs <demo home> <folder>: writes the demo home's
// ~/.claude.json for the real Claude Code. From your own config it copies
// only the flags and counters, which mark onboarding, notices and tips as
// seen; your account and projects stay out. It also trusts <folder>.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [home, folder] = process.argv.slice(2);
const own = JSON.parse(readFileSync(`${homedir()}/.claude.json`, 'utf8'));
const config = Object.fromEntries(
	Object.entries(own).filter(
		([k, v]) => typeof v === 'boolean' || typeof v === 'number' || k === 'lastOnboardingVersion' || k === 'lastReleaseNotesSeen',
	),
);
config.theme = 'dark';
config.projects = { [folder]: { hasTrustDialogAccepted: true } };
writeFileSync(`${home}/.claude.json`, JSON.stringify(config, null, 2));
