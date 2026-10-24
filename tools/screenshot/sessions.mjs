// node sessions.mjs <vaquita home> <home> <fake-agent.sh> agents|claude:
// starts one set of the demo's sessions in the daemon of that vaquita home.
import { readFileSync } from 'node:fs';

const [vh, home, fake, set] = process.argv.slice(2);
const src = (repo) => `${home}/src/${repo}`;
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const agent = (state, msg = '') => `${quote(fake)} ${state} ${quote(msg)}`;
const sets = {
	// Rows show these names, by repo and then in this order.
	agents: [
		{ cwd: src('api-server'), cmd: agent('claude-working'), name: 'Add rate limiting to login' },
		{ cwd: src('api-server'), cmd: agent('codex-approval', 'Approval requested: go test ./internal/retry/...'), name: 'Fix the flaky retry test' },
		{ cwd: src('vaquita'), cmd: '', name: '' },
		{ cwd: src('vaquita'), cmd: agent('codex-done', 'The release workflow now checks the daemon build.'), name: 'Review the release workflow' },
		{ cwd: src('web-app'), cmd: agent('claude-done', 'Added a theme toggle and dark styles to the settings page.'), name: 'Dark mode for settings' },
		{ cwd: src('web-app'), cmd: agent('claude-question', 'answer: Keep the old chart colours? (Yes, No)'), name: 'Redesign the usage chart' },
	],
	// The real Claude Code, one short turn; its row takes the title it gives
	// the conversation.
	claude: [
		{
			cwd: src('vaquita'),
			cmd: `claude --model sonnet ${quote('Read README.md and docs/daemon.md, then explain in three short bullets how vaquita keeps agent sessions alive when the app restarts.')}`,
			name: '',
		},
	],
};
const sessions = sets[set];
if (!sessions) {
	console.error(`unknown set ${set}`);
	process.exit(2);
}

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
