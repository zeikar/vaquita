// node sessions.mjs <vaquita home> <home> <fake-agent.sh>: starts the demo's
// sessions in the daemon of that vaquita home. The rows show the names given
// here, ordered by repo and then by start.
import { readFileSync } from 'node:fs';

const [vh, home, fake] = process.argv.slice(2);
const src = (repo) => `${home}/src/${repo}`;
const agent = (state, msg = '') => `${fake} ${state} '${msg}'`;
const sessions = [
	{ cwd: src('api-server'), cmd: agent('claude-working'), name: 'Add rate limiting to login' },
	{ cwd: src('api-server'), cmd: agent('codex-approval', 'Approval requested: go test ./internal/retry/...'), name: 'Fix the flaky retry test' },
	// A plain shell, its demo commands run by the demo's .zshrc.
	{ cwd: src('vaquita'), cmd: '', name: '' },
	{ cwd: src('vaquita'), cmd: agent('codex-done', 'The release workflow now checks the daemon build.'), name: 'Review the release workflow' },
	{ cwd: src('web-app'), cmd: agent('claude-done', 'Added a theme toggle and dark styles to the settings page.'), name: 'Dark mode for settings' },
	{ cwd: src('web-app'), cmd: agent('claude-question', 'answer: Keep the old chart colours? (Yes, No)'), name: 'Redesign the usage chart' },
];

const ep = JSON.parse(readFileSync(`${vh}/endpoint.json`, 'utf8'));
const ws = new WebSocket(ep.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: 1, token: ep.token, client: 'gui' }));
ws.onmessage = async (ev) => {
	if (typeof ev.data !== 'string') return;
	const m = JSON.parse(ev.data);
	if (m.t === 'error') {
		console.error('daemon error:', ev.data);
		process.exitCode = 1;
	}
	if (m.t !== 'hello') return;
	for (const s of sessions) {
		ws.send(JSON.stringify({ t: 'create', ...s, cols: 100, rows: 40 }));
		// One at a time, so they start in this order.
		await sleep(500);
	}
	ws.close();
};
ws.onerror = () => {
	console.error('cannot reach the daemon');
	process.exitCode = 1;
};
