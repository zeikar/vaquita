// Coming back to a file's tab finds the place you left, in the editor and in
// the Markdown preview, from another file's tab, from a session's tab and
// after the file changed on disk; a code block's copy button; and the
// preview's images, which keep the place too.
// node checks/reading.mjs <dir>, after run.sh up <dir>; see check.sh.
import fs from 'node:fs';
import path from 'node:path';
import { openApp, recorder, sleep, until } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node checks/reading.mjs <dir>');
	process.exit(2);
}
const repo = path.join(fs.realpathSync(dir), 'repo');
const { say, step, shot, finish } = recorder(path.join(dir, 'shots'));

// Long lines, as word wrap is what a layout at no width upsets.
const code = (from, n) => Array.from({ length: n }, (_, i) => `const line${from + i} = '${'x'.repeat(200)}';`).join('\n') + '\n';
fs.writeFileSync(path.join(repo, 'long.ts'), code(1, 800));
fs.writeFileSync(path.join(repo, 'other.ts'), code(1, 800));
const paragraphs = Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
fs.writeFileSync(path.join(repo, 'long.md'), '# Long\n\n```sh\necho one\necho two\n```\n\n' + paragraphs + '\n');
// logo.png is run.sh's; a copy beside the repo is outside it.
fs.copyFileSync(path.join(repo, 'logo.png'), path.join(repo, '..', 'outside.png'));
fs.writeFileSync(
	path.join(repo, 'docs', 'pictures.md'),
	'# Pictures\n\n![The logo](../logo.png)\n\n[![build](https://example.com/badge.svg)](https://example.com)\n\n![Outside](../../outside.png)\n\n' + paragraphs + '\n',
);

const { browser, page } = await openApp({ width: 1440, height: 900 });
// Every URL the page asked for, to see that a file's web image was not one.
const asked = [];
page.on('request', (r) => asked.push(r.url()));
const sidebar = page.locator('main > aside:not(.files)');
const panel = page.locator('aside.files');
const tab = (label) => page.locator('.tabs .tab', { hasText: label });
const open = (name) => panel.locator('.tree button.row', { hasText: name }).dblclick();

// The first line number in view, as the editor shows it.
const firstLine = () =>
	page.evaluate(() => {
		const ed = [...document.querySelectorAll('.monaco-editor')].find((e) => e.offsetParent !== null);
		if (!ed) return null;
		const top = ed.getBoundingClientRect().top;
		// A wrapped line's further rows have no number.
		const rows = [...ed.querySelectorAll('.line-numbers')].filter((n) => n.textContent !== '' && n.getBoundingClientRect().top >= top - 1);
		return rows.length ? Math.min(...rows.map((n) => Number(n.textContent))) : null;
	});
const markdownTop = () => page.evaluate(() => document.querySelector('.markdown')?.scrollTop ?? null);
const wheel = async (selector, y) => {
	const box = await page.locator(selector).first().boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, y);
	await sleep(300);
};

await page.locator('main > aside:not(.files) li > button.row', { hasText: 'repo shell' }).waitFor({ timeout: 10000 });
await sidebar.locator('li > button.row', { hasText: 'repo shell' }).click();
if ((await panel.count()) === 0) await page.locator('footer .files-toggle').click();

let line;
await step('the editor keeps its place', async () => {
	await open('long.ts');
	await until(firstLine, (l) => l === 1, 15000);
	await wheel('.monaco-editor', 9000);
	line = await firstLine();
	say('scrolled down', line > 20, { line });

	await open('other.ts');
	await until(firstLine, (l) => l === 1);
	await tab('long.ts').click();
	let back = await until(firstLine, (l) => l === line);
	say('from another file’s tab', back === line, { line, back });

	await tab('repo shell').click();
	await sleep(300);
	await tab('long.ts').click();
	back = await until(firstLine, (l) => l === line);
	say('from a session’s tab', back === line, { line, back });

	await tab('repo shell').click();
	await sleep(300);
	fs.appendFileSync(path.join(repo, 'long.ts'), '// added while away\n');
	await tab('long.ts').click();
	await sleep(800);
	back = await until(firstLine, (l) => l === line);
	say('after the file changed on disk', back === line, { line, back });
	await shot(page, '01-editor-back');
});

let top;
await step('the Markdown preview keeps its place', async () => {
	await open('long.md');
	await page.locator('.markdown .body pre').first().waitFor();
	await wheel('.markdown', 2500);
	top = await markdownTop();
	say('scrolled down', top > 500, { top });

	await tab('other.ts').click();
	await until(firstLine, (l) => l !== null);
	await tab('long.md').click();
	await page.locator('.markdown .body pre').first().waitFor();
	let back = await until(markdownTop, (t) => t === top);
	say('from another file’s tab', back === top, { top, back });

	await tab('repo shell').click();
	await sleep(300);
	await tab('long.md').click();
	await page.locator('.markdown .body pre').first().waitFor();
	back = await until(markdownTop, (t) => t === top);
	say('from a session’s tab', back === top, { top, back });

	// The editor sat hidden, its model still in it, under the preview.
	await tab('long.ts').click();
	const edited = await until(firstLine, (l) => l === line);
	say('the editor, from the preview’s tab', edited === line, { line, edited });
	await tab('long.md').click();
	await page.locator('.markdown .body pre').first().waitFor();
});

