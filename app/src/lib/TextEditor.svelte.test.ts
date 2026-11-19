// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document } from './documents';
import { holdLayout } from './layout-hold';
import type { Monaco } from './monaco';
import type { Reveal } from './tabs.svelte';
import TextEditor from './TextEditor.svelte';

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

const doc = (name: string) => ({ model: { name } }) as unknown as Document;

function setup() {
	let model: unknown = null;
	const editor = {
		setModel: vi.fn((m: unknown) => void (model = m)),
		getModel: () => model,
		focus: vi.fn(),
		dispose: vi.fn(),
		updateOptions: vi.fn(),
		layout: vi.fn(),
		saveViewState: vi.fn((): unknown => null),
		restoreViewState: vi.fn(),
		setPosition: vi.fn(),
		revealPositionInCenter: vi.fn(),
	};
	const monaco = { editor: { create: vi.fn(() => editor) } } as unknown as Monaco;
	const loader = vi.fn(async () => monaco);
	const reads = new Map<string, ReturnType<typeof deferred<Document>>>();
	const read = (p: string) => {
		if (!reads.has(p)) reads.set(p, deferred<Document>());
		return reads.get(p)!;
	};
	const documents = {
		openDocument: vi.fn((p: string) => read(p).promise),
		refresh: vi.fn(async (_p: string, _still: () => boolean) => {}),
	};
	return { editor, monaco, loader, read, documents };
}

type Setup = ReturnType<typeof setup>;

function show(s: Setup, path: string) {
	const props = $state({
		path,
		shown: 1,
		readOnly: false,
		report: vi.fn(),
		loader: s.loader,
		documents: s.documents,
		reveal: undefined as Reveal | undefined,
		onrevealed: vi.fn(),
	});
	target = document.createElement('div');
	document.body.append(target);
	shown = mount(TextEditor, { target, props });
	flushSync();
	return props;
}

// Lets the loader's and the reads' promises settle.
async function settle() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	flushSync();
}

// happy-dom observes no layout, so a test resizes the host by hand.
type Resized = (entries: { contentRect: { width: number } }[]) => void;
const observers: { callback: Resized; disconnected: boolean }[] = [];
class FakeResizeObserver {
	private readonly entry: (typeof observers)[number];
	constructor(callback: Resized) {
		this.entry = { callback, disconnected: false };
		observers.push(this.entry);
	}
	observe() {}
	disconnect() {
		this.entry.disconnected = true;
	}
}
const resize = (width = 800) => observers.filter((o) => !o.disconnected).forEach((o) => o.callback([{ contentRect: { width } }]));

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

const models = (s: Setup) => s.editor.setModel.mock.calls.map(([m]) => (m as { name: string } | null)?.name ?? null);

