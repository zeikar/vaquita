// The frame around the content: ⌘B and the status line's buttons hiding the
// sidebar and the files panel, kept through a reload; no panel under the app
// welcome; an edge dragged resizing the terminal once, on release; and the
// status line's state, session count and report.
// node checks/layout.mjs <dir>, after run.sh up <dir>; see check.sh.
import path from 'node:path';
import { openApp, recorder, sleep, until } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node checks/layout.mjs <dir>');
	process.exit(2);
}
const { say, step, shot, finish } = recorder(path.join(dir, 'shots'));

const { browser, page } = await openApp({ width: 1440, height: 900 });
// Without WebGL2 xterm draws with its DOM renderer, whose screen element has
// the terminal's drawn width.
await page.addInitScript(() => {
	const get = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
		return type === 'webgl2' ? null : get.call(this, type, ...rest);
	};
});
await page.reload();

const sidebar = page.locator('main > aside:not(.files)');
const sessionRows = sidebar.locator('li:has(> button.row)');
const repoSession = sidebar.locator('li > button.row', { hasText: 'repo shell' });
const panel = page.locator('aside.files');
const sidebarToggle = page.locator('footer .sidebar-toggle');
const filesToggle = page.locator('footer .files-toggle');
const terminalFocused = () => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea'));

// main's classes and the widths it lays the columns out with.
const frame = () =>
	page.evaluate(() => {
		const m = document.querySelector('main');
		return {
			sidebarHidden: m.classList.contains('sidebar-hidden'),
			filesHidden: m.classList.contains('files-hidden'),
			sidebarWidth: m.style.getPropertyValue('--sidebar-width'),
			panelWidth: m.style.getPropertyValue('--panel-width'),
			panel: !!document.querySelector('aside.files'),
		};
	});
const stored = () =>
	page.evaluate(() =>
		Object.fromEntries(['vaquita.sidebar-hidden', 'vaquita.sidebar-width', 'vaquita.file-panel-hidden', 'vaquita.file-panel-width'].map((k) => [k.slice(8), localStorage.getItem(k)])),
	);
// The shown terminal's drawn width, which changes only when it is fitted.
const screenWidth = () =>
	page.evaluate(() => {
		const t = [...document.querySelectorAll('.term')].find((e) => e.offsetParent !== null);
		return t?.querySelector('.xterm-screen')?.getBoundingClientRect().width ?? null;
	});

// Pressed on an edge's middle and moved by dx; released by the caller.
const press = async (label, dx) => {
	const b = await page.locator(`[role="separator"][aria-label="${label}"]`).boundingBox();
	const y = b.y + b.height / 2;
	await page.mouse.move(b.x + b.width / 2, y);
	await page.mouse.down();
	await page.mouse.move(b.x + b.width / 2 + dx, y, { steps: 6 });
};

await repoSession.waitFor({ timeout: 10000 });
await repoSession.click();
await until(terminalFocused, Boolean);

await step('⌘B', async () => {
	await page.keyboard.press('Meta+b');
	const f = await until(frame, (f) => f.sidebarHidden, 3000);
	const s = { frame: f, stored: (await stored())['sidebar-hidden'], focused: await terminalFocused(), title: await sidebarToggle.getAttribute('title') };
	say('Meta+b hides the sidebar, stored, the terminal keeps the focus', f.sidebarHidden && s.stored === 'true' && s.focused && s.title.startsWith('Show sidebar'), s);
	await shot(page, '01-sidebar-hidden');
	await sidebarToggle.click();
	const f2 = await until(frame, (f) => !f.sidebarHidden, 3000);
	const s2 = { frame: f2, stored: (await stored())['sidebar-hidden'], title: await sidebarToggle.getAttribute('title') };
	say("the status line's left button shows it again, its title now Hide", !f2.sidebarHidden && s2.stored === 'false' && s2.title.startsWith('Hide sidebar'), s2);
});

await step('files panel', async () => {
	const before = await frame();
	await filesToggle.click();
	const f1 = await until(frame, (f) => !f.panel, 3000);
	const s1 = { frame: f1, stored: (await stored())['file-panel-hidden'], focused: await until(terminalFocused, Boolean, 3000), title: await filesToggle.getAttribute('title') };
	say("the right button unmounts aside.files, stored, the terminal focused", before.panel && !f1.panel && f1.filesHidden && s1.stored === 'true' && s1.focused && s1.title.startsWith('Show files'), s1);
	await filesToggle.click();
	const f2 = await until(frame, (f) => f.panel, 3000);
	say('and mounts it again, stored', f2.panel && !f2.filesHidden && (await stored())['file-panel-hidden'] === 'false', f2);
	await page.evaluate(() => window.__vqFire('tab', 'files'));
	const f3 = await until(frame, (f) => !f.panel, 3000);
	const s3 = { frame: f3, stored: (await stored())['file-panel-hidden'], focused: await until(terminalFocused, Boolean, 3000) };
	say("the menu's files action unmounts it, stored, the terminal focused", !f3.panel && s3.stored === 'true' && s3.focused, s3);
	await page.evaluate(() => window.__vqFire('tab', 'files'));
	const f4 = await until(frame, (f) => f.panel, 3000);
	say('and mounts it again, stored', f4.panel && (await stored())['file-panel-hidden'] === 'false', f4);
});

