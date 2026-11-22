// The keys a session's terminal and the tab bar take: ⌘← and ⌘→ go to the
// ends of the line being typed, a ⌘ press during a composition types nothing
// twice, ⌥⌘← and ⌥⌘→ step through the tabs, from the terminal and from a
// file's tab, ⌥⌘↑ and ⌥⌘↓ step through the repos and Other (also from an
// editor, which would add a cursor, and not under the new-session dialog), and
// ⌘⇧C and ⌘⇧X start Claude or Codex in the shown repo, or open the dialog on
// that kind where no repo is shown.
// node checks/keys.mjs <dir>, after run.sh up <dir>; see check.sh.
import path from 'node:path';
import { openApp, recorder, sleep, until } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node checks/keys.mjs <dir>');
	process.exit(2);
}
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
const active = () => page.evaluate(() => document.querySelector('.tabs .tab.active .label')?.textContent ?? null);
const dialog = page.locator('dialog[aria-labelledby="new-session-title"]');
const dialogOpen = () => dialog.evaluate((d) => d.open);
const sessionRows = sidebar.locator('li:has(> button.row)');
const tabs = () =>
	page.evaluate(() =>
		[...document.querySelectorAll('.tabs .tab')].map((t) => ({
			label: t.querySelector('.label')?.textContent,
			icon: t.querySelector('svg')?.getAttribute('data-icon'),
			active: t.classList.contains('active'),
		})),
	);
const terminalFocused = () => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea'));
// The last row of the shown terminal with text on it, nbsp as spaces.
const lastRow = () =>
	page.evaluate(() => {
		const term = [...document.querySelectorAll('.term')].find((t) => t.offsetParent !== null);
		const rows = [...(term?.querySelectorAll('.xterm-rows > div') ?? [])].map((r) => r.textContent.replace(/ /g, ' ').trimEnd());
		return rows.filter(Boolean).pop() ?? '';
	});

await sidebar.locator('li > button.row', { hasText: 'repo shell' }).waitFor({ timeout: 10000 });
await sidebar.locator('li > button.row', { hasText: 'repo shell' }).click();
await until(terminalFocused, Boolean);

await step('Meta+ArrowLeft and Meta+ArrowRight in the terminal', async () => {
	await page.keyboard.type('echo abc');
	let row = await until(lastRow, (r) => r.endsWith('echo abc'));
	say('typed at the prompt', row.endsWith('echo abc'), row);
	// What the hidden textarea holds is the input method's to go on replacing:
	// the caret must stay at its end, where WebKit's own ⌘← would take it away.
	const caret = () =>
		page.evaluate(() => {
			const t = document.activeElement;
			return { value: t.value, at: t.selectionStart };
		});
	const before = await caret();
	say('the hidden textarea holds something, its caret at the end', before.value.length > 0 && before.at === before.value.length, before);
	await page.keyboard.press('Meta+ArrowLeft');
	const after = await caret();
	say('Meta+ArrowLeft leaves that caret where it was', after.at === before.at && after.value === before.value, after);
	await page.keyboard.type('X');
	row = await until(lastRow, (r) => r.endsWith('Xecho abc'));
	say('Meta+ArrowLeft: the next key lands at the start of the line', row.endsWith('Xecho abc'), row);
	await page.keyboard.press('Meta+ArrowRight');
	await page.keyboard.type('Y');
	row = await until(lastRow, (r) => r.endsWith('Xecho abcY'));
	say('Meta+ArrowRight: and at its end', row.endsWith('Xecho abcY'), row);
	await page.keyboard.press('Shift+Meta+ArrowLeft');
	await page.keyboard.press('Meta+ArrowUp');
	const others = await caret();
	say('nor do Shift+Meta+ArrowLeft and Meta+ArrowUp move or select in it', others.at === others.value.length && (await page.evaluate(() => document.activeElement.selectionEnd)) === others.at, others);
	await shot(page, '01-line-ends');
	await page.keyboard.press('Control+u');
});

