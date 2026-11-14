// File tabs in a repo's bar: the preview tab the next file replaces, kept by a
// double-click on its tab or in the tree and by an edit; closing the shown
// tab going back to the one viewed before; and one question for all the
// unsaved tabs a close takes, declined and accepted.
// node checks/filetabs.mjs <dir>, after run.sh up <dir>; see check.sh.
import fs from 'node:fs';
import path from 'node:path';
import { openApp, recorder, sleep, until } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node checks/filetabs.mjs <dir>');
	process.exit(2);
}
// run.sh registers the repo by its canonical path, which the tree's paths start with.
const repo = path.join(fs.realpathSync(dir), 'repo');
const { say, step, shot, finish } = recorder(path.join(dir, 'shots'));

const { browser, page } = await openApp({ width: 1440, height: 900 });
// No stored session selected, so the load selects nothing.
await page.evaluate(() => localStorage.removeItem('vaquita.selected'));
await page.reload();

const sidebar = page.locator('main > aside:not(.files)');
const repoSession = sidebar.locator('li > button.row', { hasText: 'repo shell' });
const panel = page.locator('aside.files');
const row = (name) => panel.locator('.tree button.row', { hasText: name });
const tab = (name) => page.locator(`.tabs .tab[data-path="${path.join(repo, name)}"]`);

// The bar as shown: each tab's label, whether it is a session's, active, the
// preview and unsaved.
const tabs = () =>
	page.evaluate(() =>
		[...document.querySelectorAll('.tabs .tab')].map((t) => ({
			session: !!t.dataset.path?.startsWith('session:'),
			label: t.querySelector('.label')?.textContent,
			active: t.classList.contains('active'),
			preview: t.classList.contains('preview'),
			dirty: !!t.querySelector('.dirty'),
		})),
	);
const labels = (t) => t.map((x) => x.label).join();
const shown = (t) => t.find((x) => x.active);
const files = (t) => t.filter((x) => !x.session);
const of = (t, label) => t.find((x) => x.label === label);

// A question is the dialog plugin's message command, which init.js notes in
// __vqLog before it is sent, routed or not: the messages asked since the
// log was n long.
const logLength = () => page.evaluate(() => window.__vqLog.length);
const asked = (n) => page.evaluate((n) => window.__vqLog.slice(n).filter((e) => e.cmd === 'plugin:dialog|message').map((e) => e.args.message), n);

// A character typed into the shown editor, once it has loaded.
const edit = async () => {
	const editor = page.locator('.file .text:not([hidden]) .monaco-editor');
	await editor.locator('.view-lines').waitFor({ timeout: 15000 });
	await editor.locator('.view-lines').click();
	await page.keyboard.type('x');
};

await step('preview', async () => {
	await repoSession.waitFor({ timeout: 10000 });
	await repoSession.click();
	await until(tabs, (t) => t.length === 1 && t[0].active);
	if ((await panel.count()) === 0) await page.locator('footer .files-toggle').click();
	await row('package.json').click();
	const t1 = await until(tabs, (t) => shown(t)?.label === 'package.json');
	await row('README.md').click();
	const t = await until(tabs, (t) => shown(t)?.label === 'README.md');
	const f = files(t);
	say(
		'one file tab, README.md, preview, where package.json was',
		f.length === 1 && f[0].label === 'README.md' && f[0].preview && f[0].active && t.indexOf(f[0]) === t1.findIndex((x) => x.label === 'package.json'),
		{ before: t1, after: t },
	);
	await shot(page, '01-preview');
});

await step('kept by a double-click', async () => {
	await tab('README.md').locator('button.name').dblclick();
	await row('package.json').click();
	const t = await until(tabs, (t) => files(t).length === 2 && shown(t)?.label === 'package.json');
	say('both tabs, only package.json preview', labels(files(t)) === 'README.md,package.json' && !of(t, 'README.md').preview && of(t, 'package.json').preview, t);
	const at = t.findIndex((x) => x.label === 'package.json');
	await row('.env').dblclick();
	const t2 = await until(tabs, (t) => shown(t)?.label === '.env' && !shown(t).preview);
	say(
		".env takes the preview's place and is no preview",
		t2.length === t.length && t2[at]?.label === '.env' && !t2[at].preview && !of(t2, 'package.json') && t2.every((x) => !x.preview),
		t2,
	);
});