await step('reload', async () => {
	await page.keyboard.press('Meta+b');
	await until(frame, (f) => f.sidebarHidden, 3000);
	await page.reload();
	// The stored selection shows its tab, so there is a group and the panel.
	await repoSession.waitFor({ state: 'attached', timeout: 10000 });
	const f = await until(frame, (f) => f.sidebarHidden && f.panel);
	say('the sidebar hidden and the panel shown, after a reload', f.sidebarHidden && f.panel, f);
	await sidebarToggle.click();
	await until(frame, (f) => !f.sidebarHidden, 3000);
});

await step('app welcome', async () => {
	await page.evaluate(() => localStorage.removeItem('vaquita.selected'));
	await page.reload();
	await repoSession.waitFor({ timeout: 10000 });
	await page.locator('.hello').waitFor({ timeout: 5000 });
	const f = await frame();
	const s = { frame: f, stored: (await stored())['file-panel-hidden'] };
	say('no panel under the app welcome, though stored shown', !f.panel && f.filesHidden && s.stored === 'false', s);
	await shot(page, '02-app-welcome');
	await repoSession.click();
	const f2 = await until(frame, (f) => f.panel && !f.filesHidden);
	say('selecting repo shell brings it back', f2.panel && !f2.filesHidden, f2);
	await until(terminalFocused, Boolean);
});

await step('edge drag', async () => {
	const w0 = await until(screenWidth, (w) => w > 0);
	await press('Resize sidebar', 60);
	const held = await frame();
	await sleep(300);
	const w1 = await screenWidth();
	say('the sidebar 60 px wider, the terminal unchanged while held', held.sidebarWidth === '340px' && w1 === w0, { width: held.sidebarWidth, terminal: [w0, w1] });
	await page.mouse.up();
	const w2 = await until(screenWidth, (w) => w !== w0);
	const s = (await stored())['sidebar-width'];
	say('released: the terminal fitted, the width stored', w2 < w0 && s === '340', { terminal: [w0, w2], stored: s });
	await page.locator('[role="separator"][aria-label="Resize sidebar"]').dblclick();
	const f = await until(frame, (f) => f.sidebarWidth === '280px', 3000);
	say('a double-click sets 280 again', f.sidebarWidth === '280px' && (await stored())['sidebar-width'] === '280', { frame: f, stored: await stored() });

	const p0 = await until(screenWidth, (w) => w > w2);
	// The panel's edge is its left one: moving left widens it.
	await press('Resize files panel', -60);
	await sleep(300);
	const p1 = await screenWidth();
	const heldPanel = (await frame()).panelWidth;
	await page.mouse.up();
	const p2 = await until(screenWidth, (w) => w !== p0);
	const ps = (await stored())['file-panel-width'];
	say('the files panel likewise: the terminal held, fitted on release, the width stored', heldPanel === '320px' && p1 === p0 && p2 < p0 && ps === '320', { width: heldPanel, terminal: [p0, p1, p2], stored: ps });
	await shot(page, '03-edges');
});

await step('status line', async () => {
	const state = await page.locator('footer .state').innerText();
	const ok = await page.locator('footer .state .dot.ok').count();
	say('connected, its dot ok', state.trim() === 'connected' && ok === 1, { state, ok });
	const rows = await sessionRows.count();
	const count = await page.locator('footer > span', { hasText: / sessions$/ }).innerText();
	say("the session count is the sidebar's rows", count === `${rows} sessions`, { count, rows });
	await panel.locator('.tree button.row', { hasText: 'run.sh' }).click();
	const report = page.locator('footer button.report');
	await report.waitFor({ timeout: 5000 });
	const r = { text: await report.innerText(), cls: await report.getAttribute('class') };
	say('run.sh from the tree: a report, not an error', r.text.startsWith('revealed in Finder') && !r.cls.split(' ').includes('error'), r);
	await shot(page, '04-report');
	await report.click();
	const gone = await until(() => report.count(), (n) => n === 0, 3000);
	say('a click takes it away', gone === 0, { reports: gone });
});

await browser.close();
process.exitCode = Math.min(finish(), 125);
