// The two welcome screens end to end: the app's with nothing selected, and a
// repo's, opened by its name in the sidebar, with its starts, its past
// conversations and its tab beside a session's terminal.
// node checks/welcome.mjs <dir>, after run.sh up <dir>; see check.sh.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeLog, headerBottoms, level, openApp, recorder, sleep, until } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node checks/welcome.mjs <dir>');
	process.exit(2);
}
// run.sh registers the repo by its canonical path, which the header's title shows.
const repo = path.join(fs.realpathSync(dir), 'repo');
const repo2 = path.join(fs.realpathSync(dir), 'repo2');
const log = bridgeLog(dir);
const { say, step, shot, finish } = recorder(path.join(dir, 'shots'));

const { browser, page } = await openApp({ width: 1440, height: 900 });
// Without WebGL2 xterm draws with its DOM renderer, whose rows hold the text
// a step reads; with it the text is only pixels.
await page.addInitScript(() => {
	const get = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
		return type === 'webgl2' ? null : get.call(this, type, ...rest);
	};
});
// No stored session selected, as manager.ts keeps it, so the load selects nothing.
await page.evaluate(() => localStorage.removeItem('vaquita.selected'));
await page.reload();

const sidebar = page.locator('main > aside:not(.files)');
const sessionRows = sidebar.locator('li:has(> button.row)');
const selectedRows = sidebar.locator('li.selected:has(> button.row)');
const repoSession = sidebar.locator('li > button.row', { hasText: 'repo shell' });
const tmpSession = sidebar.locator('li > button.row', { hasText: 'tmp shell' });
const header = (r) => sidebar.locator('li', { has: page.locator(`button.name[title="${r}"]`) });
const nameBtn = (r) => header(r).locator('button.name');
const chevron = header(repo).locator('button.chevron');
const hello = page.locator('.hello');
const repoHello = page.locator('.repo-hello');
const tabBar = page.locator('.tabs');
const panel = page.locator('aside.files');
const pastBtn = panel.locator('header .switch button[aria-label="Past conversations"]');
const dialog = page.locator('dialog');

const count = (lines, re) => lines.filter((l) => re.test(l)).length;
const GIT_CHANGES = /^invoke git_changes /;
const PAST = /^invoke past_conversations /;

const focus = () =>
	page.evaluate(() => {
		const a = document.activeElement;
		return {
			tag: a?.tagName,
			cls: typeof a?.className === 'string' ? a.className : null,
			terminal: !!a?.classList.contains('xterm-helper-textarea'),
			inRepoHello: !!a?.closest('.repo-hello'),
		};
	});
// The tab bar as shown: each tab's label, icon, whether it is a file tab and active.
const tabs = () =>
	page.evaluate(() =>
		[...document.querySelectorAll('.tabs .tab')].map((t) => ({
			label: t.querySelector('.label')?.textContent,
			icon: t.querySelector('svg')?.getAttribute('data-icon'),
			file: t.hasAttribute('data-path'),
			active: t.classList.contains('active'),
		})),
	);
const meta = async () => (await repoHello.locator('.meta > span').allInnerTexts()).map((t) => t.trim()).join(' | ');
// The selected session's terminal, shown or covered: its rows hold its text.
const terminalText = () =>
	page.evaluate(() => {
		const t = [...document.querySelectorAll('.term')].find((e) => e.style.display !== 'none');
		return t?.querySelector('.xterm-rows')?.textContent ?? null;
	});

await step('app welcome', async () => {
	await repoSession.waitFor({ timeout: 10000 });
	await hello.waitFor({ timeout: 5000 });
	const v = await until(
		async () => ({
			h1: await hello.locator('h1').innerText(),
			lede: await hello.locator('.lede').innerText(),
			version: (await hello.locator('.ver').count()) ? await hello.locator('.ver').innerText() : null,
			tabBar: await tabBar.count(),
			selected: await selectedRows.count(),
		}),
		(v) => v.version !== null,
	);
	say(
		'wordmark, lede and version, no tab bar, nothing selected',
		v.h1 === 'vaquita' && v.lede.startsWith('Claude Code and Codex') && v.version === '0.0.0-browser' && v.tabBar === 0 && v.selected === 0,
		v,
	);
	const f = await until(focus, (f) => f.tag !== 'BODY', 3000);
	say('the focus is not on body', f.tag !== 'BODY', f);
	await hello.locator('button.act', { hasText: 'New session' }).click();
	const opened = await until(() => dialog.evaluate((d) => d.open), (o) => o, 3000);
	await page.keyboard.press('Escape');
	const closed = await until(() => dialog.evaluate((d) => d.open), (o) => !o, 3000);
	say('New session opens the dialog, Escape closes it', opened && !closed, { opened, closed: !closed });
	await shot(page, '01-app-welcome');
});

