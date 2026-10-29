// node sessions.mjs <vaquita home> <repo>: starts a shell in the repo and one
// in /tmp (a session outside any repo) in that home's daemon.
import { readFileSync } from 'node:fs';
const [vh, repo] = process.argv.slice(2);
const ep = JSON.parse(readFileSync(`${vh}/endpoint.json`, 'utf8'));
const ws = new WebSocket(ep.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: 1, token: ep.token, client: 'gui' }));
ws.onmessage = async (ev) => {
  if (typeof ev.data !== 'string') return;
  const m = JSON.parse(ev.data);
  if (m.t === 'error') { console.error('daemon error:', ev.data); process.exitCode = 1; }
  if (m.t !== 'hello') return;
  for (const s of [{ cwd: repo, cmd: '', name: 'repo shell' }, { cwd: '/tmp', cmd: '', name: 'tmp shell' }]) {
    ws.send(JSON.stringify({ t: 'create', ...s, cols: 100, rows: 40 }));
    await sleep(500);
  }
  ws.close();
};
ws.onerror = () => { console.error('cannot reach the daemon'); process.exitCode = 1; };
