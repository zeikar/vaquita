// The Changes view end to end: the list and its badge follow the repo, a row
// opens a diff tab, and git runs only while the view is shown.
// node checks/changes.mjs <dir>, after run.sh up <dir>; see check.sh.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeLog, openApp, recorder, sleep, until } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node checks/changes.mjs <dir>');
	process.exit(2);
}
const repo = path.join(dir, 'repo');
const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
const log = bridgeLog(dir);
const { say, step, shot, finish } = recorder(path.join(dir, 'shots'));

const { browser, page } = await openApp({ width: 1440, height: 900 });

const panel = page.locator('aside.files');
const filesBtn = panel.locator('header .switch button').nth(0);
const changesBtn = panel.locator('header .switch button').nth(1);
const rows = panel.locator('.changes button.row');
const repoSession = page.locator('main > aside:not(.files) button', { hasText: 'repo shell' }).first();
const diffTab = page.locator('.tabs .tab', { has: page.locator('.mark') }).first();
const sideBySide = page.locator('.file .bar button[title="Side by side"]');
const openFile = page.locator('.file .bar button[title="Open file"]');

const changesText = async () => (await panel.locator('.changes').innerText()).trim();
const rowTexts = async () => (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
const badge = async () => ((await changesBtn.locator('.badge').count()) ? await changesBtn.locator('.badge').innerText() : null);
const report = async () => ((await page.locator('footer .report').count()) ? await page.locator('footer .report').innerText() : null);
const count = (lines, re) => lines.filter((l) => re.test(l)).length;
const GIT_CHANGES = /^invoke git_changes /;
const DIFF_SIDES = /^invoke diff_sides /;
const WATCH_OFF = /^watch_repo off /;
const WATCH_ON = /^watch_repo \{/;

const diffState = () =>
	page.evaluate(() => {
		const d = document.querySelector('.monaco-diff-editor');
		if (!d) return null;
		const w = (s) => {
			const e = d.querySelector(s);
			return e ? Math.round(e.getBoundingClientRect().width) : null;
		};
		return {
			sideBySide: d.classList.contains('side-by-side'),
			original: w('.editor.original'),
			modified: w('.editor.modified'),
			pressed: document.querySelector('.file .bar button[title="Side by side"]')?.getAttribute('aria-pressed'),
		};
	});
const twoPanes = (s) => !!s && s.sideBySide && s.original > 200 && s.modified > 200 && s.pressed === 'true';
const tabState = () =>
	diffTab.evaluate((t) => ({
		label: t.querySelector('.label').textContent,
		mark: t.querySelector('.mark')?.textContent,
		preview: t.classList.contains('preview'),
		active: t.classList.contains('active'),
		fontStyle: getComputedStyle(t.querySelector('.label')).fontStyle,
	}));
// The sidebar's header, the tab row and the panel's header line up at the bottom.
const headerBottoms = () =>
	page.evaluate(() => {
		const b = (sel) => document.querySelector(sel)?.getBoundingClientRect().bottom ?? null;
		return [b('main > aside:not(.files) > header'), b('.tabs'), b('aside.files > header')];
	});
const level = (bottoms) => bottoms.every((b) => b !== null && Math.abs(b - bottoms[0]) < 0.5);

// The panel's Changes view for the repo session; the view itself is kept
// only for the app run, so a reload shows Files again.
async function showChanges() {
	await repoSession.waitFor({ timeout: 10000 });
	if ((await panel.count()) === 0) await page.locator('footer .files-toggle').click();
	await repoSession.click();
	await changesBtn.click();
	await panel.locator('.changes').waitFor();
}

await step('No changes', async () => {
	const off = log.offset();
	await showChanges();
	const text = await until(changesText, (t) => t === 'No changes');
	const b = await badge();
	say('No changes, no badge', text === 'No changes' && b === null, { text, badge: b, log: log.since(off) });
	await shot(page, '01-no-changes');
});

await step('four edits', async () => {
	fs.appendFileSync(path.join(repo, 'README.md'), 'One more line for the check.\n');
	fs.writeFileSync(path.join(repo, 'src/new.ts'), 'export const n = 1;\n');
	fs.unlinkSync(path.join(repo, 'docs/guide.md'));
	git('mv', 'src/lib/util.ts', 'src/lib/util2.ts');
	const t0 = Date.now();
	const list = await until(rowTexts, (t) => t.length === 4);
	const ms = Date.now() - t0;
	const b = await until(badge, (v) => v === '4', 2000);
	const aria = await changesBtn.getAttribute('aria-label');
	const want = ['M README.md', 'U src/new.ts', 'D docs/guide.md', 'R src/lib/util2.ts'];
	const listed = want.every((w) => list.some((r) => r.startsWith(w)));
	say('four rows', list.length === 4 && listed, { ms, rows: list });
	say('badge 4', b === '4' && aria === 'Changes, 4 changed', { badge: b, aria });
	await shot(page, '02-list');
	await shot(panel, '02-list-panel');
});

await step('diff tab', async () => {
	const off = log.offset();
	await rows.filter({ hasText: 'README.md' }).first().click();
	const s = await until(diffState, twoPanes, 8000);
	const tab = await tabState();
	say(
		'preview diff tab',
		tab.preview && tab.active && tab.fontStyle === 'italic' && tab.label === 'README.md' && tab.mark === 'diff',
		tab,
	);
	say('two panes at 1440', twoPanes(s), s);
	const where = await page.locator('.file .bar .where').innerText();
	say('path bar', where === 'README.md', { where });
	const focus = await until(
		() => page.evaluate(() => ({ tag: document.activeElement?.tagName, inDiff: !!document.activeElement?.closest('.monaco-diff-editor') })),
		(f) => f.inDiff,
		3000,
	);
	say('focus in the diff editor', focus.inDiff, focus);
	const calls = count(log.since(off), DIFF_SIDES);
	say('one diff_sides', calls === 1, { calls });
	await shot(page, '03-diff');
});

await step('pin', async () => {
	await diffTab.locator('button.name').dblclick();
	const tab = await until(tabState, (t) => !t.preview, 2000);
	say('double-click pins', !tab.preview && tab.fontStyle === 'normal', tab);
});

await step('inline and back', async () => {
	await sideBySide.click();
	const inline = await until(diffState, (s) => !!s && !s.sideBySide && s.pressed === 'false', 3000);
	await shot(page, '04-inline');
	await sideBySide.click();
	const back = await until(diffState, twoPanes, 3000);
	say('inline, then side by side', !!inline && !inline.sideBySide && inline.pressed === 'false' && twoPanes(back), { inline, back });
});

await step('terminal and back', async () => {
	const off = log.offset();
	await page.evaluate(() => window.__vqFire('tab', 'terminal'));
	const terminal = await until(
		() => page.locator('.tabs .tab').first().evaluate((t) => t.classList.contains('active')),
		(v) => v,
		3000,
	);
	await diffTab.locator('button.name').click();
	const s = await until(diffState, twoPanes, 5000);
	const calls = count(await until(() => log.since(off), (l) => count(l, DIFF_SIDES) >= 1, 3000), DIFF_SIDES);
	say('back on the diff tab reads both sides again', terminal && calls === 1 && twoPanes(s), { terminal, calls, s });
});

await step('Open file', async () => {
	await openFile.click();
	// README.md opens in its Markdown preview, which shows the edited text.
	const edited = page.locator('.file').getByText('One more line for the check.');
	const state = async () => ({
		...(await page.evaluate(() => {
			const active = document.querySelector('.tabs .tab.active');
			return {
				label: active?.querySelector('.label')?.textContent,
				diff: !!active?.querySelector('.mark'),
				diffEditor: !!document.querySelector('.monaco-diff-editor'),
			};
		})),
		shown: await edited.isVisible(),
	});
	const ok = (v) => v.label === 'README.md' && !v.diff && !v.diffEditor && v.shown;
	const s = await until(state, ok);
	say('Open file opens the file in a tab of its own', ok(s), s);
	await shot(page, '05-open-file');
});

await step('binary', async () => {
	fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62, 0x0a]));
	const row = rows.filter({ hasText: 'bin.dat' });
	await row.waitFor({ timeout: 5000 });
	const before = await report();
	await row.click();
	const error = page.locator('.diff-view .error');
	await error.waitFor({ timeout: 5000 });
	const text = await error.innerText();
	// The status line could take a moment to show a report.
	await sleep(500);
	const after = await report();
	const open = await openFile.count();
	say('a NUL file cannot be diffed, and that is no report', text === 'cannot show diff: binary' && open === 1 && after === before, {
		text,
		open,
		reportBefore: before,
		reportAfter: after,
	});
	await shot(page, '06-binary');
});

