// A stand-in for the app's Rust commands, so the webview can be driven in a
// plain browser (Playwright) against a real daemon and the real disk. It keeps
// to what the UI needs, not to every rule of the Rust side (the open gate is a
// rough copy, and the sort is not natural), so it checks the UI, not the gate.
// node bridge.mjs <port> <vaquita home> <log file>; see run.sh.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [port, vh, logFile] = process.argv.slice(2);
const ORIGIN = 'http://localhost:1420';
const CAP = 2000;

const log = (...a) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);

const ioError = (e) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'no such file' : e.message);

const events = []; // {id, event, payload}
let nextEvent = 1;
const emit = (event, payload) => {
	events.push({ id: nextEvent++, event, payload });
	if (events.length > 500) events.shift();
	log('EMIT', event, payload);
};

// lexical -> {canonical, watcher}
const watched = new Map();
let lastGen = 0;

function setWatched(generation, folders) {
	if (generation < lastGen) {
		log('set_watched IGNORED (older generation)', generation, '<', lastGen);
		return [];
	}
	lastGen = generation;
	const refused = [];
	const want = new Map();
	for (const lex of folders) {
		try {
			want.set(lex, fs.realpathSync(lex));
		} catch (e) {
			refused.push({ path: lex, error: ioError(e) });
		}
	}
	for (const [lex, w] of watched) {
		if (!want.has(lex)) {
			w.watcher.close();
			watched.delete(lex);
		}
	}
	for (const [lex, canonical] of want) {
		if (watched.has(lex)) continue;
		try {
			const watcher = fs.watch(canonical, { recursive: false }, (_type, name) => {
				const out = [lex];
				// The watched folder a child event names: it was deleted or renamed.
				if (name) {
					const child = path.join(lex, String(name));
					if (watched.has(child) && !out.includes(child)) out.push(child);
				}
				emit('folder-changed', out);
			});
			watcher.on('error', (e) => log('watch error', lex, e.message));
			watched.set(lex, { canonical, watcher });
		} catch (e) {
			refused.push({ path: lex, error: ioError(e) });
		}
	}
	log('set_watched', { generation, folders, refused, now: [...watched.keys()] });
	return refused;
}

function readFolder(p) {
	const st = fs.statSync(p);
	if (!st.isDirectory()) throw 'not a folder';
	const canonical = fs.realpathSync(p);
	const entries = [];
	for (const d of fs.readdirSync(p, { withFileTypes: true })) {
		if (d.name === '.git') continue;
		entries.push({ name: d.name, dir: d.isDirectory() });
	}
	entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
	const total = entries.length;
	const kept = entries.slice(0, CAP);
	const r = spawnSync('git', ['-C', p, 'check-ignore', '-z', '--stdin'], { input: kept.map((e) => e.name + '\0').join(''), encoding: 'utf8' });
	const ign = new Set(r.status === 0 ? r.stdout.split('\0').filter(Boolean) : []);
	for (const e of kept) e.ignored = ign.has(e.name);
	return { entries: kept, total, canonical };
}

const IMAGES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const ext = (p) => path.extname(p).slice(1).toLowerCase();
const kindOf = (p) => (IMAGES.includes(ext(p)) ? 'image' : ['md', 'markdown'].includes(ext(p)) ? 'markdown' : 'text');

function stamp(p) {
	const st = fs.statSync(p);
	return { secs: Math.floor(st.mtimeMs / 1000), nanos: Math.round((st.mtimeMs % 1000) * 1e6), len: st.size };
}

function openPath(p) {
	const real = fs.realpathSync(p);
	const st = fs.statSync(real);
	if (st.isDirectory()) return { action: 'opened' };
	if (st.mode & 0o111) return { action: 'revealed', why: 'it is executable' };
	if (['txt', 'ts', 'js', 'md', 'png', 'json', 'env', ''].includes(ext(real)) || path.basename(real).startsWith('.')) return { action: 'view', path: real };
	return { action: 'opened' };
}

const unknown = new Set();
function run(cmd, args) {
	switch (cmd) {
		case 'endpoint':
			try {
				return JSON.parse(fs.readFileSync(path.join(vh, 'endpoint.json'), 'utf8'));
			} catch {
				throw 'not-running';
			}
		case 'read_folder':
			try {
				return readFolder(args.path);
			} catch (e) {
				throw typeof e === 'string' ? e : ioError(e);
			}
		case 'set_watched':
			return setWatched(args.generation, args.folders);
		case 'view_path': {
			const real = fs.realpathSync(args.path);
			return { path: real, kind: kindOf(real) };
		}
		case 'open_path':
			try {
				return openPath(args.path);
			} catch (e) {
				throw ioError(e);
			}
		case 'read_text': {
			const text = fs.readFileSync(args.path, 'utf8');
			return { text, stamp: stamp(args.path) };
		}
		case 'plugin:path|resolve_directory':
			return os.homedir();
		case 'plugin:window|is_focused':
			return true;
		case 'notification_permission':
			return true;
		case 'app_build':
		case 'check_app_update':
		case 'take_notification_click':
			return null;
		default:
			if (!unknown.has(cmd)) log('UNKNOWN/no-op command', cmd, args);
			unknown.add(cmd);
			log('noop', cmd, args);
			return null;
	}
}

http
	.createServer((req, res) => {
		res.setHeader('Access-Control-Allow-Origin', ORIGIN);
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'content-type');
		if (req.method === 'OPTIONS') return res.end();
		const url = new URL(req.url, 'http://x');
		if (url.pathname === '/events') {
			const since = Number(url.searchParams.get('since') ?? 0);
			res.setHeader('content-type', 'application/json');
			return res.end(JSON.stringify(events.filter((e) => e.id > since)));
		}
		if (url.pathname === '/emit') {
			emit(url.searchParams.get('event'), JSON.parse(url.searchParams.get('payload')));
			return res.end('ok');
		}
		if (url.pathname === '/file') {
			try {
				const p = url.searchParams.get('path');
				res.setHeader('content-type', ext(p) === 'png' ? 'image/png' : 'application/octet-stream');
				return res.end(fs.readFileSync(p));
			} catch {
				res.statusCode = 404;
				return res.end();
			}
		}
		if (url.pathname === '/invoke' && req.method === 'POST') {
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				const { cmd, args } = JSON.parse(body);
				const t0 = performance.now();
				res.setHeader('content-type', 'application/json');
				try {
					const value = run(cmd, args ?? {});
					if (cmd !== 'endpoint' && !cmd.startsWith('plugin:path')) log('invoke', cmd, cmd === 'read_folder' ? { path: args.path, ms: +(performance.now() - t0).toFixed(1), n: value.entries.length, total: value.total } : args);
					res.end(JSON.stringify({ ok: true, value: value ?? null }));
				} catch (e) {
					log('invoke-err', cmd, args, String(e));
					res.end(JSON.stringify({ ok: false, err: String(e) }));
				}
			});
			return;
		}
		res.statusCode = 404;
		res.end();
	})
	.listen(Number(port), '127.0.0.1', () => log('bridge listening', port));
