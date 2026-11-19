// A path in the terminal's output is a link only when it is on the disk: it
// shows its target on hover when it exists and nothing when it does not, a
// shell variable is a path only when its command assigns it and the expansion
// exists, the disk is asked once for a row and then not again for a while, and
// a web link beside a path still links. A bare file name links to the one file
// of that name in the repo, asked once for a row and then cached, and not when
// two files share it or only an ignored folder has it; the starting folder's
// own file counts with the repo's, an ignored one too.
// node checks/links.mjs <dir>, after run.sh up <dir>; see check.sh.
import fs from 'node:fs';
import path from 'node:path';
import { bridgeLog, openApp, recorder, sleep, until } from './lib.mjs';

const dir = process.argv[2];
if (!dir) {
	console.error('usage: node checks/links.mjs <dir>');
	process.exit(2);
}
const { say, step, shot, finish } = recorder(path.join(dir, 'shots'));
const bridge = bridgeLog(dir);
// The session starts in the canonical path (the temp folder is a symlink on macOS).
const repo = fs.realpathSync(path.join(dir, 'repo'));

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
const terminalFocused = () => page.evaluate(() => !!document.activeElement?.classList.contains('xterm-helper-textarea'));
const shownTerm = `[...document.querySelectorAll('.term')].find((t) => t.offsetParent !== null)`;
const rowTexts = () =>
	page.evaluate(`(${shownTerm})?.querySelectorAll('.xterm-rows > div') ? [...${shownTerm}.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent.replace(/\\u00a0/g, ' ').trimEnd()) : []`);
// The last row that is exactly `text`: the echo's output, not the typed command
// (which has the prompt and the echo in front of it).
const outputRow = async (text) => {
	const rows = await rowTexts();
	return rows.lastIndexOf(text);
};
// Moves the mouse onto `text` in row `index`, the box from a DOM Range.
async function hover(index, text) {
	const box = await page.evaluate(
		({ index, text }) => {
			const term = [...document.querySelectorAll('.term')].find((t) => t.offsetParent !== null);
			const row = term.querySelectorAll('.xterm-rows > div')[index];
			const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
			// Text nodes are split by spans; find the one run holding `text`.
			const nodes = [];
			for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
			const whole = nodes.map((n) => n.data).join('').replace(/ /g, ' ');
			const at = whole.indexOf(text);
			if (at < 0) return null;
			const find = (offset) => {
				let left = offset;
				for (const n of nodes) {
					if (left < n.data.length) return [n, left];
					left -= n.data.length;
				}
			};
			const [a, ao] = find(at);
			const [b, bo] = find(at + text.length - 1);
			const range = document.createRange();
			range.setStart(a, ao);
			range.setEnd(b, bo + 1);
			const r = range.getBoundingClientRect();
			return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
		},
		{ index, text },
	);
	if (!box) throw new Error(`no ${text} in row ${index}`);
	// A jiggle: xterm only looks at real moves.
	await page.mouse.move(box.x - 2, box.y);
	await page.mouse.move(box.x, box.y, { steps: 2 });
}
// What the hover handler set on the terminal's container.
const title = () => page.evaluate(`${shownTerm}?.title ?? null`);
// Off the row, onto another one, so the next hover asks again.
async function leaveRow(index) {
	const rows = await rowTexts();
	await hover(index === 0 ? 1 : 0, rows[index === 0 ? 1 : 0] || ' ').catch(() => {});
	await page.mouse.move(700, 800);
	await sleep(150);
}
const type = async (line) => {
	await page.keyboard.type(line);
	await page.keyboard.press('Enter');
};
const calls = (off) => bridge.since(off).filter((l) => l.startsWith('invoke paths_exist'));
const nameCalls = (off) => bridge.since(off).filter((l) => l.startsWith('invoke find_names'));

await sidebar.locator('li > button.row', { hasText: 'repo shell' }).waitFor({ timeout: 10000 });
await sidebar.locator('li > button.row', { hasText: 'repo shell' }).click();
await until(terminalFocused, Boolean);

await step('an existing path links, a missing one does not', async () => {
	await type('echo docs/guide.md docs/missing.md');
	const out = 'docs/guide.md docs/missing.md';
	const i = await until(() => outputRow(out), (n) => n >= 0);
	say('the output row is there', i >= 0, i);
	await hover(i, 'docs/guide.md');
	const t = await until(title, Boolean, 3000);
	say('hovering the existing path shows its file', t === path.join(repo, 'docs/guide.md'), t);
	await shot(page, '01-existing');
	await leaveRow(i);
	await hover(i, 'docs/missing.md');
	await sleep(600);
	const m = await title();
	say('hovering the missing one shows nothing', m === '', m);
});

await step('a shell variable nothing assigns is no path', async () => {
	await type(`echo '"$S/battle_b_frames.png"'`);
	const out = '"$S/battle_b_frames.png"';
	const i = await until(() => outputRow(out), (n) => n >= 0);
	say('the output row is there', i >= 0, i);
	await hover(i, '$S/battle_b_frames.png');
	await sleep(600);
	const t = await title();
	say('hovering it shows nothing', t === '', t);
});

