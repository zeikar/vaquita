// The Past view end to end: the repo's past conversations listed newest first,
// the filter, a row resuming its conversation in a new session (the stand-in
// shell only prints the command), and the list read only while it is shown.
// node checks/past.mjs <dir>, after run.sh up <dir>; see check.sh.
import fs from 'node:fs';
import path from 'node:path';
import { bridgeLog, headerBottoms, level, openApp, recorder, sleep, until } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node checks/past.mjs <dir>');
	process.exit(2);
}
// As bridge.mjs answers past_conversations.
const ID_LOGIN = 'c0ffee00-0000-4000-8000-000000000004';

const repo = path.join(dir, 'repo');
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
await page.reload();

const panel = page.locator('aside.files');
const filesBtn = panel.locator('header .switch button').nth(0);
const changesBtn = panel.locator('header .switch button').nth(1);
const pastBtn = panel.locator('header .switch button[aria-label="Past conversations"]');
const refresh = panel.locator('header button[aria-label="Refresh past conversations"]');
const filter = panel.locator('input[aria-label="Filter past conversations by title"]');
const rows = panel.locator('.past button.row');
const sidebar = page.locator('main > aside:not(.files)');
const sessionRows = sidebar.locator('li:has(> button.row)');
const repoSession = sidebar.locator('button', { hasText: 'repo shell' }).first();

const count = (lines, re) => lines.filter((l) => re.test(l)).length;
const PAST = /^invoke past_conversations /;

const pastRows = () =>
	rows.evaluateAll((rs) =>
		rs.map((r) => ({
			title: r.querySelector('.title')?.textContent,
			when: r.querySelector('.when')?.getAttribute('aria-label') ?? r.querySelector('.when')?.textContent,
			icon: r.querySelector('svg')?.getAttribute('data-icon'),
		})),
	);