await step('repo welcome', async () => {
	const off = log.offset();
	await nameBtn(repo).click();
	await repoHello.waitFor({ timeout: 5000 });
	const t = await until(tabs, (t) => t.length === 1);
	const sel = { header: await header(repo).evaluate((l) => l.classList.contains('selected')), rows: await selectedRows.count() };
	say(
		'one active repo tab with a folder icon, no terminal tab, the header selected',
		t.length === 1 && t[0].label === 'repo' && t[0].icon === 'folder' && t[0].file && t[0].active && sel.header && sel.rows === 0,
		{ tabs: t, ...sel },
	);
	const h1 = await repoHello.locator('h1').innerText();
	const m = await until(meta, (m) => m.includes('changes'));
	say('h1 repo; on main or master, no changes, 1 session', h1 === 'repo' && /^on (main|master) \| no changes \| 1 session$/.test(m), { h1, meta: m });
	const p = await until(
		async () => ({ repo: (await panel.locator('header .repo').count()) ? await panel.locator('header .repo').innerText() : null, tree: await panel.locator('.tree').count() }),
		(p) => p.repo === 'repo' && p.tree === 1,
	);
	say("the panel shows the repo's tree", p.repo === 'repo' && p.tree === 1, p);
	const rows = await until(() => repoHello.locator('.past button.row').count(), (n) => n === 4);
	say('four past rows', rows === 4, { rows });
	await until(() => log.since(off), (l) => count(l, GIT_CHANGES) >= 1 && count(l, PAST) >= 1, 3000);
	// A second read would come right after the first.
	await sleep(1000);
	const l = log.since(off);
	say('one git_changes and one past_conversations', count(l, GIT_CHANGES) === 1 && count(l, PAST) === 1, { git: count(l, GIT_CHANGES), past: count(l, PAST) });
	say('header rows end level', level(await headerBottoms(page)), await headerBottoms(page));
	const f = await until(focus, (f) => f.inRepoHello, 3000);
	say('the focus inside the welcome', f.inRepoHello, f);
	await shot(page, '02-repo-welcome');
});

await step('chevron', async () => {
	await chevron.click();
	const hidden = await until(() => repoSession.count(), (n) => n === 0, 3000);
	const s1 = {
		repoRows: hidden,
		tmpRows: await tmpSession.count(),
		welcome: await repoHello.count(),
		header: await header(repo).evaluate((l) => l.classList.contains('selected')),
	};
	say('collapsed: its rows hidden, the welcome and the selection kept', s1.repoRows === 0 && s1.tmpRows === 1 && s1.welcome === 1 && s1.header, s1);
	await chevron.click();
	const shown = await until(() => repoSession.count(), (n) => n === 1, 3000);
	say('expanded: its rows again', shown === 1 && (await repoHello.count()) === 1, { repoRows: shown });
});

await step('All past', async () => {
	await repoHello.locator('button.all').click();
	const pressed = await until(() => pastBtn.getAttribute('aria-pressed'), (v) => v === 'true', 3000);
	say("All past conversations presses the panel's Past", pressed === 'true', { pressed });
});