await step('a shell variable its command assigns links as its expansion', async () => {
	await type(`echo 'S=./docs && cat "$S/guide.md" "$S/missing.md"'`);
	const out = 'S=./docs && cat "$S/guide.md" "$S/missing.md"';
	const i = await until(() => outputRow(out), (n) => n >= 0);
	say('the output row is there', i >= 0, i);
	await hover(i, '$S/guide.md');
	const t = await until(title, Boolean, 3000);
	// Not path.join: the expansion keeps the ./ of the value, as the app hands it on.
	say('hovering it shows the expanded file', t === `${repo}/./docs/guide.md`, t);
	await shot(page, '02-variable');
	await leaveRow(i);
	await hover(i, '$S/missing.md');
	await sleep(600);
	const m = await title();
	say('hovering a missing expansion shows nothing', m === '', m);
});

// Paths of their own: the first step left docs/guide.md cached.
let row;
await step('one call per row, then the cache', async () => {
	const out = 'src/lib/util.ts src/lib/later.ts';
	await type('echo src/lib/util.ts src/lib/later.ts');
	await sleep(300);
	row = await outputRow(out);
	await leaveRow(row);
	const off = bridge.offset();
	await hover(row, 'src/lib/util.ts');
	await until(title, Boolean, 3000);
	const first = calls(off);
	say('the first hover of the row asks the disk once', first.length === 1, first);
	await leaveRow(row);
	const off2 = bridge.offset();
	await hover(row, 'src/lib/util.ts');
	await until(title, Boolean, 3000);
	await sleep(300);
	const again = calls(off2);
	say('coming back within 5 s asks nothing', again.length === 0, again);
});

await step('a file created later links', async () => {
	fs.writeFileSync(path.join(repo, 'src/lib/later.ts'), 'example\n');
	await sleep(6000);
	await leaveRow(row);
	await hover(row, 'src/lib/later.ts');
	const t = await until(title, Boolean, 3000);
	say('the file now shows', t === path.join(repo, 'src/lib/later.ts'), t);
});

await step('a web link beside a path still links', async () => {
	await type('echo https://example.com/a src/index.ts');
	const out = 'https://example.com/a src/index.ts';
	const i = await until(() => outputRow(out), (n) => n >= 0);
	await leaveRow(i);
	const off = bridge.offset();
	await hover(i, 'https://example.com/a');
	const t = await until(title, Boolean, 3000);
	await sleep(300);
	say('the URL shows as the title', t === 'https://example.com/a', t);
	const c = calls(off);
	say('the row asked the disk once', c.length === 1, c);
	await shot(page, '03-url-and-path');
});

await step('a bare file name links to the one file in the repo that has it', async () => {
	// A twin of src/index.ts, untracked and not ignored, so git lists both.
	fs.writeFileSync(path.join(repo, 'docs/index.ts'), 'example\n');
	const out = 'util.ts:12 index.ts index.js';
	await type(`echo ${out}`);
	const i = await until(() => outputRow(out), (n) => n >= 0);
	say('the output row is there', i >= 0, i);
	await leaveRow(i);
	const off = bridge.offset();
	await hover(i, 'util.ts:12');
	const t = await until(title, Boolean, 3000);
	say('hovering the name shows the one file of that name', t === path.join(repo, 'src/lib/util.ts'), t);
	await sleep(300);
	const asked = nameCalls(off);
	say('the row asks for its names once', asked.length === 1, asked);
	say('and asks the disk nothing', calls(off).length === 0, calls(off));
	await shot(page, '04-name');
	await leaveRow(i);
	const off2 = bridge.offset();
	await hover(i, 'util.ts:12');
	await until(title, Boolean, 3000);
	await sleep(300);
	const again = nameCalls(off2);
	say('coming back at once asks nothing', again.length === 0, again);
	await leaveRow(i);
	await hover(i, 'index.ts');
	await sleep(600);
	const shared = await title();
	say('a name two files share shows nothing', shared === '', shared);
	await leaveRow(i);
	await hover(i, 'index.js');
	await sleep(600);
	const ignored = await title();
	say('a name only an ignored folder has shows nothing', ignored === '', ignored);
});

await step("the starting folder's own file counts with the repo's", async () => {
	const out = 'README.md .env';
	await type(`echo ${out}`);
	const i = await until(() => outputRow(out), (n) => n >= 0);
	say('the output row is there', i >= 0, i);
	await leaveRow(i);
	await hover(i, 'README.md');
	await sleep(600);
	const shared = await title();
	say('README.md, which src/lib has too, shows nothing', shared === '', shared);
	await leaveRow(i);
	await hover(i, '.env');
	const t = await until(title, Boolean, 3000);
	say('.env, ignored and only in the starting folder, shows its file', t === path.join(repo, '.env'), t);
});

await browser.close();
process.exit(finish() ? 1 : 0);
