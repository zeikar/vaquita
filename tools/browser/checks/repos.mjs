// Repos coming and going: ⌘W on a repo's welcome, with tabs to go to and
// with none; a repo added under the new-session dialog; folders dropped on
// the sidebar; a removed repo's edited file moving to Other with the
// selection, and Other's name leading back to it.
// node checks/repos.mjs <dir>, after run.sh up <dir>; see check.sh.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeLog, openApp, recorder, sleep, until } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node checks/repos.mjs <dir>');
	process.exit(2);
}
// run.sh registers the repo by its canonical path, which the header's title
// shows; the folders made here are named the same way.
const canonical = fs.realpathSync(dir);
const repo = path.join(canonical, 'repo');
const [repo2, repo3, dropA, dropB] = ['repo2', 'repo3', 'drop-a', 'drop-b'].map((n) => path.join(canonical, n));
const notes = path.join(repo2, 'notes.md');
const vaquitad = (...args) => execFileSync(path.join(dir, 'bin', 'vaquitad'), args, { env: { ...process.env, VAQUITA_HOME: path.join(dir, 'vaquita-home') } });
const log = bridgeLog(dir);
const { say, step, shot, finish } = recorder(path.join(dir, 'shots'));

// The daemon refuses a folder that does not exist, and run.sh makes only repo.
for (const d of [repo2, repo3, dropA, dropB]) {
	fs.mkdirSync(d);
	execFileSync('git', ['-C', d, 'init', '--quiet']);
}
fs.writeFileSync(notes, 'example\n');

const { browser, page } = await openApp({ width: 1440, height: 900 });
// No stored session selected, as manager.ts keeps it, so the load selects nothing.
await page.evaluate(() => localStorage.removeItem('vaquita.selected'));
await page.reload();

const sidebar = page.locator('main > aside:not(.files)');
const selectedRows = sidebar.locator('li.selected:has(> button.row)');
const repoSession = sidebar.locator('li > button.row', { hasText: 'repo shell' });
const header = (r) => sidebar.locator('li', { has: page.locator(`button.name[title="${r}"]`) });
const nameBtn = (r) => header(r).locator('button.name');
const isSelected = (r) => header(r).evaluate((l) => l.classList.contains('selected'));
const hello = page.locator('.hello');
const repoHello = page.locator('.repo-hello');
const tabBar = page.locator('.tabs');
const panel = page.locator('aside.files');
const dialog = page.locator('dialog');
const dialogOpen = () => dialog.evaluate((d) => d.open);
const welcomeOf = async () => ((await repoHello.count()) ? await repoHello.locator('h1').innerText() : null);

// The tab bar as shown: each tab's label, whether it is a file tab, active
// and unsaved.
const tabs = () =>
	page.evaluate(() =>
		[...document.querySelectorAll('.tabs .tab')].map((t) => ({
			label: t.querySelector('.label')?.textContent,
			file: !t.dataset.path?.startsWith('session:'),
			active: t.classList.contains('active'),
			dirty: !!t.querySelector('.dirty'),
		})),
	);
const shown = (t) => t.find((x) => x.active);
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('vaquita.file-tabs') ?? '{}'));

// ⌘W with nothing to set aside closes the window: plugin:window|close, which
// the bridge does nothing for, since a bridge.log offset.
const CLOSE = /^noop plugin:window\|close /;
const closeAsked = (off) => log.since(off).filter((l) => CLOSE.test(l)).length;
// A question is the dialog plugin's message command, noted in __vqLog by
// init.js: the messages asked since the log was n long.
const logLength = () => page.evaluate(() => window.__vqLog.length);
const asked = (n) => page.evaluate((n) => window.__vqLog.slice(n).filter((e) => e.cmd === 'plugin:dialog|message').map((e) => e.args.message), n);

await step('⌘W on a welcome with tabs', async () => {
	await repoSession.waitFor({ timeout: 10000 });
	await repoSession.click();
	await until(tabs, (t) => t.length === 1 && t[0].active);
	if ((await panel.count()) === 0) await page.locator('footer .files-toggle').click();
	await panel.locator('.tree button.row', { hasText: 'README.md' }).dblclick();
	await until(tabs, (t) => shown(t)?.label === 'README.md');
	await page.locator('.tabs .tab', { hasText: 'repo shell' }).locator('button.name').click();
	await until(tabs, (t) => shown(t)?.label === 'repo shell');
	await page.locator('.tabs .tab', { hasText: 'README.md' }).locator('button.name').click();
	await until(tabs, (t) => shown(t)?.label === 'README.md');
	await nameBtn(repo).click();
	await repoHello.waitFor({ timeout: 5000 });
	const off = log.offset();
	await page.evaluate(() => window.__vqFire('tab', 'close'));
	const t = await until(tabs, (t) => shown(t)?.label === 'README.md', 3000);
	await sleep(300);
	const s = { tabs: t, welcome: await repoHello.count(), closes: closeAsked(off) };
	say('README.md, the tab viewed last, shows; the welcome gone, no window close', shown(t)?.label === 'README.md' && s.welcome === 0 && s.closes === 0, s);
});

