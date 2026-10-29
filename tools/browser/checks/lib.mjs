// Helpers the checks share. A check runs as `node checks/<name>.mjs <dir>`
// against what `run.sh up <dir>` started; check.sh does both.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));

// WebKit by default, as the app runs in WKWebView; BROWSER=chromium for a
// second opinion.
export async function openApp(viewport) {
	const name = process.env.BROWSER ?? 'webkit';
	const type = { webkit, chromium }[name];
	if (!type) throw new Error(`BROWSER=${name}: use webkit or chromium`);
	const browser = await type.launch();
	const page = await browser.newPage({ viewport });
	page.on('pageerror', (e) => console.log('pageerror', e.message));
	await page.addInitScript({ path: path.join(here, '..', 'init.js') });
	await page.goto('http://localhost:1420');
	console.log(`browser: ${name} ${browser.version()}`);
	return { browser, page };
}

// bridge.log, one line per command or event; offset() then since(offset)
// gives what happened in between, without the timestamps.
export function bridgeLog(dir) {
	const file = path.join(dir, 'bridge.log');
	return {
		offset: () => fs.statSync(file).size,
		since: (off) =>
			fs.readFileSync(file).subarray(off).toString().split('\n').filter(Boolean).map((l) => l.replace(/^\S+ /, '')),
	};
}

// Calls read until ok(value) holds or timeout ms pass; returns the last value
// either way, so a step can report what it saw.
export async function until(read, ok, timeout = 5000) {
	const end = Date.now() + timeout;
	for (;;) {
		const v = await read();
		if (ok(v) || Date.now() >= end) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Records PASS/FAIL lines; a step that throws fails and the next still runs.
export function recorder(shots) {
	fs.mkdirSync(shots, { recursive: true });
	const results = [];
	const say = (name, ok, evidence) => {
		results.push([name, ok]);
		console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
	};
	return {
		say,
		async step(name, fn) {
			try {
				await fn();
			} catch (e) {
				say(name, false, `threw ${e?.stack?.split('\n').slice(0, 3).join(' | ') ?? e}`);
			}
		},
		// A page or a locator.
		shot: (target, name) => target.screenshot({ path: path.join(shots, `${name}.png`) }),
		// The number of failures, for the exit code.
		finish() {
			console.log('\nSUMMARY');
			for (const [name, ok] of results) console.log(ok ? 'PASS' : 'FAIL', name);
			return results.filter(([, ok]) => !ok).length;
		},
	};
}
