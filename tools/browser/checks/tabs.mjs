// Sessions as tabs beside files in a repo's bar: ⌘1–9 by position, a drag
// that sticks through a reload, the + for a new session, ⌘W killing one,
// the bar following the shown group, and the welcome stepped out of.
// node checks/tabs.mjs <dir>, after run.sh up <dir>; see check.sh.
import fs from 'node:fs';
import path from 'node:path';
import { bridgeLog, openApp, recorder, sleep, until } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node checks/tabs.mjs <dir>');
	process.exit(2);
}
// run.sh registers the repo by its canonical path, which the dialog's folder shows.
const repo = path.join(fs.realpathSync(dir), 'repo');
const log = bridgeLog(dir);
const { say, step, shot, finish } = recorder(path.join(dir, 'shots'));

const { browser, page } = await openApp({ width: 1440, height: 900 });
// Without WebGL2 xterm draws with its DOM renderer, as in welcome.mjs.
await page.addInitScript(() => {
	const get = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
		return type === 'webgl2' ? null : get.call(this, type, ...rest);
	};
});
// No stored session selected, so the load selects nothing.
await page.evaluate(() => localStorage.removeItem('vaquita.selected'));
await page.reload();

const sidebar = page.locator('main > aside:not(.files)');
const sessionRows = sidebar.locator('li:has(> button.row)');
const selectedRows = sidebar.locator('li.selected:has(> button.row)');
const repoSession = sidebar.locator('li > button.row', { hasText: 'repo shell' });
const tmpSession = sidebar.locator('li > button.row', { hasText: 'tmp shell' });
const nameBtn = (r) => sidebar.locator(`li button.name[title="${r}"]`);
const repoHello = page.locator('.repo-hello');
const panel = page.locator('aside.files');
const dialog = page.locator('dialog');
const dialogOpen = () => dialog.evaluate((d) => d.open);

// The bar as shown: each tab's key, label, icon and whether it is active.
const tabs = () =>
	page.evaluate(() =>
		[...document.querySelectorAll('.tabs .tab')].map((t) => ({
			key: t.dataset.path,
			label: t.querySelector('.label')?.textContent,
			icon: t.querySelector('svg')?.getAttribute('data-icon'),
			active: t.classList.contains('active'),
		})),
	);
const labels = (t) => t.map((x) => x.label);
const shown = (t) => t.find((x) => x.active);
const isSession = (x) => !!x?.key?.startsWith('session:');
const focus = () =>
	page.evaluate(() => {
		const a = document.activeElement;
		return { tag: a?.tagName, terminal: !!a?.classList.contains('xterm-helper-textarea') };
	});
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('vaquita.file-tabs') ?? '{}'));
const ASK = /^noop plugin:dialog\|ask /;

await step('a session tab', async () => {
	await repoSession.waitFor({ timeout: 10000 });
	await repoSession.click();
	const t = await until(tabs, (t) => t.length === 1 && t[0].active);
	say('one session tab, active, with the shell icon', t.length === 1 && isSession(t[0]) && t[0].active && t[0].icon === 'command-line' && t[0].label === 'repo shell', t);
	await shot(page, '01-session-tab');
});

await step('a file beside it, Meta+1 and Meta+2', async () => {
	if ((await panel.count()) === 0) await page.locator('footer .files-toggle').click();
	await panel.locator('.tree button.row', { hasText: 'README.md' }).click();
	const t = await until(tabs, (t) => t.length === 2 && t[1].active);
	say('README.md second, active', t.length === 2 && isSession(t[0]) && t[1].label === 'README.md' && t[1].active, t);
	await page.keyboard.press('Meta+1');
	const t1 = await until(tabs, (t) => t[0]?.active, 3000);
	const f1 = await until(focus, (f) => f.terminal, 3000);
	say('Meta+1: the session tab, its terminal focused', !!t1[0]?.active && f1.terminal, { tabs: t1, focus: f1 });
	await page.keyboard.press('Meta+2');
	const t2 = await until(tabs, (t) => t[1]?.active, 3000);
	const f2 = await focus();
	say('Meta+2: the file tab, the terminal not focused', !!t2[1]?.active && !f2.terminal, { tabs: t2, focus: f2 });
});

await step('drag', async () => {
	// Pressed on the file tab, moved left past the session tab's centre and
	// released, as TabBar.svelte.test.ts does with pointer events.
	const from = await page.locator('.tabs .tab[data-path^="/"] button.name').boundingBox();
	const to = await page.locator('.tabs .tab[data-path^="session:"] button.name').boundingBox();
	const y = from.y + from.height / 2;
	await page.mouse.move(from.x + from.width / 2, y);
	await page.mouse.down();
	await page.mouse.move(to.x + 4, y, { steps: 8 });
	await page.mouse.up();
	const t = await until(tabs, (t) => t[0]?.label === 'README.md');
	const groups = await stored();
	const order = Object.values(groups).find((o) => o.some((k) => k.endsWith('/README.md'))) ?? [];
	const at = (re) => order.findIndex((k) => re.test(k));
	say('order [README.md, repo shell]', labels(t).join() === 'README.md,repo shell', t);
	say('stored: the session key after the path', at(/\/README\.md$/) >= 0 && at(/^session:/) > at(/\/README\.md$/), groups);
	await shot(page, '02-dragged');
});