await step('⌘W with nothing to go to', async () => {
	vaquitad('repos', 'add', repo2);
	const h = await until(welcomeOf, (h) => h === 'repo2');
	const bar = await tabBar.count();
	say("repo2's welcome, no bar", h === 'repo2' && bar === 0, { welcome: h, bar });
	const off = log.offset();
	await page.evaluate(() => window.__vqFire('tab', 'close'));
	await until(() => closeAsked(off), (n) => n > 0, 3000);
	await sleep(300);
	say('one plugin:window|close', closeAsked(off) === 1, { closes: closeAsked(off) });
	await shot(page, '01-repo2');
});

await step('added under the dialog', async () => {
	await repoSession.click();
	await until(tabs, (t) => shown(t)?.label === 'repo shell');
	await page.keyboard.press('Meta+t');
	await until(dialogOpen, (o) => o, 3000);
	vaquitad('repos', 'add', repo3);
	await header(repo3).waitFor({ timeout: 5000 });
	// Long enough for the welcome to have opened, were it going to.
	await sleep(500);
	const s = { open: await dialogOpen(), welcome: await welcomeOf() };
	say('the dialog open, no repo welcome', s.open && s.welcome === null, s);
	await page.keyboard.press('Escape');
	const h = await until(welcomeOf, (h) => h === 'repo3');
	say("Escape: repo3's welcome", h === 'repo3' && !(await dialogOpen()), { welcome: h });
});

await step('dropped on the sidebar', async () => {
	// The drop's position arrives in physical pixels, as Tauri sends it.
	await page.evaluate(
		({ paths }) => {
			const b = document.querySelector('main > aside:not(.files)').getBoundingClientRect();
			const r = window.devicePixelRatio;
			window.__vqFire('tauri://drag-drop', { paths, position: { x: (b.left + b.width / 2) * r, y: (b.top + b.height / 2) * r } });
		},
		{ paths: [dropA, dropB] },
	);
	await header(dropA).waitFor({ timeout: 5000 });
	await header(dropB).waitFor({ timeout: 5000 });
	const h = await until(welcomeOf, (h) => h === 'drop-b');
	say("both headers, the welcome drop-b's", h === 'drop-b', { welcome: h });
	await shot(page, '02-dropped');
});

await step('removed with an edit', async () => {
	await nameBtn(repo2).click();
	await until(welcomeOf, (h) => h === 'repo2');
	await panel.locator('.tree button.row', { hasText: 'notes.md' }).click();
	await until(tabs, (t) => shown(t)?.label === 'notes.md');
	// A Markdown file shows its preview; the edit is made in its source.
	await page.locator('button[aria-label="Source"]').click();
	const editor = page.locator('.file .text:not([hidden]) .monaco-editor .view-lines');
	await editor.waitFor({ timeout: 15000 });
	await editor.click();
	await page.keyboard.type('x');
	await until(tabs, (t) => !!shown(t)?.dirty);
	const n = await logLength();
	vaquitad('repos', 'rm', repo2);
	await until(() => header(repo2).count(), (c) => c === 0);
	const t = await until(tabs, (t) => shown(t)?.label === 'notes.md');
	const groups = await stored();
	const s = {
		tabs: t,
		other: await isSelected('other'),
		welcome: (await repoHello.count()) + (await hello.count()),
		asked: await asked(n),
		stored: groups,
	};
	say(
		'Other selected, notes.md shown and dirty, no welcome, nothing asked, stored under other',
		s.other && shown(t)?.label === 'notes.md' && shown(t).dirty && s.welcome === 0 && s.asked.length === 0 && (groups.other ?? []).includes(notes) && !(repo2 in groups),
		s,
	);
	await shot(page, '03-other');
});

await step("Other's name", async () => {
	await nameBtn(repo).click();
	await until(welcomeOf, (h) => h === 'repo');
	await nameBtn('other').click();
	const t = await until(tabs, (t) => shown(t)?.label === 'notes.md');
	const s = { tabs: t, selected: await selectedRows.count(), welcome: await repoHello.count() };
	say('notes.md shows again, still dirty, no session selected', shown(t)?.label === 'notes.md' && shown(t).dirty && s.selected === 0 && s.welcome === 0, s);
});

await browser.close();
process.exitCode = Math.min(finish(), 125);
