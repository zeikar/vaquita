// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FilePane from './FilePane.svelte';
import { stubs } from './DiffView.stub.svelte';
import { documents } from './documents';
import { readText, viewPath } from './files';

const hoisted = vi.hoisted(() => {
	const editor = { setModel: () => {}, getModel: () => null, focus: () => {}, dispose: () => {}, updateOptions: () => {} };
	const model = (text: string) => ({
		getValue: () => text,
		getAlternativeVersionId: () => 1,
		onDidChangeContent: () => {},
		dispose: () => {},
	});
	const monaco = {
		editor: { create: vi.fn(() => editor), createModel: vi.fn(model) },
		Uri: { file: (p: string) => p },
	};
	return { monaco };
});

vi.mock('./files', () => ({
	CHANGED_ON_DISK: 'changed on disk',
	viewPath: vi.fn(async (path: string) => ({ path, kind: path.endsWith('.md') ? 'markdown' : path.endsWith('.png') ? 'image' : 'text' })),
	readText: vi.fn(async (path: string) => ({ text: `<p>${path}</p>`, stamp: { secs: 1, nanos: 0, len: 1 } })),
	writeText: vi.fn(),
	fileUrl: vi.fn(async (path: string) => `asset://localhost${path}`),
}));
vi.mock('./monaco', () => ({ EDITOR_OPTIONS: {}, loadMonaco: async () => hoisted.monaco, languageFor: () => 'markdown' }));
vi.mock('./markdown', () => ({ renderMarkdown: async (text: string) => text }));
vi.mock('./DiffView.svelte', async () => ({ default: (await import('./DiffView.stub.svelte')).default }));

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;

function show(path: string, where: { repo?: string; home?: string } = {}) {
	const props = $state({ path, ...where, onclose: vi.fn(), onopenfile: vi.fn(), report: vi.fn() });
	target = document.createElement('div');
	document.body.append(target);
	shown = mount(FilePane, { target, props });
	flushSync();
	return props;
}

async function settle() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	flushSync();
}

const button = (name: string) => target.querySelector<HTMLButtonElement>(`.bar button[aria-label="${name}"]`)!;
const bar = () => target.querySelector<HTMLElement>('.bar')!;
const previewShown = () => target.querySelector('.markdown') !== null;
const editorShown = () => target.querySelector<HTMLElement>('.text')?.hidden === false;

afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target?.remove();
	stubs.length = 0;
});

describe('FilePane path bar', () => {
	it('shows the path from the repo folder, the full one as its tooltip', async () => {
		show('/tmp/repo/src/lib/a.ts', { repo: '/tmp/repo', home: '/Users/me' });
		await settle();
		expect(bar().querySelector('.dir')?.textContent).toBe('src/lib/');
		expect(bar().querySelector('.name')?.textContent).toBe('a.ts');
		expect(bar().title).toBe('/tmp/repo/src/lib/a.ts');
	});

	it('shows the path from ~ outside a repo', async () => {
		show('/Users/me/notes/todo.txt', { home: '/Users/me' });
		await settle();
		expect(bar().querySelector('.where')?.textContent).toBe('~/notes/todo.txt');
		expect(bar().title).toBe('/Users/me/notes/todo.txt');
	});

	it('has the Preview and Source switch for markdown only', async () => {
		const props = show('/tmp/repo/a.txt');
		await settle();
		expect(bar().querySelector('button')).toBeNull();
		props.path = '/tmp/repo/b.png';
		flushSync();
		await settle();
		expect(bar().querySelector('button')).toBeNull();
		props.path = '/tmp/repo/c.md';
		flushSync();
		await settle();
		expect(button('Preview').title).toBe('Preview');
		expect(button('Source').title).toBe('Source');
		expect(button('Preview').querySelector('svg[data-icon="eye"]')).not.toBeNull();
		expect(button('Source').querySelector('svg[data-icon="code-bracket-micro"]')).not.toBeNull();
	});

	it('replaces the old toolbar row', async () => {
		show('/tmp/repo/d.md');
		await settle();
		expect(target.querySelector('.toolbar')).toBeNull();
	});
});

describe('FilePane markdown', () => {
	it('previews by default, and switches between Preview and Source with one editor', async () => {
		const creates = hoisted.monaco.editor.create.mock.calls.length;
		show('/tmp/repo/one.md');
		await settle();
		expect(previewShown()).toBe(true);
		expect(target.querySelector('.markdown .body')?.innerHTML).toBe('<p>/tmp/repo/one.md</p>');
		expect(button('Preview').getAttribute('aria-pressed')).toBe('true');
		expect(target.querySelector('.text')).toBeNull();

		button('Source').click();
		await settle();
		expect(previewShown()).toBe(false);
		expect(editorShown()).toBe(true);
		expect(button('Source').getAttribute('aria-pressed')).toBe('true');
		expect(button('Preview').getAttribute('aria-pressed')).toBe('false');

		button('Preview').click();
		await settle();
		expect(previewShown()).toBe(true);
		expect(editorShown()).toBe(false);

		button('Source').click();
		await settle();
		expect(editorShown()).toBe(true);
		expect(hoisted.monaco.editor.create.mock.calls.length - creates).toBe(1);
	});

	it('keeps the choice per path', async () => {
		const props = show('/tmp/repo/two.md');
		await settle();
		button('Source').click();
		await settle();
		props.path = '/tmp/repo/three.md';
		flushSync();
		await settle();
		expect(previewShown()).toBe(true);
		unmount(shown!);
		target.remove();
		show('/tmp/repo/two.md');
		await settle();
		expect(previewShown()).toBe(false);
		expect(editorShown()).toBe(true);
	});

	it('reads only the paths it previews, once each', async () => {
		vi.mocked(readText).mockClear();
		const props = show('/tmp/repo/four.md');
		await settle();
		props.path = '/tmp/repo/five.png';
		flushSync();
		await settle();
		props.path = '/tmp/repo/six.md';
		flushSync();
		await settle();
		expect(vi.mocked(readText).mock.calls.map(([p]) => p)).toEqual(['/tmp/repo/four.md', '/tmp/repo/six.md']);
		expect(target.querySelector('.markdown .body')?.innerHTML).toBe('<p>/tmp/repo/six.md</p>');
	});
});

