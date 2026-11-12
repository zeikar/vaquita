// The keys a session's terminal and the tab bar take: ⌘← and ⌘→ go to the
// ends of the line being typed, a ⌘ press during a composition types nothing
// twice, and ⌥⌘← and ⌥⌘→ step through the tabs, from the terminal and from a
// file's tab.
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

await browser.close();
process.exit(finish() ? 1 : 0);
