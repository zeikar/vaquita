type Render = (text: string) => string;

let loading: Promise<Render> | undefined;

// Loaded with the first markdown preview, so that terminal-only use never
// fetches either library.
function load(): Promise<Render> {
	loading ??= Promise.all([import('marked'), import('dompurify')]).then(([{ Marked }, { default: purify }]) => {
		// Unsupported, DOMPurify hands the HTML back as it came.
		if (!purify.isSupported) throw new Error('the preview cannot sanitize HTML here');
		const marked = new Marked({
			gfm: true,
			async: false,
			// A task's box as text: the sanitizer drops input elements.
			renderer: { checkbox: ({ checked }) => (checked ? '☑' : '☐') },
		});
		// The preview loads an image itself, once the app let its file through
		// (MarkdownView): the page must fetch nothing a file names, so what an
		// img names waits in data-src, and a data-src of the file's own goes.
		purify.addHook('afterSanitizeAttributes', (node) => {
			if (node.nodeName !== 'IMG') return;
			const src = node.getAttribute('src');
			for (const name of ['src', 'srcset', 'data-src']) node.removeAttribute(name);
			if (src) node.setAttribute('data-src', src);
		});
		return (text) =>
			purify.sanitize(marked.parse(text) as string, {
				// The file is untrusted (an agent wrote it) and the preview lives in
				// the app's document, where script can invoke commands. DOMPurify
				// already drops scripts, handlers and javascript: URLs. Beyond that:
				// no media but img, which the CSP would block anyway and leave as
				// broken players; no form or its fields, as a submission
				// navigates past any click handler; and no style element or
				// attribute, which would restyle the app around the preview, nor a
				// class or id, which the app's own rules would style (a file could
				// dress up as the app's update card). HTML only: SVG and MathML would
				// bring images of their own (image, feImage), which load by themselves.
				USE_PROFILES: { html: true },
				FORBID_TAGS: ['picture', 'video', 'audio', 'source', 'form', 'input', 'button', 'textarea', 'select', 'style'],
				FORBID_ATTR: ['style', 'class', 'id'],
			});
	});
	return loading;
}

// Markdown as sanitized HTML, for {@html}.
export async function renderMarkdown(text: string): Promise<string> {
	return (await load())(withFrontMatter(text));
}

// The file an image's src names, or undefined for what the preview does not
// load: a URL with a scheme or a host. A src is a URL, so a query or a fragment
// is cut and escapes are undone.
export function imageFile(src: string): string | undefined {
	if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) return undefined;
	const path = src.replace(/[?#].*$/s, '');
	if (path === '') return undefined;
	try {
		return decodeURIComponent(path);
	} catch {
		// Not an escape after all (100%.png): the name as written.
		return path;
	}
}

// A leading YAML front matter block (Jekyll, Hugo, Astro) is not Markdown: read
// as such, its opening --- is a rule and its closing --- turns the lines above
// into one large heading. It is shown as a YAML code block instead.
export function withFrontMatter(text: string): string {
	// The block may be empty: the closing line can follow the opening one.
	const m = /^---\r?\n(?:([\s\S]*?)\r?\n)??(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
	if (!m) return text;
	const yaml = m[1] ?? '';
	// A fence longer than any run of backticks inside, so none can close it early.
	let longest = 0;
	for (const run of yaml.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return `${fence}yaml\n${yaml}\n${fence}\n\n${text.slice(m[0].length)}`;
}