const titles = async () => (await pastRows()).map((r) => r.title);
const whenOf = async (title) => (await pastRows()).find((r) => r.title === title)?.when;
const selectedText = async () => (await sidebar.locator('li.selected').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
// Where the focus is: a terminal's textarea; and the text of the terminal
// shown.
const focus = () =>
	page.evaluate(() => {
		const a = document.activeElement;
		return { tag: a?.tagName, terminal: !!a?.classList.contains('xterm-helper-textarea') };
	});
const terminalText = () =>
	page.evaluate(() => {
		const t = [...document.querySelectorAll('.term')].find((e) => e.style.display !== 'none' && e.offsetParent !== null);
		return t?.querySelector('.xterm-rows')?.textContent ?? null;
	});

// The panel's Past view for the repo session; the view is kept only for the
// app run, so a reload shows Files again.
async function showPast() {
	await repoSession.waitFor({ timeout: 10000 });
	if ((await panel.count()) === 0) await page.locator('footer .files-toggle').click();
	await repoSession.click();
	await pastBtn.click();
	await panel.locator('.past').waitFor();
}

const want = [
	{ title: 'Rename util to helpers', when: '2h', icon: 'claude' },
	{ title: 'Sort the tree', when: '1d', icon: 'claude' },
	{ title: 'Codex in the repo', when: '3d', icon: 'openai' },
	{ title: 'Fix the login form', when: '6d', icon: 'claude' },
];

await step('list', async () => {
	const off = log.offset();
	await showPast();
	const list = await until(pastRows, (r) => r.length === 4);
	say('four rows, newest first, with times and agent icons', JSON.stringify(list) === JSON.stringify(want), list);
	const calls = count(await until(() => log.since(off), (l) => count(l, PAST) >= 1, 3000), PAST);
	say('one past_conversations on show', calls === 1, { calls });
	say('header rows end level', level(await headerBottoms(page)), await headerBottoms(page));
	await shot(page, '01-past');
	await shot(panel, '01-past-panel');
});

await step('filter', async () => {
	await filter.click();
	await filter.fill('login');
	const one = await until(titles, (t) => t.length === 1);
	say('login: one row', one.length === 1 && one[0] === 'Fix the login form', one);
	await filter.press('Escape');
	const all = await until(titles, (t) => t.length === 4);
	const f = await until(focus, (v) => v.terminal, 3000);
	const value = await filter.inputValue();
	say('Escape: four rows, an empty filter, the focus on the terminal', all.length === 4 && value === '' && f.terminal, { rows: all, value, focus: f });
});

let resumed;
await step('resume', async () => {
	const before = await sessionRows.count();
	await rows.filter({ hasText: 'Fix the login form' }).click();
	const after = await until(() => sessionRows.count(), (n) => n === before + 1);
	resumed = await until(selectedText, (s) => s.length === 1 && !s[0].includes('repo shell'), 3000);
	say('a new session, selected', after === before + 1 && resumed.length === 1 && !resumed[0].includes('repo shell'), { before, after, selected: resumed });
	const f = await until(focus, (v) => v.terminal, 3000);
	say('the focus on its terminal', f.terminal, f);
	const line = `claude --resume ${ID_LOGIN}`;
	const text = await until(terminalText, (t) => t?.includes(line));
	say('the terminal shows the command', !!text?.includes(line), { line, text: text?.trim().slice(0, 200) ?? null });
	const t0 = Date.now();
	const when = await until(() => whenOf('Fix the login form'), (w) => w === 'open', 2000);
	say('the row reads open', when === 'open', { when, ms: Date.now() - t0 });
	await shot(page, '02-resumed');
});

await step('open row', async () => {
	await repoSession.click();
	await until(selectedText, (s) => s.length === 1 && s[0].includes('repo shell'), 3000);
	const before = await sessionRows.count();
	await rows.filter({ hasText: 'Fix the login form' }).click();
	const sel = await until(selectedText, (s) => JSON.stringify(s) === JSON.stringify(resumed), 3000);
	// A second session would have been listed by now.
	await sleep(500);
	const after = await sessionRows.count();
	say('an open row selects its session, no new one', after === before && JSON.stringify(sel) === JSON.stringify(resumed), { before, after, selected: sel });
});

await step('Refresh', async () => {
	const off = log.offset();
	await refresh.click();
	await until(() => log.since(off), (l) => count(l, PAST) >= 1, 3000);
	// A second read would come right after the first.
	await sleep(1000);
	const calls = count(log.since(off), PAST);
	say('Refresh reads the list once', calls === 1, { calls });
});

await step('Files and hidden', async () => {
	const off = log.offset();
	await filesBtn.click();
	await panel.locator('.tree').waitFor({ timeout: 5000 });
	await page.locator('footer .files-toggle').click();
	await panel.waitFor({ state: 'detached', timeout: 3000 });
	await sleep(5000);
	const calls = log.since(off).filter((l) => PAST.test(l));
	say('Files, then hidden: no past_conversations for 5 s', calls.length === 0, calls);
});

await step('narrow panel', async () => {
	// Twelve changes, so the badge has two digits.
	fs.mkdirSync(path.join(repo, 'extra'));
	for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(repo, 'extra', `f${i}.txt`), 'x\n');
	// Below the minimum, so the panel opens at its narrowest.
	await page.evaluate(() => localStorage.setItem('vaquita.file-panel-width', '100'));
	await page.reload();
	await repoSession.waitFor({ timeout: 10000 });
	if ((await panel.count()) === 0) await page.locator('footer .files-toggle').click();
	await repoSession.click();
	// The badge is a count Changes has taken.
	await changesBtn.click();
	await until(() => changesBtn.locator('.badge').count(), (n) => n === 1);
	await pastBtn.click();
	await refresh.waitFor();
	const m = await page.evaluate(() => {
		const a = document.querySelector('aside.files');
		const h = a.querySelector('header');
		const box = (e) => {
			const r = e.getBoundingClientRect();
			return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
		};
		const past = h.querySelector('[aria-label="Past conversations"]');
		const changes = h.querySelector('.switch .changes');
		const refresh = h.querySelector('[aria-label="Refresh past conversations"]');
		return {
			width: Math.round(a.getBoundingClientRect().width),
			header: box(h),
			changes: box(changes),
			badge: { ...box(changes.querySelector('.badge')), text: changes.querySelector('.badge').textContent },
			past: { ...box(past), cut: past.scrollWidth > past.clientWidth },
			refresh: box(refresh),
		};
	});
	const inside = (r, b) => r.left >= b.left - 0.5 && r.right <= b.right + 0.5;
	const ok =
		m.width === 210 &&
		m.badge.text === '12' &&
		inside(m.badge, m.changes) &&
		m.changes.right <= m.past.left + 0.5 &&
		!m.past.cut &&
		inside(m.past, m.header) &&
		inside(m.refresh, m.header) &&
		m.past.right <= m.refresh.left + 0.5;
	say('210 px with a badge of 12: Past and Refresh whole, clear of Changes', ok, m);
	await shot(panel, '03-narrow-panel');
	fs.rmSync(path.join(repo, 'extra'), { recursive: true });
});

await browser.close();
process.exitCode = Math.min(finish(), 125);
