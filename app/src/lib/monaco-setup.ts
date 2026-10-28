// Monaco as the app uses it, loaded only through loadMonaco in monaco.ts so
// that a terminal-only run never fetches it.
//
// The editor's own features (find, folding, multicursor …) and Monarch
// highlighting for every language Monaco knows. The CSS, HTML, JSON and
// TypeScript language services are left out: each needs a worker of its own
// and brings diagnostics, more than a light editor is for. The editor worker
// is then the only one.
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/register.all';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export * from 'monaco-editor/editor/editor.api';
