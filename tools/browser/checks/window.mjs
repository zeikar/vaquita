// What the Rust side sends the page, fired with __vqFire as it would: a drop
// on the content typed into the terminal, a notification click raising the
// window, the update notice and Update with and without unsaved edits, and
// the window's close request asking first.
// node checks/window.mjs <dir>, after run.sh up <dir>; see check.sh.
import path from 'node:path';
import { bridgeLog, openApp, recorder, sleep, until } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node checks/window.mjs <dir>');
	process.exit(2);
}
const log = bridgeLog(dir);
const { say, step, shot, finish } = recorder(path.join(dir, 'shots'));

const { browser, page } = await openApp({ width: 1440, height: 900 });
// Without WebGL2 xterm draws with its DOM renderer, whose rows can be read.
await page.addInitScript(() => {
	const get = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
		return type === 'webgl2' ? null : get.call(this, type, ...rest);
	};
});
await page.reload();

const sidebar = page.locator('main > aside:not(.files)');
const panel = page.locator('aside.files');
const notice = page.locator('.notices .notice', { hasText: '9.9.9' });
const updateBtn = notice.locator('button.primary');
const shown = () => page.evaluate(() => document.querySelector('.tabs .tab.active .label')?.textContent ?? null);
const terminalFocused = () => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea'));
// The last row of the shown terminal with text on it, nbsp as spaces.
const lastRow = () =>
	page.evaluate(() => {
		const term = [...document.querySelectorAll('.term')].find((t) => t.offsetParent !== null);
		const rows = [...(term?.querySelectorAll('.xterm-rows > div') ?? [])].map((r) => r.textContent.replace(/ /g, ' ').trimEnd());
		return rows.filter(Boolean).pop() ?? '';
	});

// A question is the dialog plugin's message command, which init.js notes in
// __vqLog before it is sent, routed or not: the messages asked since the
// log was n long.
const logLength = () => page.evaluate(() => window.__vqLog.length);
const asked = (n) => page.evaluate((n) => window.__vqLog.slice(n).filter((e) => e.cmd === 'plugin:dialog|message').map((e) => e.args.message), n);
// Commands no route answers reach the bridge, which logs them as noop: how
// many of each since a bridge.log offset.
const NOOP = { destroy: 'plugin:window|destroy', show: 'plugin:window|show', setFocus: 'plugin:window|set_focus', install: 'install_app_update' };
const sent = (off) => {
	const lines = log.since(off);
	return Object.fromEntries(Object.entries(NOOP).map(([k, cmd]) => [k, lines.filter((l) => l.startsWith(`noop ${cmd} `)).length]));
};

const fulfil = (route, value) =>
	route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' }, body: JSON.stringify({ ok: true, value }) });
// The update feed, which the bridge has none of, offers 9.9.9.
const offer = async (route) => {
	const { cmd } = JSON.parse(route.request().postData() ?? '{}');
	return cmd === 'check_app_update' ? fulfil(route, { version: '9.9.9' }) : route.fallback();
};
// The question answered with its ok label, as the native dialog would.
const accept = async (route) => {
	const { cmd } = JSON.parse(route.request().postData() ?? '{}');
	return cmd === 'plugin:dialog|message' ? fulfil(route, 'Close') : route.fallback();
};
const INVOKE = 'http://127.0.0.1:14999/invoke';

// A character typed into the shown editor, once it has loaded, at the end of
// its text; then the text it shows.
const edit = async (ch) => {
	const lines = page.locator('.file .text:not([hidden]) .monaco-editor .view-lines');
	await lines.waitFor({ timeout: 15000 });
	await lines.click();
	await page.keyboard.type(ch);
	await sleep(200);
	return (await lines.innerText()).replace(/ /g, ' ');
};

await sidebar.locator('li > button.row', { hasText: 'repo shell' }).waitFor({ timeout: 10000 });
await sidebar.locator('li > button.row', { hasText: 'repo shell' }).click();
await until(terminalFocused, Boolean);

