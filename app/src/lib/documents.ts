import { ask } from './ask';
import { CHANGED_ON_DISK, readText, writeText, type Stamp } from './files';
import { languageFor, loadMonaco, type Monaco } from './monaco';
import { fileName } from './tabs';

type Model = import('./monaco-setup').editor.ITextModel;

// An open text file: its model, the stamp of the disk file the model's text was
// read from or last written to, and the model version that matches the disk.
export type Document = {
	model: Model;
	stamp: Stamp;
	savedVersion: number;
	saving?: Promise<void>;
};

export type DocumentDeps = {
	monaco: () => Promise<Monaco>;
	readText: typeof readText;
	writeText: typeof writeText;
	ask: (message: string, okLabel: string) => Promise<boolean>;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The documents of every open text tab, by path, outside any component: a tab
// shown again keeps its edits and the stamp they were made against, and the
// disk is read only when the path has no document.
export class Documents {
	private docs = new Map<string, Document>();
	// Reads in flight: Monaco refuses a second model for the same URI, so tabs
	// switched back and forth before a read lands share it.
	private pending = new Map<string, Promise<Document>>();
	// Raised by every drop, so a read that was in flight then makes no model:
	// the tab it was for is closed, and its text could be stale by a reopen.
	private drops = new Map<string, number>();
	private listeners = new Set<(path: string, dirty: boolean) => void>();

	constructor(private deps: DocumentDeps) {}

	openDocument(path: string): Promise<Document> {
		const doc = this.docs.get(path);
		if (doc) return Promise.resolve(doc);
		const pending = this.pending.get(path);
		if (pending) return pending;
		const open: Promise<Document> = this.read(path).finally(() => {
			// A drop may have let a newer open take the entry.
			if (this.pending.get(path) === open) this.pending.delete(path);
		});
		this.pending.set(path, open);
		return open;
	}

	private async read(path: string): Promise<Document> {
		const drops = this.drops.get(path) ?? 0;
		const [monaco, { text, stamp }] = await Promise.all([this.deps.monaco(), this.deps.readText(path)]);
		if ((this.drops.get(path) ?? 0) !== drops) throw new Error(`${fileName(path)} was closed while it was read`);
		const model = monaco.editor.createModel(text, languageFor(monaco, path), monaco.Uri.file(path));
		const doc: Document = { model, stamp, savedVersion: model.getAlternativeVersionId() };
		model.onDidChangeContent(() => this.tell(path, this.isDirty(path)));
		// Before the pending entry is cleared, so no open in between reads again.
		this.docs.set(path, doc);
		return doc;
	}

	// The text as edited, saved or not, for a path with a document.
	textOf(path: string): string | undefined {
		return this.docs.get(path)?.model.getValue();
	}

	// An undo back to the saved text is not dirty.
	isDirty(path: string): boolean {
		const doc = this.docs.get(path);
		return doc !== undefined && doc.model.getAlternativeVersionId() !== doc.savedVersion;
	}

	// Hears whether a path is dirty on every edit, after every save and, with
	// false, when its document is dropped. Returns a function that stops it.
	onDirtyChange(listener: (path: string, dirty: boolean) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private tell(path: string, dirty: boolean): void {
		for (const l of this.listeners) l(path, dirty);
	}

	// A clean document takes the file's text when the file changed since it
	// was read, so an unedited tab shows what an agent wrote since. Edits are
	// never replaced: saving them asks before overwriting the file. still says
	// whether the caller wants the answer when it comes.
	async refresh(path: string, still: () => boolean): Promise<void> {
		const doc = this.docs.get(path);
		if (!doc || this.isDirty(path)) return;
		const version = doc.model.getAlternativeVersionId();
		const { text, stamp } = await this.deps.readText(path);
		if (!still() || this.docs.get(path) !== doc || doc.model.getAlternativeVersionId() !== version) return;
		if (stamp.secs === doc.stamp.secs && stamp.nanos === doc.stamp.nanos && stamp.len === doc.stamp.len) return;
		doc.model.setValue(text);
		doc.stamp = stamp;
		doc.savedVersion = doc.model.getAlternativeVersionId();
		// The edit event of setValue came before savedVersion caught up.
		this.tell(path, false);
	}

	// Unsaved edits are lost: the caller asks first.
	dropDocument(path: string): void {
		this.drops.set(path, (this.drops.get(path) ?? 0) + 1);
		this.pending.delete(path);
		const doc = this.docs.get(path);
		if (!doc) return;
		this.docs.delete(path);
		this.tell(path, false);
		doc.model.dispose();
	}

	// One save per document at a time: a save asked for during a write waits
	// for it, then writes whatever was typed since, if anything was.
	async saveDocument(path: string, report: (message: string) => void): Promise<void> {
		const doc = this.docs.get(path);
		if (!doc) return;
		while (doc.saving) await doc.saving;
		if (this.docs.get(path) !== doc || !this.isDirty(path)) return;
		const saving = this.write(path, doc, report);
		doc.saving = saving;
		try {
			await saving;
		} finally {
			if (doc.saving === saving) doc.saving = undefined;
		}
	}

	// Never rejects: failures go to report, so a save waiting on this one runs.
	private async write(path: string, doc: Document, report: (message: string) => void): Promise<void> {
		// Taken before the write awaits: typing during it changes the model, and
		// only the version that was written may count as saved.
		const text = doc.model.getValue();
		const version = doc.model.getAlternativeVersionId();
		const name = fileName(path);
		try {
			let stamp: Stamp;
			try {
				stamp = await this.deps.writeText(path, text, doc.stamp);
			} catch (e) {
				if (message(e) !== CHANGED_ON_DISK) throw e;
				if (!(await this.deps.ask(`${name} changed on disk since you opened it. Overwrite it?`, 'Overwrite'))) return;
				stamp = await this.deps.writeText(path, text);
			}
			doc.stamp = stamp;
			doc.savedVersion = version;
			// A save changes no content, so no edit event would clear the dot.
			if (this.docs.get(path) === doc) this.tell(path, this.isDirty(path));
		} catch (e) {
			const why = message(e);
			report(why === 'read-only' ? `${name} is read-only` : `saving ${name} failed: ${why}`);
		}
	}
}

export const documents = new Documents({ monaco: loadMonaco, readText, writeText, ask });
