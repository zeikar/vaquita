// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state, as the app's are.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Document } from './documents';
import type { Monaco } from './monaco';
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
	const props = $state({ path, shown: 1, readOnly: false, report: vi.fn(), loader: s.loader, documents: s.documents });
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

afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target?.remove();
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
			expect.objectContaining({ model: null, theme: 'vs-dark', fontSize: 13, minimap: { enabled: false }, automaticLayout: true }),
		);
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
