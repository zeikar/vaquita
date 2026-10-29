// @vitest-environment jsdom
// Not happy-dom: DOMPurify cannot walk its DOM and lets handlers through there,
// so the sanitizing would go untested.
import { describe, expect, it } from 'vitest';
import { renderMarkdown, withFrontMatter } from './markdown';

async function rendered(text: string): Promise<HTMLElement> {
	const root = document.createElement('div');
	root.innerHTML = await renderMarkdown(text);
	return root;
}

describe('renderMarkdown', () => {
	it('renders a heading, a code block and a table', async () => {
		const root = await rendered('# Title\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
		expect(root.querySelector('h1')?.textContent).toBe('Title');
		expect(root.querySelector('pre code')?.textContent).toBe('const a = 1;\n');
		expect(root.querySelectorAll('td')).toHaveLength(2);
	});

	it('keeps links', async () => {
		const root = await rendered('[docs](https://example.com/docs)');
		expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs');
	});

	it('drops scripts, handlers and javascript: links', async () => {
		const root = await rendered(
			'<script>alert(1)</script>\n\n<p onclick="alert(2)">hi</p>\n\n[x](javascript:alert(3))\n\n<a href="javascript:alert(4)">y</a>',
		);
		expect(root.querySelector('script')).toBeNull();
		expect(root.querySelector('p')?.hasAttribute('onclick')).toBe(false);
		for (const a of root.querySelectorAll('a')) expect(a.getAttribute('href') ?? '').not.toMatch(/javascript/i);
		expect(root.innerHTML).not.toMatch(/alert/);
	});

	it('drops images and media, forms and their fields, and styles', async () => {
		const root = await rendered(
			'![logo](https://example.com/logo.png)\n\n<img src="x.png">\n\n<picture><source srcset="x.webp"></picture>\n\n<video src="x.mp4"><source src="y.mp4"></video>\n\n<audio src="x.mp3"></audio>\n\n<form action="https://example.com"><input name="q"><button>go</button><textarea></textarea><select></select></form>\n\n<style>body { display: none }</style>\n\n<p style="color: red">red</p>',
		);
		for (const tag of ['img', 'picture', 'video', 'audio', 'source', 'form', 'input', 'button', 'textarea', 'select', 'style']) {
			expect(root.querySelector(tag), tag).toBeNull();
		}
		expect(root.querySelector('p[style]')).toBeNull();
		expect(root.textContent).toContain('red');
	});

	it('drops classes and ids, which the app’s own rules would style', async () => {
		const root = await rendered('<div class="notices" id="app"><div class="notice"><a class="x" href="https://example.com">Update</a></div></div>');
		expect(root.querySelector('[class], [id]')).toBeNull();
		expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
	});

	it('drops SVG and MathML, and the images they carry', async () => {
		const root = await rendered(
			'<svg><image href="data:image/png;base64,AAAA"/><filter><feImage href="data:image/png;base64,AAAA"/></filter></svg>\n\n<math><mi>x</mi></math>',
		);
		expect(root.querySelector('svg, image, feImage, filter, math')).toBeNull();
		expect(root.innerHTML).not.toMatch(/data:/);
	});

	it('shows a task list’s boxes as text', async () => {
		const root = await rendered('- [ ] todo\n- [x] done\n');
		expect(root.querySelector('input')).toBeNull();
		expect([...root.querySelectorAll('li')].map((li) => li.textContent?.trim())).toEqual(['☐ todo', '☑ done']);
	});
});

describe('front matter', () => {
	it('shows a leading YAML block as code, not as a rule and a heading', async () => {
		const root = await rendered('---\ntitle: "A post"\ndate: 2026-10-29\n---\n\nBody text.\n');
		expect(root.querySelector('hr')).toBeNull();
		expect(root.querySelector('h1, h2')).toBeNull();
		expect(root.querySelector('pre code')?.textContent).toBe('title: "A post"\ndate: 2026-10-29\n');
		expect(root.querySelector('p')?.textContent).toBe('Body text.');
	});

	it('leaves a document without front matter, or with a rule further down, alone', () => {
		expect(withFrontMatter('# Title\n\n---\n\ntext\n')).toBe('# Title\n\n---\n\ntext\n');
		expect(withFrontMatter('---\nno closing line\n')).toBe('---\nno closing line\n');
	});

	it('takes CRLF line ends and a closing ... line', () => {
		expect(withFrontMatter('---\r\na: 1\r\n...\r\nrest')).toBe('```yaml\na: 1\n```\n\nrest');
	});

	it('takes an empty block, and leaves a rule further down to the body', () => {
		expect(withFrontMatter('---\n---\n\n# Body\n\n---\nTail')).toBe('```yaml\n\n```\n\n\n# Body\n\n---\nTail');
	});

	it('uses a fence longer than any backticks inside the block', () => {
		expect(withFrontMatter('---\nx: "```"\n---\n')).toBe('````yaml\nx: "```"\n````\n\n');
	});
});