describe('TextEditor', () => {
	it('follows readOnly, so editing can be frozen', async () => {
		const s = setup();
		const props = show(s, '/tmp/repo/a.ts');
		await settle();
		props.readOnly = true;
		flushSync();
		expect(s.editor.updateOptions).toHaveBeenLastCalledWith({ readOnly: true });
		props.readOnly = false;
		flushSync();
		expect(s.editor.updateOptions).toHaveBeenLastCalledWith({ readOnly: false });
	});

	it('loads Monaco on mount, once across paths, and makes one editor', async () => {
		const s = setup();
		expect(s.loader).not.toHaveBeenCalled();
		const props = show(s, '/tmp/repo/a.ts');
		await settle();
		props.path = '/tmp/repo/b.ts';
		flushSync();
		await settle();
		expect(s.loader).toHaveBeenCalledTimes(1);
		expect(s.monaco.editor.create).toHaveBeenCalledTimes(1);
		expect(s.monaco.editor.create).toHaveBeenCalledWith(
			expect.any(HTMLElement),
			expect.objectContaining({ model: null, theme: 'vs-dark', fontSize: 13, minimap: { enabled: false }, wordWrap: 'on', accessibilitySupport: 'off' }),
		);
		// Its own observer lays it out, so that a drag can hold the layout.
		expect(s.monaco.editor.create).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ automaticLayout: expect.anything() }));
	});

	it('lays out when its host resizes, but not while the layout is held', async () => {
		const s = setup();
		show(s, '/tmp/repo/a.ts');
		await settle();
		resize();
		expect(s.editor.layout).toHaveBeenCalledTimes(1);
		holdLayout(true);
		resize();
		resize();
		expect(s.editor.layout).toHaveBeenCalledTimes(1);
	});

	it('lays out once when relaid out after a held drag', async () => {
		const s = setup();
		show(s, '/tmp/repo/a.ts');
		await settle();
		holdLayout(true);
		resize();
		holdLayout(false);
		(shown as { relayout: () => void }).relayout();
		expect(s.editor.layout).toHaveBeenCalledTimes(1);
	});

	it('stops observing its host once unmounted', async () => {
		const s = setup();
		show(s, '/tmp/repo/a.ts');
		await settle();
		unmount(shown!);
		shown = undefined;
		resize();
		expect(s.editor.layout).not.toHaveBeenCalled();
	});

	it('sets each shown path’s model', async () => {
		const s = setup();
		const props = show(s, '/tmp/repo/a.ts');
		await settle();
		s.read('/tmp/repo/a.ts').resolve(doc('a'));
		await settle();
		props.path = '/tmp/repo/b.ts';
		flushSync();
		s.read('/tmp/repo/b.ts').resolve(doc('b'));
		await settle();
		expect(models(s).filter((m) => m !== null)).toEqual(['a', 'b']);
	});

	it('does not set a model read for a path no longer shown', async () => {
		const s = setup();
		const props = show(s, '/tmp/repo/a.ts');
		await settle();
		props.path = '/tmp/repo/b.ts';
		flushSync();
		s.read('/tmp/repo/b.ts').resolve(doc('b'));
		await settle();
		s.read('/tmp/repo/a.ts').resolve(doc('a'));
		await settle();
		expect(models(s).filter((m) => m !== null)).toEqual(['b']);
	});

	it('sets no model once unmounted, and disposes the editor', async () => {
		const s = setup();
		show(s, '/tmp/repo/a.ts');
		await settle();
		unmount(shown!);
		shown = undefined;
		s.read('/tmp/repo/a.ts').resolve(doc('a'));
		await settle();
		expect(models(s).filter((m) => m !== null)).toEqual([]);
		expect(s.editor.dispose).toHaveBeenCalledTimes(1);
	});

	it('takes the focus from the pane around it once the model is set', async () => {
		const s = setup();
		const pane = document.createElement('div');
		pane.tabIndex = -1;
		document.body.append(pane);
		target = pane;
		const props = $state({ path: '/tmp/repo/a.ts', shown: 1, report: vi.fn(), loader: s.loader, documents: s.documents });
		shown = mount(TextEditor, { target: pane, props });
		pane.focus();
		await settle();
		expect(s.editor.focus).not.toHaveBeenCalled();
		s.read('/tmp/repo/a.ts').resolve(doc('a'));
		await settle();
		expect(s.editor.focus).toHaveBeenCalledTimes(1);
	});

	it('sets the model again when the path is shown again with a new document', async () => {
		const s = setup();
		const props = show(s, '/tmp/repo/a.ts');
		await settle();
		s.read('/tmp/repo/a.ts').resolve(doc('a'));
		await settle();
		// Its document was dropped while hidden, which took the model away.
		s.editor.setModel(null);
		const again = doc('a2');
		s.documents.openDocument.mockResolvedValueOnce(again);
		props.shown++;
		flushSync();
		await settle();
		expect(s.editor.getModel()).toBe(again.model);
	});

	it('keeps the model it has, and reads the file again, when the path is shown again', async () => {
		const s = setup();
		const props = show(s, '/tmp/repo/a.ts');
		await settle();
		s.read('/tmp/repo/a.ts').resolve(doc('a'));
		await settle();
		s.editor.setModel.mockClear();
		s.documents.refresh.mockClear();
		props.shown++;
		flushSync();
		await settle();
		expect(s.editor.setModel).not.toHaveBeenCalled();
		expect(s.documents.refresh).toHaveBeenCalledWith('/tmp/repo/a.ts', expect.any(Function));
	});

	it('does not lay out a hidden host, nor when relaid out, until it has a size again', async () => {
		const s = setup();
		show(s, '/tmp/repo/a.ts');
		await settle();
		resize(0);
		(shown as { relayout: () => void }).relayout();
		expect(s.editor.layout).not.toHaveBeenCalled();
		resize(800);
		expect(s.editor.layout).toHaveBeenCalledTimes(1);
	});

	it('goes back to where a document was left when another path was shown', async () => {
		const s = setup();
		const props = show(s, '/tmp/repo/a.ts');
		await settle();
		const a = doc('a');
		s.read('/tmp/repo/a.ts').resolve(a);
		await settle();
		expect(s.editor.restoreViewState).not.toHaveBeenCalled();
		s.editor.saveViewState.mockReturnValueOnce('a at line 200');
		props.path = '/tmp/repo/b.ts';
		flushSync();
		s.read('/tmp/repo/b.ts').resolve(doc('b'));
		await settle();
		expect(s.editor.restoreViewState).not.toHaveBeenCalled();
		props.path = '/tmp/repo/a.ts';
		flushSync();
		await settle();
		expect(s.editor.getModel()).toBe(a.model);
		expect(s.editor.restoreViewState).toHaveBeenCalledExactlyOnceWith('a at line 200');
	});

	it('keeps a document’s place through an unmount, before the editor goes', async () => {
		const s = setup();
		show(s, '/tmp/repo/a.ts');
		await settle();
		const a = doc('a');
		s.read('/tmp/repo/a.ts').resolve(a);
		await settle();
		s.editor.saveViewState.mockImplementationOnce(() => {
			expect(s.editor.dispose).not.toHaveBeenCalled();
			return 'a at line 200';
		});
		unmount(shown!);
		shown = undefined;
		expect(a.view).toBe('a at line 200');
	});

	it('leaves the view alone when the path is shown again with the model it has', async () => {
		const s = setup();
		const props = show(s, '/tmp/repo/a.ts');
		await settle();
		const a = doc('a');
		a.view = 'older' as unknown as Document['view'];
		s.read('/tmp/repo/a.ts').resolve(a);
		await settle();
		s.editor.restoreViewState.mockClear();
		props.shown++;
		flushSync();
		await settle();
		expect(s.editor.restoreViewState).not.toHaveBeenCalled();
	});

	it('keeps the place through a reload of the text while it holds the document', async () => {
		const s = setup();
		const props = show(s, '/tmp/repo/a.ts');
		await settle();
		const a = doc('a');
		s.read('/tmp/repo/a.ts').resolve(a);
		await settle();
		s.editor.saveViewState.mockReturnValueOnce('before');
		const reload = vi.fn(() => expect(s.editor.restoreViewState).not.toHaveBeenCalled());
		a.around!(reload);
		expect(reload).toHaveBeenCalledTimes(1);
		expect(s.editor.restoreViewState).toHaveBeenCalledExactlyOnceWith('before');
		props.path = '/tmp/repo/b.ts';
		flushSync();
		expect(a.around).toBeUndefined();
	});

	it('shows and reports a failed read', async () => {
		const s = setup();
		const props = show(s, '/tmp/repo/a.ts');
		await settle();
		s.read('/tmp/repo/a.ts').reject(new Error('not UTF-8 text'));
		await settle();
		expect(target.querySelector('.error')?.textContent).toBe('not UTF-8 text');
		expect(props.report).toHaveBeenCalledWith('a.ts could not be read: not UTF-8 text');
	});
});