await step('start shell', async () => {
	const before = await sessionRows.count();
	await repoHello.locator('button.start.shell').click();
	const after = await until(() => sessionRows.count(), (n) => n === before + 1);
	const sel = await until(
		async () => (await selectedRows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()),
		(s) => s.length === 1 && !/repo shell|tmp shell/.test(s[0]),
		3000,
	);
	say('a new session, selected', after === before + 1 && sel.length === 1 && !/repo shell|tmp shell/.test(sel[0]), { before, after, selected: sel });
	const f = await until(focus, (f) => f.terminal, 3000);
	say('the terminal focused', f.terminal, f);
	const t = await until(tabs, (t) => t.length === 2);
	say(
		'the terminal tab, active, and the repo tab',
		t.length === 2 && !t[0].file && t[0].active && t[1].file && t[1].label === 'repo' && !t[1].active,
		t,
	);
	// The shell's prompt is there and settled before the text is compared.
	await until(terminalText, (s) => !!s?.trim(), 5000);
	await sleep(500);
	const text = await terminalText();

	await page.keyboard.press('Control+Tab');
	const w = await until(tabs, (t) => t[1]?.active, 3000);
	const f1 = await until(focus, (f) => f.inRepoHello, 3000);
	say('Control+Tab: the welcome, the focus off the terminal', !!w[1]?.active && (await repoHello.count()) === 1 && !f1.terminal && f1.tag !== 'TEXTAREA', { tabs: w, focus: f1 });
	await page.keyboard.type('x');
	await sleep(500);
	await page.keyboard.press('Control+Tab');
	const back = await until(tabs, (t) => t[0]?.active, 3000);
	const f2 = await until(focus, (f) => f.terminal, 3000);
	await sleep(300);
	const after2 = await terminalText();
	say('typing under the welcome reaches no terminal', after2 === text, { before: text?.trim().slice(-80), after: after2?.trim().slice(-80) });
	say('Control+Tab: the terminal, its textarea focused', !!back[0]?.active && f2.terminal, { tabs: back, focus: f2 });
	await shot(page, '03-shell');

	await page.reload();
	await repoSession.waitFor({ timeout: 10000 });
	const r = await until(tabs, (t) => t.length === 2 && t[0].active);
	const welcome = await repoHello.count();
	say('reload: the terminal first, the repo tab in the bar', r.length === 2 && !r[0].file && r[0].active && r[1].label === 'repo' && !r[1].active && welcome === 0, {
		tabs: r,
		welcome,
	});
});

await step('close and back', async () => {
	await tmpSession.click();
	const t = await until(tabs, (t) => t.length === 1 && !t[0].file);
	say('the other group: no repo tab', t.length === 1 && !t[0].file, t);
	await nameBtn(repo).click();
	await repoHello.waitFor({ timeout: 5000 });
	const rows = await until(() => selectedRows.count(), (n) => n === 0, 3000);
	const t2 = await tabs();
	say('the repo name: no session selected, its welcome', rows === 0 && t2.length === 1 && t2[0].label === 'repo' && t2[0].active, { selected: rows, tabs: t2 });
	await page.locator('.tabs .tab[data-path] button.close').click();
	await hello.waitFor({ timeout: 3000 });
	const s = { hello: await hello.count(), tabBar: await tabBar.count(), header: await header(repo).evaluate((l) => l.classList.contains('selected')) };
	say('its × closed: the app welcome, nothing selected', s.hello === 1 && s.tabBar === 0 && !s.header, s);
});

await step('add a repo', async () => {
	fs.mkdirSync(repo2);
	execFileSync('git', ['-C', repo2, 'init', '--quiet']);
	// The + opens the native folder picker inside Tauri, which init.js says
	// the page is; the picker's answer is repo2.
	const pick = async (route) => {
		const { cmd } = JSON.parse(route.request().postData() ?? '{}');
		if (cmd !== 'plugin:dialog|open') return route.continue();
		return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' }, body: JSON.stringify({ ok: true, value: repo2 }) });
	};
	await page.route('http://127.0.0.1:14999/invoke', pick);
	await sidebar.locator('header button[aria-label="Add repo"]').click();
	const h1 = await until(async () => ((await repoHello.count()) ? await repoHello.locator('h1').innerText() : null), (h) => h === 'repo2');
	await page.unroute('http://127.0.0.1:14999/invoke', pick);
	const t = await tabs();
	say('the repo2 welcome', h1 === 'repo2' && t.length === 1 && t[0].label === 'repo2' && t[0].active, { h1, tabs: t });
	await shot(page, '04-repo2');
});

await browser.close();
process.exitCode = Math.min(finish(), 125);