await step('kept by an edit', async () => {
	await row('package.json').click();
	await until(tabs, (t) => shown(t)?.label === 'package.json' && shown(t).preview);
	await edit();
	const t = await until(tabs, (t) => of(t, 'package.json')?.dirty);
	say('package.json dirty and no preview', !!of(t, 'package.json')?.dirty && !of(t, 'package.json').preview, t);
	await row('logo.png').click();
	const t2 = await until(tabs, (t) => shown(t)?.label === 'logo.png');
	say('logo.png a new preview tab, package.json still there', !!of(t2, 'logo.png')?.preview && t2.length === t.length + 1 && !!of(t2, 'package.json')?.dirty, t2);
	await shot(page, '02-kept-by-an-edit');
});

await step('back to the one viewed before', async () => {
	await tab('README.md').locator('button.name').click();
	await until(tabs, (t) => shown(t)?.label === 'README.md');
	await tab('.env').locator('button.name').click();
	await until(tabs, (t) => shown(t)?.label === '.env');
	await tab('.env').locator('button.close').click();
	const t = await until(tabs, (t) => !of(t, '.env'));
	say('README.md active, not the first tab', shown(t)?.label === 'README.md' && !t[0].active, t);
});

await step('one question', async () => {
	await row('.gitignore').dblclick();
	await until(tabs, (t) => shown(t)?.label === '.gitignore');
	await edit();
	const t0 = await until(tabs, (t) => of(t, '.gitignore')?.dirty);
	const n = await logLength();
	await tab('package.json').locator('button.close').click();
	const q = await until(() => asked(n), (q) => q.length > 0);
	// The answer, Cancel, has come back once the tab would be gone.
	await sleep(500);
	const t = await tabs();
	say(
		'one question naming package.json, its tab kept',
		q.length === 1 && q[0] === 'package.json has unsaved changes. Close it?' && !!of(t, 'package.json'),
		{ asked: q, tabs: t },
	);
	const n2 = await logLength();
	await tab('README.md').click({ button: 'right' });
	await page.locator('.menu button[role="menuitem"]', { hasText: 'Close All' }).click();
	const q2 = await until(() => asked(n2), (q) => q.length > 0);
	await sleep(500);
	const t2 = await tabs();
	say(
		'Close All: one question for both, every tab kept, both still dirty',
		q2.length === 1 && q2[0] === '2 files have unsaved changes. Close them?' && labels(t2) === labels(t0) && !!of(t2, 'package.json')?.dirty && !!of(t2, '.gitignore')?.dirty,
		{ asked: q2, tabs: t2 },
	);
	await shot(page, '03-declined');
});

await step('accepted', async () => {
	// The question answered with its ok label, as the native dialog would.
	const accept = async (route) => {
		const { cmd } = JSON.parse(route.request().postData() ?? '{}');
		if (cmd !== 'plugin:dialog|message') return route.fallback();
		return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420' }, body: JSON.stringify({ ok: true, value: 'Close' }) });
	};
	await page.route('http://127.0.0.1:14999/invoke', accept);
	const n = await logLength();
	await tab('README.md').click({ button: 'right' });
	await page.locator('.menu button[role="menuitem"]', { hasText: 'Close All' }).click();
	const t = await until(tabs, (t) => files(t).length === 0);
	await page.unroute('http://127.0.0.1:14999/invoke', accept);
	const q = await asked(n);
	say(
		"the same question once; no file tab left, the session's tab there and active",
		q.length === 1 && q[0] === '2 files have unsaved changes. Close them?' && t.length === 1 && t[0].session && t[0].active,
		{ asked: q, tabs: t },
	);
	await shot(page, '04-accepted');
});

await browser.close();
process.exitCode = Math.min(finish(), 125);