await step('Files and Changes', async () => {
	let off = log.offset();
	await filesBtn.click();
	await panel.locator('.tree').waitFor({ timeout: 5000 });
	const l1 = await until(() => log.since(off), (l) => count(l, WATCH_OFF) >= 1, 3000);
	const b = await badge();
	say('Files: the repo watch stops, no git_changes, the badge stays', count(l1, WATCH_OFF) === 1 && count(l1, GIT_CHANGES) === 0 && b === '5', {
		badge: b,
		log: l1,
	});
	const filesBottoms = await headerBottoms();
	await shot(page, '07-files');
	off = log.offset();
	await changesBtn.click();
	await until(() => log.since(off), (l) => count(l, GIT_CHANGES) >= 1, 3000);
	// A second read would come right after the first.
	await sleep(1000);
	const l2 = log.since(off);
	say('Changes: the watch starts and git runs once', count(l2, WATCH_ON) === 1 && count(l2, GIT_CHANGES) === 1, l2);
	const changesBottoms = await headerBottoms();
	say('header rows end level', level(filesBottoms) && level(changesBottoms), { files: filesBottoms, changes: changesBottoms });
});

await step('narrow panel', async () => {
	// Below the minimum, so the panel opens at its narrowest.
	await page.evaluate(() => localStorage.setItem('vaquita.file-panel-width', '100'));
	await page.reload();
	await showChanges();
	await until(badge, (v) => v === '5');
	const m = await page.evaluate(() => {
		const a = document.querySelector('aside.files');
		const h = a.querySelector('header');
		const ar = a.getBoundingClientRect();
		const hr = h.getBoundingClientRect();
		const out = (r, box) => r.left < box.left - 0.5 || r.right > box.right + 0.5;
		return {
			width: Math.round(ar.width),
			headerOverflow: h.scrollWidth > h.clientWidth,
			spilled: [...h.querySelectorAll('*')].filter((e) => out(e.getBoundingClientRect(), hr)).map((e) => e.className || e.tagName),
			rowsSpilled: [...a.querySelectorAll('.changes button.row')].filter((r) => out(r.lastElementChild.getBoundingClientRect(), ar)).length,
			badge: a.querySelector('.switch .badge')?.textContent ?? null,
		};
	});
	say('180 px with the badge: nothing spills', m.width === 180 && !m.headerOverflow && m.spilled.length === 0 && m.rowsSpilled === 0 && m.badge === '5', m);
	await shot(panel, '08-narrow-panel');
});

