// The keys a session's terminal and the tab bar take: ⌘← and ⌘→ go to the
// ends of the line being typed, a ⌘ press during a composition types nothing
// twice, ⌥⌘← and ⌥⌘→ step through the tabs, from the terminal and from a
// file's tab, ⌥⌘↑ and ⌥⌘↓ step through the repos and Other (also from an
// editor, which would add a cursor, and not under the new-session dialog), and
// ⌘⇧C and ⌘⇧X start Claude or Codex in the shown repo, or open the dialog on
// that kind where no repo is shown. The shortcut list holds the focus and
// the keys while it is open, closes on Escape, a backdrop click and the
// menu's close, scrolls inside itself in a short window, and opens from the
// app welcome.
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
// Mounted only while open.
const list = page.locator('dialog[aria-labelledby="shortcuts-title"]');
const listOpen = async () => (await list.count()) > 0 && (await list.evaluate((d) => d.open));
const focusInList = () => page.evaluate(() => !!document.activeElement?.closest('dialog[aria-labelledby="shortcuts-title"]'));
const openList = async () => {
	await page.evaluate(() => window.__vqFire('tab', 'shortcuts'));
	return until(listOpen, Boolean, 3000);
};
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

await step('the shortcut list over a terminal', async () => {
	await sidebar.locator('li > button.row', { hasText: 'repo shell' }).click();
	await until(active, (l) => l === 'repo shell', 3000);
	await until(terminalFocused, Boolean, 3000);
	const before = { active: await active(), tabs: await tabs(), rows: await sessionRows.count(), row: await lastRow() };
	say('the menu item opens the list, the focus inside it', (await openList()) && (await until(focusInList, Boolean, 3000)), 'open');
	await shot(page, '05-shortcut-list');
	const ring = () => page.evaluate(() => getComputedStyle(document.querySelector('dialog[aria-labelledby="shortcuts-title"] .scroller')).outlineStyle);
	const rings = [await ring()];
	await page.keyboard.press('Tab');
	await page.keyboard.press('Tab');
	rings.push(await ring());
	say('its scroller shows no ring on open, and one once Tab came round to it', rings[0] === 'none' && rings[1] === 'solid', rings);
	await page.keyboard.type('qz');
	await sleep(300);
	let row = await lastRow();
	say('keys typed under it reach no terminal', row === before.row, row);
	await page.keyboard.press('Meta+1');
	await page.keyboard.press('Alt+Meta+ArrowDown');
	await page.keyboard.press('Meta+t');
	await sleep(300);
	const under = { active: await active(), rows: await sessionRows.count(), dialog: await dialogOpen(), list: await listOpen(), focus: await focusInList() };
	say('Meta+1, Alt+Meta+ArrowDown and Meta+t switch and open nothing', under.active === before.active && under.rows === before.rows && !under.dialog && under.list && under.focus, under);
	await page.keyboard.press('Escape');
	const gone = await until(() => list.count(), (c) => c === 0, 3000);
	say('Escape closes it, the terminal focused again', gone === 0 && (await until(terminalFocused, Boolean, 3000)), { gone });
	await page.keyboard.type('W');
	row = await until(lastRow, (r) => r.endsWith('W'), 3000);
	say('a typed key lands on its row', row.startsWith(before.row) && row.length > before.row.length && row.endsWith('W'), row);
	await page.keyboard.press('Control+u');

	await openList();
	const box = await list.boundingBox();
	await page.mouse.click(box.x + 4, box.y + box.height / 2);
	await list.locator('#shortcuts-title').click();
	await list.locator('li').first().click();
	await sleep(200);
	say('clicks on its own padding, its title and a row leave it open, the focus in it', (await listOpen()) && (await focusInList()), box);
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(2, 2);
	await page.mouse.up();
	await sleep(200);
	say('a press inside it released on the backdrop leaves it open', await listOpen(), 'open');
	await page.mouse.click(2, 2);
	const out = await until(() => list.count(), (c) => c === 0, 3000);
	say('a click on the backdrop closes it, the terminal focused again', out === 0 && (await until(terminalFocused, Boolean, 3000)), { out });

	await openList();
	await page.evaluate(() => window.__vqFire('tab', 'close'));
	const closed = await until(() => list.count(), (c) => c === 0, 3000);
	await sleep(200);
	const after = await tabs();
	say("the menu's close closes the list and nothing else", closed === 0 && JSON.stringify(after) === JSON.stringify(before.tabs), { closed, after });
});

// At 900 × 420 it fits; at 300 high its rows overflow and scroll.
await step('the shortcut list in a short window', async () => {
	const size = page.viewportSize();
	const geo = () =>
		page.evaluate(() => {
			const d = document.querySelector('dialog[aria-labelledby="shortcuts-title"]');
			const r = (el) => el.getBoundingClientRect();
			const s = d.querySelector('.scroller');
			// The lowest row, in whichever column.
			const last = [...d.querySelectorAll('li')].reduce((a, b) => (r(b).bottom > r(a).bottom ? b : a));
			return { dialog: r(d), title: r(d.querySelector('#shortcuts-title')), scroller: r(s), top: s.scrollTop, overflows: s.scrollHeight > s.clientHeight, last: r(last), lastText: last.textContent };
		});
	const scrollToLast = () =>
		page.evaluate(() => {
			const rows = [...document.querySelectorAll('dialog[aria-labelledby="shortcuts-title"] li')];
			rows.reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a)).scrollIntoView({ block: 'nearest' });
		});
	const inside = (a, b) => a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5 && a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
	try {
		for (const height of [420, 300]) {
			await page.setViewportSize({ width: 900, height });
			const view = { top: 0, left: 0, bottom: height, right: 900 };
			await openList();
			let g = await geo();
			say(`at 900 × ${height} the list fits the window, its title shown`, inside(g.dialog, view) && inside(g.title, g.dialog), g);
			await shot(page, `06-shortcut-list-${height}`);
			await scrollToLast();
			g = await geo();
			const scrolled = height === 420 || (g.overflows && g.top > 0);
			say(`its lowest row is in view inside the list, the title still shown${height === 300 ? ', scrolled there' : ''}`, scrolled && inside(g.last, g.scroller) && inside(g.title, view), g);
			if (height === 300) await shot(page, '06-shortcut-list-300-scrolled');
			await page.keyboard.press('Escape');
			await until(() => list.count(), (c) => c === 0, 3000);
		}
		await openList();
		const top = (await geo()).top;
		say('reopened, it is at the top again', top === 0, top);
		await page.keyboard.press('Escape');
		await until(() => list.count(), (c) => c === 0, 3000);
	} finally {
		await page.setViewportSize(size);
	}
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

await step('the shortcut list from the app welcome', async () => {
	await page.evaluate(() => localStorage.removeItem('vaquita.selected'));
	await page.reload();
	await sidebar.locator('li > button.row', { hasText: 'repo shell' }).waitFor({ timeout: 10000 });
	const hello = page.locator('.hello');
	await hello.waitFor({ timeout: 5000 });
	await hello.locator('button.act', { hasText: 'Keyboard shortcuts' }).click();
	say('its Keyboard shortcuts row opens the list', await until(listOpen, Boolean, 3000), 'open');
	await shot(page, '07-shortcut-list-welcome');
	await page.keyboard.press('Escape');
	const gone = await until(() => list.count(), (c) => c === 0, 3000);
	const inHello = await until(() => page.evaluate(() => !!document.activeElement?.closest('.hello')), Boolean, 3000);
	say('Escape closes it, the focus inside the welcome', gone === 0 && inHello, { gone, inHello });
});

await browser.close();
process.exit(finish() ? 1 : 0);
