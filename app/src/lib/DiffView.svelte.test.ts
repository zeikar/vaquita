// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiffView from './DiffView.svelte';
import type { Sides } from './files';
import { holdLayout } from './layout-hold';
import type { Monaco } from './monaco';

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

function setup() {
	const focus = vi.fn();
	const editor = {
		setModel: vi.fn(),
		updateOptions: vi.fn(),
		layout: vi.fn(),
		dispose: vi.fn(),
		getModifiedEditor: () => ({ focus }),
	};
	const models: { text: string; dispose: ReturnType<typeof vi.fn> }[] = [];
	const monaco = {
		editor: {
			createDiffEditor: vi.fn(() => editor),
			createModel: vi.fn((text: string) => {
				const m = { text, dispose: vi.fn() };
				models.push(m);
				return m;
			}),
		},
		languages: { getLanguages: () => [] },
	} as unknown as Monaco;
	const loader = vi.fn(async () => monaco);
	const sides = deferred<Sides>();
	const read = vi.fn((_root: string, _path: string) => sides.promise);
	return { editor, focus, models, monaco, loader, sides, read };
}

type Setup = ReturnType<typeof setup>;

function show(s: Setup, into?: HTMLElement) {
	const props = $state({
		repo: '/tmp/repo' as string | undefined,
		path: '/tmp/repo/src/a.ts',
		sideBySide: true,
		report: vi.fn(),
		loader: s.loader,
		read: s.read,
	});
	target = into ?? document.createElement('div');
	if (!into) document.body.append(target);
	shown = mount(DiffView, { target, props });
	flushSync();
	return props;
}

const view = () => shown as unknown as { focus: () => boolean; relayout: () => void };

// Lets the loader's and the read's promises settle.
async function settle() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	flushSync();
}

// happy-dom observes no layout, so a test resizes the host by hand.
const observers: { callback: () => void; disconnected: boolean }[] = [];
class FakeResizeObserver {
	private readonly entry: (typeof observers)[number];
	constructor(callback: () => void) {
		this.entry = { callback, disconnected: false };
		observers.push(this.entry);
	}
	observe() {}
	disconnect() {
		this.entry.disconnected = true;
	}
}
const resize = () => observers.filter((o) => !o.disconnected).forEach((o) => o.callback());

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target?.remove();
	holdLayout(false);
	observers.length = 0;
	vi.unstubAllGlobals();
});