describe('TextEditor going to a link’s line', () => {
	const a = '/tmp/repo/a.ts';
	// Three lines of 4, 0 and 9 characters.
	const lines = (name: string) =>
		({ model: { name, getLineCount: () => 3, getLineMaxColumn: (n: number) => [5, 1, 10][n - 1] } }) as unknown as Document;

	it('goes there once it holds the path, over the place it left there, and says it did', async () => {
		const s = setup();
		const props = show(s, a);
		const r = { path: a, line: 3, col: 99 };
		props.reveal = r;
		flushSync();
		await settle();
		expect(s.editor.setPosition).not.toHaveBeenCalled();
		const d = lines('a');
		d.view = 'left' as unknown as Document['view'];
		s.read(a).resolve(d);
		await settle();
		const end = { lineNumber: 3, column: 10 };
		expect(s.editor.setPosition).toHaveBeenCalledExactlyOnceWith(end);
		expect(s.editor.revealPositionInCenter).toHaveBeenCalledExactlyOnceWith(end);
		expect(s.editor.restoreViewState.mock.invocationCallOrder[0]).toBeLessThan(s.editor.setPosition.mock.invocationCallOrder[0]);
		expect(props.onrevealed).toHaveBeenCalledExactlyOnceWith(r);
	});

	it('goes there at each click while it holds the path, and not for another path', async () => {
		const s = setup();
		const props = show(s, a);
		await settle();
		s.read(a).resolve(lines('a'));
		await settle();
		props.reveal = { path: a, line: 2, col: 4 };
		flushSync();
		props.reveal = { path: a, line: 1 };
		flushSync();
		props.reveal = { path: a, line: 400 };
		flushSync();
		props.reveal = { path: '/tmp/repo/b.ts', line: 1 };
		flushSync();
		expect(s.editor.setPosition.mock.calls).toEqual([[{ lineNumber: 2, column: 1 }], [{ lineNumber: 1, column: 1 }], [{ lineNumber: 3, column: 1 }]]);
		expect(props.onrevealed).toHaveBeenCalledTimes(3);
	});

	it('counts the line in the file as this show read it again, for a document read before', async () => {
		const s = setup();
		const props = show(s, a);
		await settle();
		// Read when the file had one line; an agent has since made it three.
		let count = 1;
		const d = { model: { name: 'a', getLineCount: () => count, getLineMaxColumn: (n: number) => (n <= count ? 6 : 1) } } as unknown as Document;
		s.read(a).resolve(d);
		await settle();
		const refreshed = deferred<void>();
		s.documents.refresh.mockReturnValueOnce(refreshed.promise);
		props.reveal = { path: a, line: 3, col: 2 };
		props.shown++;
		flushSync();
		await settle();
		expect(s.editor.setPosition).not.toHaveBeenCalled();
		count = 3;
		refreshed.resolve();
		await settle();
		expect(s.editor.setPosition).toHaveBeenCalledExactlyOnceWith({ lineNumber: 3, column: 2 });
		expect(props.onrevealed).toHaveBeenCalledTimes(1);
	});
});
