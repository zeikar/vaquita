import { describe, expect, it, vi } from 'vitest';
import { Documents, type DocumentDeps } from './documents';
import { CHANGED_ON_DISK, type Stamp } from './files';
import type { Monaco } from './monaco';

// A model as far as documents.ts uses one: each edit takes a new version.
class StubModel {
	private version = 1;
	private listeners: (() => void)[] = [];
	disposed = false;
	constructor(
		private text: string,
		readonly language: string,
		readonly uri: string,
	) {}
	// Like Monaco's: a leading BOM is kept off the text unless asked for.
	getValue = (_eol?: unknown, preserveBOM?: boolean) =>
		preserveBOM && this.bom ? '\uFEFF' + this.text : this.text;
	bom = false;
	getAlternativeVersionId = () => this.version;
	onDidChangeContent = (l: () => void) => void this.listeners.push(l);
	dispose = () => void (this.disposed = true);
	setValue = (text: string) => this.edit(text);
	edit(text: string) {
		this.text = text;
		this.version++;
		for (const l of this.listeners) l();
	}
}

const stamp = (secs: number): Stamp => ({ secs, nanos: 0, len: 1 });

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

function setup() {
	const models: StubModel[] = [];
	const monaco = {
		editor: {
			createModel: (text: string, language: string, uri: string) => {
				const m = new StubModel(text, language, uri);
				models.push(m);
				return m;
			},
		},
		languages: { getLanguages: () => [{ id: 'typescript', extensions: ['.ts'] }] },
		Uri: { file: (p: string) => `file://${p}` },
	} as unknown as Monaco;
	const deps = {
		monaco: async () => monaco,
		readText: vi.fn(async (_path: string) => ({ text: 'one', stamp: stamp(1) })),
		writeText: vi.fn(async (_path: string, _text: string, _stamp?: Stamp) => stamp(2)),
		ask: vi.fn(async () => true),
	};
	const docs = new Documents(deps as unknown as DocumentDeps);
	const report = vi.fn();
	const model = (i = 0) => models[i];
	return { docs, deps, models, model, report };
}

const path = '/tmp/repo/a.ts';

describe('openDocument', () => {
	it('makes a model with the language and URI of the path', async () => {
		const { docs, model } = setup();
		const doc = await docs.openDocument(path);
		expect(doc.model).toBe(model());
		expect(model().language).toBe('typescript');
		expect(model().uri).toBe('file:///tmp/repo/a.ts');
		expect(doc.stamp).toEqual(stamp(1));
		expect(docs.isDirty(path)).toBe(false);
	});

	it('does not read again for a path it has, and keeps the first stamp', async () => {
		const { docs, deps } = setup();
		const first = await docs.openDocument(path);
		deps.readText.mockResolvedValue({ text: 'newer', stamp: stamp(9) });
		const again = await docs.openDocument(path);
		expect(again).toBe(first);
		expect(again.stamp).toEqual(stamp(1));
		expect(deps.readText).toHaveBeenCalledTimes(1);
	});

	it('shares one read between opens started before it lands', async () => {
		const { docs, deps, models } = setup();
		const read = deferred<{ text: string; stamp: Stamp }>();
		deps.readText.mockReturnValueOnce(read.promise);
		const a = docs.openDocument(path);
		const b = docs.openDocument(path);
		read.resolve({ text: 'one', stamp: stamp(1) });
		expect(await a).toBe(await b);
		expect(deps.readText).toHaveBeenCalledTimes(1);
		expect(models).toHaveLength(1);
	});

	it('makes no model from a read that lands after its document was dropped', async () => {
		const { docs, deps, models } = setup();
		const read = deferred<{ text: string; stamp: Stamp }>();
		deps.readText.mockReturnValueOnce(read.promise);
		const first = docs.openDocument(path);
		docs.dropDocument(path);
		read.resolve({ text: 'stale', stamp: stamp(1) });
		await expect(first).rejects.toThrow('a.ts was closed while it was read');
		expect(models).toHaveLength(0);
		const again = await docs.openDocument(path);
		expect(deps.readText).toHaveBeenCalledTimes(2);
		expect(again.model.getValue()).toBe('one');
		expect(models).toHaveLength(1);
	});

	it('keeps a newer open in flight when an older read settles', async () => {
		const { docs, deps } = setup();
		const old = deferred<{ text: string; stamp: Stamp }>();
		const fresh = deferred<{ text: string; stamp: Stamp }>();
		deps.readText.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
		const first = docs.openDocument(path);
		docs.dropDocument(path);
		const second = docs.openDocument(path);
		old.resolve({ text: 'stale', stamp: stamp(1) });
		await expect(first).rejects.toThrow();
		const third = docs.openDocument(path);
		fresh.resolve({ text: 'one', stamp: stamp(1) });
		expect(await third).toBe(await second);
		expect(deps.readText).toHaveBeenCalledTimes(2);
	});

	it('reads again after a failed read', async () => {
		const { docs, deps } = setup();
		deps.readText.mockRejectedValueOnce(new Error('not UTF-8 text'));
		await expect(docs.openDocument(path)).rejects.toThrow('not UTF-8 text');
		await docs.openDocument(path);
		expect(deps.readText).toHaveBeenCalledTimes(2);
	});
});