await step('reload', async () => {
	await page.reload();
	await repoSession.waitFor({ timeout: 10000 });
	const t = await until(tabs, (t) => t.length === 2 && isSession(shown(t)));
	const f = await until(focus, (f) => f.terminal, 3000);
	say('the order kept, the session tab active, its terminal focused', labels(t).join() === 'README.md,repo shell' && t[1].active && f.terminal, { tabs: t, focus: f });
});

await step('+', async () => {
	const rows = await sessionRows.count();
	await page.locator('.tabs button.new').click();
	const opened = await until(dialogOpen, (o) => o, 3000);
	const folder = await dialog.locator('input[aria-label="Folder"]').inputValue();
	say('the dialog, the repo as its folder', opened && folder === repo, { opened, folder });
	await page.keyboard.press('Enter');
	const after = await until(() => sessionRows.count(), (n) => n === rows + 1);
	const t = await until(tabs, (t) => t.length === 3 && t[2].active);
	say('a third row and a third tab, last and active', after === rows + 1 && t.length === 3 && isSession(t[2]) && t[2].active, { rows: after, tabs: t });
	await shot(page, '03-new-session');
});

await step('Meta+w on a session tab', async () => {
	const off = log.offset();
	const rows = await sessionRows.count();
	await page.evaluate(() => window.__vqFire('tab', 'close'));
	const t = await until(tabs, (t) => t.length === 2);
	const after = await until(() => sessionRows.count(), (n) => n === rows - 1);
	const asked = log.since(off).filter((l) => ASK.test(l));
	say(
		'its tab and row go, nothing asked, repo shell shown again',
		t.length === 2 && shown(t)?.label === 'repo shell' && after === rows - 1 && asked.length === 0 && !(await dialogOpen()),
		{ tabs: t, rows: after, asked },
	);
});

await step('the dialog over a session tab', async () => {
	const rows = await sessionRows.count();
	await page.keyboard.press('Meta+t');
	const opened = await until(dialogOpen, (o) => o, 3000);
	say('Meta+t opens the dialog', opened, { opened });
	await page.keyboard.press('Meta+1');
	await sleep(300);
	const t = await tabs();
	say('Meta+1 under it switches nothing', shown(t)?.label === 'repo shell' && (await dialogOpen()), t);
	await page.evaluate(() => window.__vqFire('tab', 'close'));
	const closed = await until(dialogOpen, (o) => !o, 3000);
	await sleep(500);
	const t2 = await tabs();
	const after = await sessionRows.count();
	say('Meta+w under it closes the dialog and kills nothing', !closed && after === rows && t2.length === 2 && shown(t2)?.label === 'repo shell', { rows: after, tabs: t2 });
});

await step('Other', async () => {
	await tmpSession.click();
	const t = await until(tabs, (t) => t.length === 1 && t[0].label === 'tmp shell');
	say("the Other bar with tmp shell's tab alone", t.length === 1 && isSession(t[0]) && t[0].label === 'tmp shell' && t[0].active, t);
	await shot(page, '04-other');
});

await step('welcome and Control+Tab', async () => {
	await repoSession.click();
	const t = await until(tabs, (t) => t.length === 2 && shown(t)?.label === 'repo shell');
	say("the repo's bar, repo shell active", labels(t).join() === 'README.md,repo shell' && shown(t)?.label === 'repo shell', t);
	await nameBtn(repo).click();
	await repoHello.waitFor({ timeout: 5000 });
	const w = await until(tabs, (t) => !shown(t), 3000);
	const sel = (await selectedRows.allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
	say('the welcome over it, no tab active, repo shell still selected', w.length === 2 && !shown(w) && sel.length === 1 && sel[0].includes('repo shell'), { tabs: w, selected: sel });
	await page.keyboard.press('Control+Tab');
	const t2 = await until(tabs, (t) => shown(t)?.label === 'README.md', 3000);
	say('Control+Tab: the first tab, README.md, the welcome gone', shown(t2)?.label === 'README.md' && (await repoHello.count()) === 0, t2);
});

await step('kill from the sidebar', async () => {
	await repoSession.click();
	await until(tabs, (t) => shown(t)?.label === 'repo shell');
	const kill = sidebar.locator('li:has(> button.row)', { hasText: 'repo shell' }).locator('.actions button[title="Kill"]');
	await kill.click();
	// A second click sooner would be taken for a double-click and ignored.
	await sleep(500);
	await kill.click();
	const t = await until(tabs, (t) => t.length === 1);
	const gone = await until(() => repoSession.count(), (n) => n === 0);
	say('the tab goes, README.md shows', t.length === 1 && shown(t)?.label === 'README.md' && gone === 0, { tabs: t, rows: gone });
	await shot(page, '05-killed');
});

await browser.close();
process.exitCode = Math.min(finish(), 125);