// In the released app the Korean input method composes with composition
// events, which xterm handles itself. Their order here is the one recorded
// there for 리, a ⌘ press and a space; no browser can drive the input method.
await step('Meta pressed while a syllable is composed', async () => {
	await page.evaluate(async () => {
		const ta = document.activeElement;
		const tick = () => new Promise((r) => setTimeout(r, 30));
		const compose = (type, data) => ta.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
		const base = ta.value;
		compose('compositionstart', '');
		for (const text of ['ㄹ', '리']) {
			ta.value = base + text;
			compose('compositionupdate', text);
			await tick();
		}
		ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', code: 'MetaLeft', keyCode: 91, metaKey: true, isComposing: true, bubbles: true }));
		ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', code: 'MetaLeft', keyCode: 91, isComposing: true, bubbles: true }));
		await tick();
		ta.value = base + '리 ';
		compose('compositionupdate', '리 ');
		compose('compositionend', '리 ');
		await tick();
	});
	const row = await until(lastRow, (r) => r.includes('리'));
	await sleep(300);
	const after = await lastRow();
	say('the syllable is typed once', /\$ 리$/.test(after), { row, after });
	await page.keyboard.press('Control+u');
});

await step('Alt+Meta+ArrowLeft and Alt+Meta+ArrowRight step through the tabs', async () => {
	if ((await panel.count()) === 0) await page.locator('footer .files-toggle').click();
	await panel.locator('.tree button.row', { hasText: 'README.md' }).dblclick();
	let a = await until(active, (l) => l === 'README.md');
	say('a file tab beside the session', a === 'README.md', a);
	await page.keyboard.press('Alt+Meta+ArrowLeft');
	a = await until(active, (l) => l === 'repo shell', 3000);
	say('Alt+Meta+ArrowLeft from the file: the session', a === 'repo shell' && (await until(terminalFocused, Boolean, 3000)), a);
	await page.keyboard.press('Alt+Meta+ArrowRight');
	a = await until(active, (l) => l === 'README.md', 3000);
	say('Alt+Meta+ArrowRight from the terminal: the file', a === 'README.md', a);
	await page.keyboard.press('Alt+Meta+ArrowRight');
	a = await until(active, (l) => l === 'repo shell', 3000);
	say('and round to the first again', a === 'repo shell', a);
	await sleep(200);
	const row = await lastRow();
	say('nothing was typed into the terminal', !/[\[;]\d*[CD]|\^\[/.test(row), row);
});

await step('Alt+Meta+ArrowDown and Alt+Meta+ArrowUp step through the repos and Other', async () => {
	await page.keyboard.press('Alt+Meta+ArrowDown');
	let a = await until(active, (l) => l === 'tmp shell', 3000);
	say('Alt+Meta+ArrowDown from the repo: Other, tmp shell active, its terminal focused', a === 'tmp shell' && (await until(terminalFocused, Boolean, 3000)), a);
	await shot(page, '02-other');
	await page.keyboard.press('Alt+Meta+ArrowDown');
	a = await until(active, (l) => l === 'repo shell', 3000);
	say('again wraps to the repo, repo shell viewed last there', a === 'repo shell' && (await until(terminalFocused, Boolean, 3000)), a);
	say('not its welcome', (await page.locator('.repo-hello').count()) === 0, a);
	await page.keyboard.press('Alt+Meta+ArrowUp');
	a = await until(active, (l) => l === 'tmp shell', 3000);
	say('Alt+Meta+ArrowUp wraps back to Other', a === 'tmp shell', a);
	await page.keyboard.press('Alt+Meta+ArrowDown');
	await until(active, (l) => l === 'repo shell', 3000);
	await sleep(200);
	const row = await lastRow();
	say('nothing was typed into either terminal', !/[\[;]\d*[ABCD]|\^\[/.test(row), row);
});

await step('Alt+Meta+ArrowDown and Alt+Meta+ArrowUp from an editor', async () => {
	if ((await panel.count()) === 0) await page.locator('footer .files-toggle').click();
	await panel.locator('.tree button.row', { hasText: 'package.json' }).dblclick();
	await page.locator('.monaco-editor').first().waitFor({ timeout: 10000 });
	await page.locator('.monaco-editor .view-lines').first().click();
	let a = await until(active, (l) => l === 'package.json', 3000);
	say('package.json shown, the editor clicked', a === 'package.json', a);
	await page.keyboard.press('Alt+Meta+ArrowDown');
	a = await until(active, (l) => l === 'tmp shell', 3000);
	say('Alt+Meta+ArrowDown from the editor: Other', a === 'tmp shell', a);
	await page.keyboard.press('Alt+Meta+ArrowUp');
	a = await until(active, (l) => l === 'package.json', 3000);
	say('Alt+Meta+ArrowUp comes back to package.json', a === 'package.json', a);
	await sleep(200);
	const cursors = await page.locator('.monaco-editor:visible .cursor').count();
	say('the editor shows one cursor', cursors === 1, cursors);
	await page.keyboard.press('Alt+Meta+ArrowLeft');
	await until(active, (l) => l !== 'package.json', 3000);
});

await step('the repo keys under the new-session dialog', async () => {
	const rows = await sessionRows.count();
	const before = await active();
	await page.keyboard.press('Meta+t');
	say('Meta+t opens the dialog', await until(dialogOpen, (o) => o, 3000), 'open');
	await page.keyboard.press('Alt+Meta+ArrowDown');
	await page.keyboard.press('Shift+Meta+C');
	await sleep(300);
	const a = await active();
	say('Alt+Meta+ArrowDown and Shift+Meta+C switch nothing and add no row', a === before && (await dialogOpen()) && (await sessionRows.count()) === rows, { a, rows: await sessionRows.count() });
	await page.keyboard.press('Escape');
	say('Escape closes it', await until(dialogOpen, (o) => !o, 3000).then((o) => !o), 'closed');
});

await step('Shift+Meta+C and Shift+Meta+X start an agent', async () => {
	const rows = await sessionRows.count();
	await page.keyboard.press('Shift+Meta+C');
	let n = await until(() => sessionRows.count(), (c) => c === rows + 1);
	let t = await until(tabs, (l) => l.at(-1)?.icon === 'claude' && l.at(-1)?.active, 3000);
	say('Shift+Meta+C in the repo: a row, a last active claude tab, no dialog', n === rows + 1 && t.at(-1)?.active && t.at(-1)?.icon === 'claude' && !(await dialogOpen()), { rows: n, tabs: t });
	await page.keyboard.press('Shift+Meta+X');
	n = await until(() => sessionRows.count(), (c) => c === rows + 2);
	t = await until(tabs, (l) => l.at(-1)?.icon === 'openai' && l.at(-1)?.active, 3000);
	say('Shift+Meta+X likewise, openai icon', n === rows + 2 && t.at(-1)?.active && t.at(-1)?.icon === 'openai' && !(await dialogOpen()), { rows: n, tabs: t });
	await shot(page, '03-started');
	await page.keyboard.press('Alt+Meta+ArrowDown');
	await until(active, (l) => l === 'tmp shell', 3000);
	await page.keyboard.press('Shift+Meta+C');
	const opened = await until(dialogOpen, (o) => o, 3000);
	const checked = await dialog.locator('input[type=radio][value="claude"]').isChecked();
	say('with Other shown, Shift+Meta+C opens the dialog on Claude, adds no row', opened && checked && (await sessionRows.count()) === rows + 2, { opened, checked });
	await page.keyboard.press('Escape');
	await until(dialogOpen, (o) => !o, 3000);
});

await step('with the app welcome shown', async () => {
	await page.evaluate(() => localStorage.removeItem('vaquita.selected'));
	await page.reload();
	await sidebar.locator('li > button.row', { hasText: 'repo shell' }).waitFor({ timeout: 10000 });
	await sleep(500);
	await page.keyboard.press('Shift+Meta+X');
	const opened = await until(dialogOpen, (o) => o, 3000);
	const checked = await dialog.locator('input[type=radio][value="codex"]').isChecked();
	say('Shift+Meta+X opens the dialog on Codex', opened && checked, { opened, checked });
	await page.keyboard.press('Escape');
	await until(dialogOpen, (o) => !o, 3000);
	await page.keyboard.press('Alt+Meta+ArrowDown');
	const hello = await until(() => page.locator('.repo-hello').count(), (c) => c > 0, 3000);
	say('Alt+Meta+ArrowDown shows the repo welcome, as the reload began a new run with none viewed', hello > 0, hello);
	await shot(page, '04-repo-welcome');
	await page.keyboard.press('Alt+Meta+ArrowUp');
	const a = await until(active, (l) => l === 'tmp shell', 3000);
	say('Alt+Meta+ArrowUp then shows Other', a === 'tmp shell', a);
});

await browser.close();
process.exit(finish() ? 1 : 0);