describe('textOf', () => {
	it('gives the text as edited, and nothing for a path with no document', async () => {
		const { docs, model } = setup();
		expect(docs.textOf(path)).toBeUndefined();
		await docs.openDocument(path);
		model().edit('two');
		expect(docs.textOf(path)).toBe('two');
	});
});

describe('saveDocument', () => {
	it('does nothing for a path with no document, or an unchanged one', async () => {
		const { docs, deps, report } = setup();
		await docs.saveDocument(path, report);
		await docs.openDocument(path);
		await docs.saveDocument(path, report);
		expect(deps.writeText).not.toHaveBeenCalled();
	});

	it('writes the text with the stamp it was read with, then keeps the new stamp', async () => {
		const { docs, deps, model, report } = setup();
		const doc = await docs.openDocument(path);
		model().edit('two');
		expect(docs.isDirty(path)).toBe(true);
		await docs.saveDocument(path, report);
		expect(deps.writeText).toHaveBeenCalledWith(path, 'two', stamp(1));
		expect(docs.isDirty(path)).toBe(false);
		expect(doc.stamp).toEqual(stamp(2));
	});

	it('writes the BOM a file was read with', async () => {
		const { docs, deps, model, report } = setup();
		await docs.openDocument(path);
		model().bom = true;
		model().edit('two');
		await docs.saveDocument(path, report);
		expect(deps.writeText).toHaveBeenCalledWith(path, '\uFEFFtwo', stamp(1));
	});

	it('marks only the written version saved when typing goes on during the write', async () => {
		const { docs, deps, model, report } = setup();
		const doc = await docs.openDocument(path);
		model().edit('two');
		const write = deferred<Stamp>();
		deps.writeText.mockReturnValueOnce(write.promise);
		const saved = docs.saveDocument(path, report);
		model().edit('three');
		write.resolve(stamp(2));
		await saved;
		expect(deps.writeText).toHaveBeenCalledWith(path, 'two', stamp(1));
		expect(docs.isDirty(path)).toBe(true);
		expect(doc.stamp).toEqual(stamp(2));
	});

	it('writes once for two saves of one version started together', async () => {
		const { docs, deps, model, report } = setup();
		await docs.openDocument(path);
		model().edit('two');
		await Promise.all([docs.saveDocument(path, report), docs.saveDocument(path, report)]);
		expect(deps.writeText).toHaveBeenCalledTimes(1);
	});

	it('writes the newer text, after the first write, for a save asked for during it', async () => {
		const { docs, deps, model, report } = setup();
		await docs.openDocument(path);
		model().edit('two');
		const write = deferred<Stamp>();
		deps.writeText.mockReturnValueOnce(write.promise);
		const first = docs.saveDocument(path, report);
		model().edit('three');
		const second = docs.saveDocument(path, report);
		await Promise.resolve();
		expect(deps.writeText).toHaveBeenCalledTimes(1);
		write.resolve(stamp(2));
		await Promise.all([first, second]);
		expect(deps.writeText).toHaveBeenCalledTimes(2);
		expect(deps.writeText).toHaveBeenLastCalledWith(path, 'three', stamp(2));
		expect(docs.isDirty(path)).toBe(false);
	});

	it('asks when the file changed on disk, and writes without a stamp on yes', async () => {
		const { docs, deps, model, report } = setup();
		await docs.openDocument(path);
		model().edit('two');
		deps.writeText.mockRejectedValueOnce(new Error(CHANGED_ON_DISK));
		await docs.saveDocument(path, report);
		expect(deps.ask).toHaveBeenCalledWith('a.ts changed on disk since you opened it. Overwrite it?', 'Overwrite');
		expect(deps.writeText).toHaveBeenLastCalledWith(path, 'two');
		expect(docs.isDirty(path)).toBe(false);
		expect(report).not.toHaveBeenCalled();
	});

	it('writes nothing more and stays dirty on no', async () => {
		const { docs, deps, model, report } = setup();
		await docs.openDocument(path);
		model().edit('two');
		deps.writeText.mockRejectedValueOnce(new Error(CHANGED_ON_DISK));
		deps.ask.mockResolvedValueOnce(false);
		await docs.saveDocument(path, report);
		expect(deps.writeText).toHaveBeenCalledTimes(1);
		expect(docs.isDirty(path)).toBe(true);
		expect(report).not.toHaveBeenCalled();
	});

	it('reports a failed write, a read-only file plainly, and stays dirty', async () => {
		const { docs, deps, model, report } = setup();
		await docs.openDocument(path);
		model().edit('two');
		deps.writeText.mockRejectedValueOnce(new Error('read-only'));
		await docs.saveDocument(path, report);
		expect(report).toHaveBeenLastCalledWith('a.ts is read-only');
		deps.writeText.mockRejectedValueOnce(new Error('No space left on device'));
		await docs.saveDocument(path, report);
		expect(report).toHaveBeenLastCalledWith('saving a.ts failed: No space left on device');
		expect(deps.ask).not.toHaveBeenCalled();
		expect(docs.isDirty(path)).toBe(true);
	});
});