await step('revert', async () => {
	git('reset', '--quiet', '--hard');
	for (const p of ['src/new.ts', 'bin.dat']) fs.unlinkSync(path.join(repo, p));
	const t0 = Date.now();
	const text = await until(changesText, (t) => t === 'No changes');
	const ms = Date.now() - t0;
	const b = await until(badge, (v) => v === null, 2000);
	const aria = await changesBtn.getAttribute('aria-label');
	say('reverted: No changes, no badge', text === 'No changes' && b === null && aria === null, { ms, text, badge: b, aria });
	await shot(page, '09-reverted');
});

await step('hidden panel', async () => {
	const off = log.offset();
	await page.locator('footer .files-toggle').click();
	await panel.waitFor({ state: 'detached', timeout: 3000 });
	const l1 = await until(() => log.since(off), (l) => count(l, WATCH_OFF) >= 1, 3000);
	say('hiding the panel stops the repo watch', count(l1, WATCH_OFF) === 1, l1);
	const off2 = log.offset();
	fs.appendFileSync(path.join(repo, 'README.md'), 'While the panel is hidden.\n');
	await sleep(5000);
	const quiet = log.since(off2).filter((l) => /git_changes|watch_repo|repo-changed/.test(l));
	git('checkout', '--', 'README.md');
	say('nothing runs git for 5 s, a write included', quiet.length === 0, quiet);
	await shot(page, '10-hidden');
});

await browser.close();
process.exitCode = Math.min(finish(), 125);