await step('a code block has a copy button', async () => {
	await page.mouse.move(0, 0);
	await page.locator('.markdown').evaluate((m) => (m.scrollTop = 0));
	const block = page.locator('.markdown .body .code').first();
	const button = block.locator('button.copy');
	const opacity = () => button.evaluate((b) => getComputedStyle(b).opacity);
	say('hidden until the block is hovered', (await until(opacity, (o) => o === '0')) === '0', await opacity());
	await block.hover();
	say('shown on hover', (await until(opacity, (o) => o === '1')) === '1', await opacity());
	await shot(page, '02-copy-button');
	await button.click();
	const written = await until(
		() => page.evaluate(() => window.__vqLog.filter((c) => c.cmd.includes('clipboard')).map((c) => c.args)),
		(w) => w.length === 1,
	);
	say('copies the block’s text', JSON.stringify(written).includes('echo one\\necho two"'), written);
	const icon = () => button.locator('svg').getAttribute('data-icon');
	say('says it was copied', (await until(icon, (i) => i === 'check')) === 'check', await icon());
	await shot(page, '03-copied');
});

await step('the source keeps its place when the preview reads a changed file', async () => {
	await page.locator('button[aria-label="Source"]').click();
	await until(firstLine, (l) => l === 1);
	await wheel('.monaco-editor', 2000);
	const box = await page.locator('.monaco-editor').first().boundingBox();
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	// The cursor's line, when it is in view.
	const cursor = () => page.evaluate(() => document.querySelector('.monaco-editor .active-line-number')?.textContent ?? null);
	const from = await until(cursor, (c) => c !== null);
	say('a cursor down in the source', Number(from) > 20, { from });
	fs.appendFileSync(path.join(repo, 'long.md'), '\nAdded while away.\n');
	await page.locator('button[aria-label="Preview"]').click();
	await page.locator('.markdown .body pre').first().waitFor();
	await sleep(500);
	await page.locator('button[aria-label="Source"]').click();
	const back = await until(cursor, (c) => c === from);
	say('the cursor is where it was', back === from, { from, back });
});

await step('the preview shows the images of its repo, and keeps its place under them', async () => {
	await panel.locator('.tree button.row', { hasText: 'docs' }).click();
	await open('pictures.md');
	const img = page.locator('.markdown .body img');
	await img.waitFor();
	const size = await until(
		() => img.evaluate((i) => ({ natural: i.naturalWidth, height: Math.round(i.getBoundingClientRect().height) })),
		(s) => s.natural > 0,
	);
	say('an image inside the repo, named from a folder below, loads', size.natural > 0 && size.height > 100, size);
	const texts = await page.locator('.markdown .body span[title]').evaluateAll((spans) => spans.map((s) => [s.textContent, s.title, !!s.closest('a')]));
	say(
		'a web image and one outside the repo show as their alt text, with the reason',
		texts.length === 2 && texts[0][0] === 'build' && texts[0][2] && /only images from files/.test(texts[0][1]) && texts[1][0] === 'Outside' && /outside the file's repo/.test(texts[1][1]),
		texts,
	);
	say('the page asked the web for nothing', !asked.some((u) => u.includes('example.com')), asked.filter((u) => u.includes('example.com')));
	await shot(page, '04-images');

	// The paragraph at the top of the view, which the image above must not move.
	const reading = () =>
		page.evaluate(() => {
			const view = document.querySelector('.markdown');
			const top = view.getBoundingClientRect().top;
			const p = [...view.querySelectorAll('.body p')].find((p) => p.getBoundingClientRect().bottom > top);
			return { top: view.scrollTop, at: p?.textContent ?? null };
		});
	await wheel('.markdown', 2500);
	const left = await reading();
	say('scrolled down, past the image', left.top > size.height, left);
	await tab('other.ts').click();
	await until(firstLine, (l) => l !== null);
	await tab('pictures.md').click();
	await img.waitFor();
	await until(() => img.evaluate((i) => i.naturalWidth), (n) => n > 0);
	const back = await until(reading, (r) => r.top === left.top && r.at === left.at);
	say('back at the same paragraph once the image has loaded again', back.top === left.top && back.at === left.at, { left, back });
});

await browser.close();
process.exit(finish() ? 1 : 0);