await step('drop on the content', async () => {
	if ((await panel.count()) === 0) await page.locator('footer .files-toggle').click();
	await panel.locator('.tree button.row', { hasText: 'README.md' }).dblclick();
	await until(shown, (l) => l === 'README.md');
	// The drop's position arrives in physical pixels, as Tauri sends it.
	await page.evaluate(() => {
		const b = document.querySelector('section.content').getBoundingClientRect();
		const r = window.devicePixelRatio;
		window.__vqFire('tauri://drag-drop', { paths: ['/tmp/a b.txt', '/tmp/c'], position: { x: (b.left + b.width / 2) * r, y: (b.top + b.height / 2) * r } });
	});
	const a = await until(shown, (l) => l === 'repo shell', 3000);
	const row = await until(lastRow, (r) => r.endsWith(`'/tmp/a b.txt' '/tmp/c'`));
	say("the session's tab shows, the quoted paths typed into its terminal", a === 'repo shell' && row.endsWith(`'/tmp/a b.txt' '/tmp/c'`), { shown: a, row });
	await shot(page, '01-dropped');
	await page.keyboard.press('Control+u');
});

await step('notification click', async () => {
	const off = log.offset();
	await page.evaluate(() => window.__vqFire('notification-click', null));
	const s = await until(() => sent(off), (s) => s.show > 0 && s.setFocus > 0, 3000);
	say('the window shown and focused', s.show === 1 && s.setFocus === 1, s);
});

await step('update notice', async () => {
	const before = await notice.count();
	await page.route(INVOKE, offer);
	await page.evaluate(() => window.__vqFire('check-app-update', null));
	await notice.waitFor({ timeout: 5000 });
	const text = await notice.locator('.text').innerText();
	say('Check for Updates: a notice naming 9.9.9', before === 0 && text === 'vaquita 9.9.9 is available.', { before, text });
	await shot(page, '02-notice');
	await notice.locator('button[aria-label="Not now"]').click();
	const gone = await until(() => notice.count(), (n) => n === 0, 3000);
	say('Not now hides it', gone === 0, { notices: gone });
	await page.evaluate(() => window.__vqFire('check-app-update', null));
	await notice.waitFor({ timeout: 5000 });
	say('asked again, it is back', (await notice.count()) === 1, { notices: await notice.count() });
});

await step('Update with an unsaved edit', async () => {
	await panel.locator('.tree button.row', { hasText: 'package.json' }).dblclick();
	await until(shown, (l) => l === 'package.json');
	const text = await edit('x');
	await until(() => page.locator('.tabs .tab.active .dirty').count(), (n) => n === 1);
	const n = await logLength();
	const off = log.offset();
	await updateBtn.click();
	const q = await until(() => asked(n), (q) => q.length > 0, 3000);
	await sleep(500);
	const s = sent(off);
	say('one question, no install', q.length === 1 && q[0] === '1 file has unsaved changes. Update and relaunch?' && s.install === 0, { asked: q, sent: s });
	const after = await edit('y');
	say('the editor takes another character afterwards', after.includes('xy') && !text.includes('xy'), { before: text, after });
});

await step('close request', async () => {
	let n = await logLength();
	let off = log.offset();
	await page.evaluate(() => window.__vqFire('tauri://close-requested', null));
	const q = await until(() => asked(n), (q) => q.length > 0, 3000);
	await sleep(500);
	const s = sent(off);
	say('one question, the window kept', q.length === 1 && q[0] === '1 file has unsaved changes. Close the window?' && s.destroy === 0, { asked: q, sent: s });
	await page.route(INVOKE, accept);
	await page.locator('.tabs .tab', { hasText: 'package.json' }).locator('button.close').click();
	await until(() => page.locator('.tabs .tab', { hasText: 'package.json' }).count(), (c) => c === 0, 3000);
	await page.unroute(INVOKE, accept);
	n = await logLength();
	off = log.offset();
	await page.evaluate(() => window.__vqFire('tauri://close-requested', null));
	const s2 = await until(() => sent(off), (s) => s.destroy > 0, 3000);
	await sleep(300);
	const q2 = await asked(n);
	say('with the edit closed: nothing asked, the window destroyed once', q2.length === 0 && sent(off).destroy === 1, { asked: q2, sent: s2 });
});

// Last: the stand-in answers the install as if it went on, so the app stays installing.
await step('Update', async () => {
	const n = await logLength();
	const off = log.offset();
	await updateBtn.click();
	const s = await until(() => sent(off), (s) => s.install > 0, 3000);
	await sleep(300);
	const q = await asked(n);
	const disabled = await notice.locator('button').evaluateAll((bs) => bs.map((b) => b.disabled));
	say("nothing asked, one install, the notice's buttons disabled", q.length === 0 && sent(off).install === 1 && disabled.length > 0 && disabled.every(Boolean), { asked: q, sent: s, disabled });
	await shot(page, '03-updating');
});

await page.unroute(INVOKE, offer);
await browser.close();
process.exitCode = Math.min(finish(), 125);