describe('DiffView', () => {
	it('reads both sides from the repo and sets them as the original and the modified model', async () => {
		const s = setup();
		show(s);
		s.sides.resolve({ head: 'old', work: 'new' });
		await settle();
		expect(s.read).toHaveBeenCalledWith('/tmp/repo', '/tmp/repo/src/a.ts');
		expect(s.monaco.editor.createDiffEditor).toHaveBeenCalledTimes(1);
		expect(s.monaco.editor.createDiffEditor).toHaveBeenCalledWith(
			expect.any(HTMLElement),
			expect.objectContaining({ readOnly: true, renderSideBySide: true, hideUnchangedRegions: { enabled: true }, wordWrap: 'on', accessibilitySupport: 'off' }),
		);
		expect(s.monaco.editor.createDiffEditor).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ automaticLayout: expect.anything() }));
		expect(s.editor.setModel).toHaveBeenCalledExactlyOnceWith({ original: s.models[0], modified: s.models[1] });
		expect(s.models.map((m) => m.text)).toEqual(['old', 'new']);
	});

	it('shows a side missing at HEAD as an empty original', async () => {
		const s = setup();
		show(s);
		s.sides.resolve({ head: null, work: 'new' });
		await settle();
		expect(s.models.map((m) => m.text)).toEqual(['', 'new']);
	});

	it('shows both sides missing as an empty diff, not an error', async () => {
		const s = setup();
		show(s);
		s.sides.resolve({ head: null, work: null });
		await settle();
		expect(s.models.map((m) => m.text)).toEqual(['', '']);
		expect(target.querySelector('.error')).toBeNull();
	});

	it('shows what rules a diff out, and does not report it', async () => {
		for (const why of ['binary', 'a symlink', 'a submodule', 'larger than 2 MiB', 'not UTF-8 text', 'outside the repo']) {
			const s = setup();
			const props = show(s);
			s.sides.reject(new Error(why));
			await settle();
			expect(target.querySelector('.error')?.textContent).toBe(`cannot show diff: ${why}`);
			expect(props.report).not.toHaveBeenCalled();
			expect(s.monaco.editor.createDiffEditor).not.toHaveBeenCalled();
			unmount(shown!);
			shown = undefined;
			target.remove();
		}
	});

	it('shows and reports a failed git run, once', async () => {
		const s = setup();
		const props = show(s);
		s.sides.reject(new Error('git cat-file failed: fatal: bad object'));
		await settle();
		expect(target.querySelector('.error')?.textContent).toBe('cannot show diff: git cat-file failed: fatal: bad object');
		expect(props.report).toHaveBeenCalledExactlyOnceWith("a.ts's diff could not be shown: git cat-file failed: fatal: bad object");
	});

	it('shows and reports Monaco failing to load', async () => {
		const s = setup();
		s.loader.mockRejectedValueOnce(new Error('chunk failed'));
		const props = show(s);
		s.sides.resolve({ head: 'old', work: 'new' });
		await settle();
		expect(target.querySelector('.error')?.textContent).toBe('cannot show diff: chunk failed');
		expect(props.report).toHaveBeenCalledExactlyOnceWith("a.ts's diff could not be shown: chunk failed");
	});

	it('shows and reports a throw while the editor is set up, and disposes what was made', async () => {
		const s = setup();
		const create = s.monaco.editor.createModel as unknown as ReturnType<typeof vi.fn>;
		const made = create.getMockImplementation()!;
		create.mockImplementationOnce(made).mockImplementationOnce(() => {
			throw new Error('no model');
		});
		const props = show(s);
		s.sides.resolve({ head: 'old', work: 'new' });
		await settle();
		expect(target.querySelector('.error')?.textContent).toBe('cannot show diff: no model');
		expect(props.report).toHaveBeenCalledExactlyOnceWith("a.ts's diff could not be shown: no model");
		expect(view().focus()).toBe(false);
		unmount(shown!);
		shown = undefined;
		expect(s.editor.dispose).toHaveBeenCalledTimes(1);
		expect(s.models.map((m) => m.dispose.mock.calls.length)).toEqual([1]);
	});

	it('reads nothing for a file in no registered repo', async () => {
		const s = setup();
		target = document.createElement('div');
		document.body.append(target);
		const props = $state({ repo: undefined, path: '/tmp/repo/a.ts', sideBySide: true, report: vi.fn(), loader: s.loader, read: s.read });
		shown = mount(DiffView, { target, props });
		flushSync();
		await settle();
		expect(target.querySelector('.error')?.textContent).toBe('cannot show diff: the file is in no registered repo');
		expect(s.read).not.toHaveBeenCalled();
		expect(s.loader).not.toHaveBeenCalled();
	});

	it('takes the focus only once both sides are in', async () => {
		const s = setup();
		show(s);
		expect(view().focus()).toBe(false);
		s.sides.resolve({ head: 'old', work: 'new' });
		await settle();
		expect(view().focus()).toBe(true);
		expect(s.focus).toHaveBeenCalledTimes(1);
	});

	it('takes the focus from the pane around it once the models are set', async () => {
		const s = setup();
		const pane = document.createElement('div');
		pane.tabIndex = -1;
		document.body.append(pane);
		show(s, pane);
		pane.focus();
		await settle();
		expect(s.focus).not.toHaveBeenCalled();
		s.sides.resolve({ head: 'old', work: 'new' });
		await settle();
		expect(s.focus).toHaveBeenCalledTimes(1);
	});

	it('leaves the focus elsewhere alone', async () => {
		const s = setup();
		const other = document.createElement('textarea');
		document.body.append(other);
		show(s);
		other.focus();
		s.sides.resolve({ head: 'old', work: 'new' });
		await settle();
		expect(s.focus).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(other);
		other.remove();
	});

	it('lays out when its host resizes, not while the layout is held, and once when relaid out', async () => {
		const s = setup();
		show(s);
		s.sides.resolve({ head: 'old', work: 'new' });
		await settle();
		resize();
		expect(s.editor.layout).toHaveBeenCalledTimes(1);
		holdLayout(true);
		resize();
		resize();
		expect(s.editor.layout).toHaveBeenCalledTimes(1);
		holdLayout(false);
		view().relayout();
		expect(s.editor.layout).toHaveBeenCalledTimes(2);
	});

	it('disposes the editor and both models when unmounted, and observes no more', async () => {
		const s = setup();
		show(s);
		s.sides.resolve({ head: 'old', work: 'new' });
		await settle();
		unmount(shown!);
		shown = undefined;
		resize();
		expect(s.editor.layout).not.toHaveBeenCalled();
		expect(s.editor.dispose).toHaveBeenCalledTimes(1);
		expect(s.models.map((m) => m.dispose.mock.calls.length)).toEqual([1, 1]);
	});

	it('makes nothing of Monaco when unmounted before the read lands', async () => {
		const s = setup();
		const props = show(s);
		await settle();
		unmount(shown!);
		shown = undefined;
		s.sides.resolve({ head: 'old', work: 'new' });
		await settle();
		expect(s.monaco.editor.createDiffEditor).not.toHaveBeenCalled();
		expect(s.monaco.editor.createModel).not.toHaveBeenCalled();
		expect(props.report).not.toHaveBeenCalled();
	});

	it('reports nothing for a read that fails after unmount', async () => {
		const s = setup();
		const props = show(s);
		unmount(shown!);
		shown = undefined;
		s.sides.reject(new Error('git cat-file failed: fatal: bad object'));
		await settle();
		expect(props.report).not.toHaveBeenCalled();
	});

	it('follows sideBySide', async () => {
		const s = setup();
		const props = show(s);
		s.sides.resolve({ head: 'old', work: 'new' });
		await settle();
		props.sideBySide = false;
		flushSync();
		expect(s.editor.updateOptions).toHaveBeenLastCalledWith({ renderSideBySide: false });
		props.sideBySide = true;
		flushSync();
		expect(s.editor.updateOptions).toHaveBeenLastCalledWith({ renderSideBySide: true });
	});
});