describe('FilePane with unsaved edits', () => {
	it('keeps the edited text in the editor when the file can no longer be shown, with the reason', async () => {
		vi.spyOn(documents, 'isDirty').mockReturnValue(true);
		vi.mocked(viewPath).mockRejectedValueOnce(new Error('no such file'));
		show('/tmp/repo/gone.txt');
		await settle();
		expect(editorShown()).toBe(true);
		expect(target.querySelector('.note')?.textContent).toContain('no such file');
		expect(target.querySelector('.error')).toBeNull();
		vi.restoreAllMocks();
	});

	it('shows the error alone when nothing is unsaved', async () => {
		vi.mocked(viewPath).mockRejectedValueOnce(new Error('no such file'));
		show('/tmp/repo/gone2.txt');
		await settle();
		expect(target.querySelector('.error')?.textContent).toContain('no such file');
	});
});

describe('FilePane diff tab', () => {
	const tab = 'diff:/tmp/repo/src/a.ts';
	const live = () => stubs.filter((v) => !v.destroyed);

	it('shows the file’s path in the bar, the diff buttons, and no Preview or Source', async () => {
		vi.mocked(viewPath).mockClear();
		show(tab, { repo: '/tmp/repo', home: '/Users/me' });
		await settle();
		expect(bar().querySelector('.dir')?.textContent).toBe('src/');
		expect(bar().querySelector('.name')?.textContent).toBe('a.ts');
		expect(bar().title).toBe('/tmp/repo/src/a.ts');
		expect(button('Side by side')).not.toBeNull();
		expect(button('Open file').querySelector('svg[data-icon="arrow-top-right-on-square"]')).not.toBeNull();
		expect(target.querySelector('.bar button[aria-label="Preview"]')).toBeNull();
		expect(target.querySelector('.bar button[aria-label="Source"]')).toBeNull();
		// Nothing opens, so the gate is not asked.
		expect(viewPath).not.toHaveBeenCalled();
		expect(live().map((v) => ({ ...v.props }))).toEqual([expect.objectContaining({ repo: '/tmp/repo', path: '/tmp/repo/src/a.ts', sideBySide: true })]);
	});

	it('opens the file itself from the bar', async () => {
		const props = show(tab, { repo: '/tmp/repo' });
		await settle();
		button('Open file').click();
		expect(props.onopenfile).toHaveBeenCalledExactlyOnceWith('/tmp/repo/src/a.ts');
	});

	it('switches between side by side and inline', async () => {
		show(tab, { repo: '/tmp/repo' });
		await settle();
		const toggle = button('Side by side');
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
		expect(toggle.querySelector('svg[data-icon="view-columns"]')).not.toBeNull();
		try {
			toggle.click();
			flushSync();
			expect(toggle.getAttribute('aria-pressed')).toBe('false');
			expect(toggle.title).toBe('Side by side');
			expect(toggle.querySelector('svg[data-icon="bars-3"]')).not.toBeNull();
			expect(live()[0].props.sideBySide).toBe(false);
		} finally {
			// The switch is module-wide, so a failure must not leave it off for the next test.
			if (toggle.getAttribute('aria-pressed') === 'false') toggle.click();
			flushSync();
		}
		expect(live()[0].props.sideBySide).toBe(true);
	});

	it('mounts the view again, against no repo, when the tab’s repo goes', async () => {
		const props = show(tab, { repo: '/tmp/repo' });
		await settle();
		const first = stubs[0];
		props.repo = undefined;
		flushSync();
		await settle();
		expect(first.destroyed).toBe(true);
		expect(live()).toHaveLength(1);
		expect(live()[0].props.repo).toBeUndefined();
	});

	it('mounts a new view for another diff tab, so it reads its own file', async () => {
		const props = show(tab, { repo: '/tmp/repo' });
		await settle();
		props.path = 'diff:/tmp/repo/b.ts';
		flushSync();
		await settle();
		expect(stubs[0].destroyed).toBe(true);
		expect(live().map((v) => v.props.path)).toEqual(['/tmp/repo/b.ts']);
	});

	it('hands the focus to the diff, and relays it out after a drag', async () => {
		show(tab, { repo: '/tmp/repo' });
		await settle();
		const pane = shown as unknown as { focus: () => void; relayout: () => void };
		pane.focus();
		pane.relayout();
		expect(stubs[0].focuses).toBe(1);
		expect(stubs[0].relayouts).toBe(1);
	});

	it('unmounts the diff for a file tab', async () => {
		const props = show(tab, { repo: '/tmp/repo' });
		await settle();
		props.path = '/tmp/repo/a.txt';
		flushSync();
		await settle();
		expect(live()).toHaveLength(0);
		expect(target.querySelector('.diff')).toBeNull();
		expect(bar().querySelector('button')).toBeNull();
	});
});