describe('onSaved', () => {
	it('tells the listener once with the path of a save', async () => {
		const { docs, model, report } = setup();
		const saved = vi.fn();
		docs.onSaved(saved);
		await docs.openDocument(path);
		model().edit('two');
		await docs.saveDocument(path, report);
		expect(saved).toHaveBeenCalledOnce();
		expect(saved).toHaveBeenCalledWith(path);
	});

	it('stays silent for a declined overwrite and a failed write, and after it is stopped', async () => {
		const { docs, deps, model, report } = setup();
		const saved = vi.fn();
		const stop = docs.onSaved(saved);
		await docs.openDocument(path);
		model().edit('two');
		deps.writeText.mockRejectedValueOnce(new Error(CHANGED_ON_DISK));
		deps.ask.mockResolvedValueOnce(false);
		await docs.saveDocument(path, report);
		deps.writeText.mockRejectedValueOnce(new Error('read-only'));
		await docs.saveDocument(path, report);
		expect(saved).not.toHaveBeenCalled();
		stop();
		await docs.saveDocument(path, report);
		expect(saved).not.toHaveBeenCalled();
	});
});

describe('refresh', () => {
	const still = () => true;

	it('gives a clean document the text of a file changed on disk, and keeps it clean', async () => {
		const { docs, deps, report } = setup();
		const heard = vi.fn();
		docs.onDirtyChange(heard);
		const doc = await docs.openDocument(path);
		deps.readText.mockResolvedValueOnce({ text: 'disk', stamp: stamp(5) });
		await docs.refresh(path, still);
		expect(doc.model.getValue()).toBe('disk');
		expect(doc.stamp).toEqual(stamp(5));
		expect(docs.isDirty(path)).toBe(false);
		expect(heard).toHaveBeenLastCalledWith(path, false);
		// Not dirty even for a moment: dirty means an edit, which pins a preview tab.
		expect(heard).not.toHaveBeenCalledWith(path, true);
		await docs.saveDocument(path, report);
		expect(deps.writeText).not.toHaveBeenCalled();
	});

	it('leaves the text alone when the file has not changed', async () => {
		const { docs, deps, model } = setup();
		await docs.openDocument(path);
		const set = vi.spyOn(model(), 'setValue');
		deps.readText.mockResolvedValueOnce({ text: 'one', stamp: stamp(1) });
		await docs.refresh(path, still);
		expect(set).not.toHaveBeenCalled();
	});

	it('never reads for a dirty document, nor for a path with none', async () => {
		const { docs, deps, model } = setup();
		await docs.refresh(path, still);
		await docs.openDocument(path);
		model().edit('two');
		await docs.refresh(path, still);
		expect(deps.readText).toHaveBeenCalledTimes(1);
		expect(model().getValue()).toBe('two');
	});

	it('drops an answer the caller no longer wants, or that edits made since would lose', async () => {
		const { docs, deps, model } = setup();
		const doc = await docs.openDocument(path);
		deps.readText.mockResolvedValueOnce({ text: 'disk', stamp: stamp(5) });
		await docs.refresh(path, () => false);
		expect(doc.model.getValue()).toBe('one');
		const read = deferred<{ text: string; stamp: Stamp }>();
		deps.readText.mockReturnValueOnce(read.promise);
		const refreshed = docs.refresh(path, still);
		model().edit('typed');
		read.resolve({ text: 'disk', stamp: stamp(5) });
		await refreshed;
		expect(doc.model.getValue()).toBe('typed');
		expect(doc.stamp).toEqual(stamp(1));
	});
});

describe('onDirtyChange and dropDocument', () => {
	it('hears true on an edit and false after the save', async () => {
		const { docs, model, report } = setup();
		const heard = vi.fn();
		docs.onDirtyChange(heard);
		await docs.openDocument(path);
		model().edit('two');
		expect(heard).toHaveBeenLastCalledWith(path, true);
		await docs.saveDocument(path, report);
		expect(heard).toHaveBeenLastCalledWith(path, false);
	});

	it('hears false when a dirty document is dropped, which disposes its model', async () => {
		const { docs, model } = setup();
		const heard = vi.fn();
		docs.onDirtyChange(heard);
		await docs.openDocument(path);
		model().edit('two');
		docs.dropDocument(path);
		expect(heard).toHaveBeenLastCalledWith(path, false);
		expect(model().disposed).toBe(true);
		expect(docs.isDirty(path)).toBe(false);
	});

	it('reads the file again once its document was dropped', async () => {
		const { docs, deps } = setup();
		const first = await docs.openDocument(path);
		docs.dropDocument(path);
		expect(await docs.openDocument(path)).not.toBe(first);
		expect(deps.readText).toHaveBeenCalledTimes(2);
	});

	it('stops telling a listener that unsubscribed', async () => {
		const { docs, model } = setup();
		const heard = vi.fn();
		docs.onDirtyChange(heard)();
		await docs.openDocument(path);
		model().edit('two');
		expect(heard).not.toHaveBeenCalled();
	});
});
