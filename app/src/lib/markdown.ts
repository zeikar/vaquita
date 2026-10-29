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
		return (text) =>
			purify.sanitize(marked.parse(text) as string, {
				// The file is untrusted (an agent wrote it) and the preview lives in
				// the app's document, where script can invoke commands. DOMPurify
				// already drops scripts, handlers and javascript: URLs. Beyond that:
				// no img or other media, which the CSP would block anyway and leave as
				// broken icons and players; no form or its fields, as a submission
				// navigates past any click handler; and no style element or
				// attribute, which would restyle the app around the preview, nor a
				// class or id, which the app's own rules would style (a file could
				// dress up as the app's update card). HTML only: SVG and MathML would
				// bring images back by other names (image, feImage).
				USE_PROFILES: { html: true },
				FORBID_TAGS: ['img', 'picture', 'video', 'audio', 'source', 'form', 'input', 'button', 'textarea', 'select', 'style'],
				FORBID_ATTR: ['style', 'class', 'id'],
			});
	});
	return loading;
}

// Markdown as sanitized HTML, for {@html}.
export async function renderMarkdown(text: string): Promise<string> {
	return (await load())(withFrontMatter(text));
}

// A leading YAML front matter block (Jekyll, Hugo, Astro) is not Markdown: read
// as such, its opening --- is a rule and its closing --- turns the lines above
// into one large heading. It is shown as a YAML code block instead.
export function withFrontMatter(text: string): string {
	const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
	if (!m) return text;
	// A fence longer than any run of backticks inside, so none can close it early.
	const longest = Math.max(0, ...(m[1].match(/`+/g) ?? []).map((run) => run.length));
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return `${fence}yaml\n${m[1]}\n${fence}\n\n${text.slice(m[0].length)}`;
}
