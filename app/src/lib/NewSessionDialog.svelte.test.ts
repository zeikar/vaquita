// @vitest-environment happy-dom
// Named .svelte.test.ts so that the props can be $state: the dialog opens and
// closes as open changes. happy-dom's showModal() only sets open, and nothing
// turns an Enter into a submission, so the form is submitted by a click on
// Create; Enter and the platform's own focus handling are left to a browser.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewSessionDialog from './NewSessionDialog.svelte';

let target: HTMLElement;
let app: ReturnType<typeof mount> | undefined;

function show(init: { defaultCwd?: string; repos?: string[]; disabled?: boolean } = {}) {
	const props = $state({
		open: true,
		repos: init.repos ?? ['/tmp/repo', '/tmp/repo-feature'],
		defaultCwd: init.defaultCwd ?? '',
		disabled: init.disabled ?? false,
		oncreate: vi.fn(),
		onclose: vi.fn(),
	});
	target = document.createElement('div');
	document.body.append(target);
	app = mount(NewSessionDialog, { target, props });
	flushSync();
	return props;
}

const dialog = () => target.querySelector('dialog')!;
const folder = () => target.querySelector<HTMLInputElement>('input[aria-label="Folder"]')!;
const repo = () => target.querySelector<HTMLSelectElement>('select[aria-label="Repo"]')!;
const nameInput = () => target.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
const radio = (label: string) =>
	[...target.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.parentElement!.textContent?.trim() === label)!;
const create = () => [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Create')!;
const cancelButton = () => [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Cancel')!;
const alert = () => target.querySelector('[role="alert"]');

function type(el: HTMLInputElement, text: string) {
	el.value = text;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

function click(el: HTMLElement) {
	el.click();
	flushSync();
}

function escape(init: KeyboardEventInit = {}): KeyboardEvent {
	const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
	folder().dispatchEvent(e);
	flushSync();
	return e;
}

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	target?.remove();
	localStorage.clear();
});

describe('NewSessionDialog', () => {
	it('opens as a modal titled New session, with defaultCwd in the focused path and Shell chosen', () => {
		const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
		show({ defaultCwd: '/tmp/repo' });
		expect(showModal).toHaveBeenCalledTimes(1);
		expect(dialog().open).toBe(true);
		expect(target.querySelector('h2')?.textContent).toBe('New session');
		expect(folder().value).toBe('/tmp/repo');
		expect(document.activeElement).toBe(folder());
		expect(radio('Shell').checked).toBe(true);
		expect(repo().value).toBe('/tmp/repo');
		showModal.mockRestore();
	});

	it('shows the kinds with their marks', () => {
		show();
		const icons = [...target.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(
			(r) => r.parentElement!.querySelector<SVGElement>('svg')?.dataset.icon,
		);
		expect(icons).toEqual(['command-line', 'claude', 'openai']);
	});

	it('fills the path from the chosen repo, and empties it for the blank one', () => {
		show();
		expect(repo().value).toBe('');
		expect([...repo().options].map((o) => o.textContent)).toEqual(['Repo…', 'repo', 'repo-feature']);
		repo().value = '/tmp/repo-feature';
		repo().dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(folder().value).toBe('/tmp/repo-feature');
		type(folder(), '/tmp/repo-feature/sub');
		expect(repo().value).toBe('');
		type(folder(), '/tmp/repo');
		expect(repo().value).toBe('/tmp/repo');
		repo().value = '';
		repo().dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(folder().value).toBe('');
	});

	it('has no repo choice without repos', () => {
		show({ repos: [] });
		expect(target.querySelector('select')).toBeNull();
	});

	it('refuses a relative path with an alert, creating nothing', () => {
		const p = show();
		type(folder(), 'src/example');
		click(create());
		expect(alert()?.textContent).toBe('folder must be an absolute path');
		expect(p.oncreate).not.toHaveBeenCalled();
		expect(p.onclose).not.toHaveBeenCalled();
		expect(localStorage.getItem('vaquita.cwd')).toBeNull();
	});

	it('creates with the chosen kind and the trimmed name, remembers the folder, then closes', () => {
		const p = show({ defaultCwd: '/tmp/repo' });
		click(radio('Claude'));
		type(nameInput(), '  fix login ');
		click(create());
		expect(alert()).toBeNull();
		expect(p.oncreate).toHaveBeenCalledTimes(1);
		expect(p.oncreate).toHaveBeenCalledWith('/tmp/repo', 'claude', 'fix login');
		expect(p.onclose).toHaveBeenCalledTimes(1);
		expect(p.oncreate.mock.invocationCallOrder[0]).toBeLessThan(p.onclose.mock.invocationCallOrder[0]);
		expect(localStorage.getItem('vaquita.cwd')).toBe('/tmp/repo');
	});

	it('creates a shell by default, and a codex session, in the home folder for an empty path', () => {
		const p = show();
		type(folder(), '  ');
		click(create());
		expect(p.oncreate).toHaveBeenLastCalledWith('', '', '');
		click(radio('Codex'));
		click(create());
		expect(p.oncreate).toHaveBeenLastCalledWith('', 'codex', '');
	});

	it('closes on Escape and on Cancel without creating', () => {
		const p = show();
		const e = escape();
		// Prevented, so that the platform's cancel does not close it a second time.
		expect(e.defaultPrevented).toBe(true);
		expect(p.onclose).toHaveBeenCalledTimes(1);
		click(cancelButton());
		expect(p.onclose).toHaveBeenCalledTimes(2);
		expect(p.oncreate).not.toHaveBeenCalled();
	});

	it('leaves an Escape that belongs to an IME alone', () => {
		const p = show();
		type(folder(), '/tmp/한');
		for (const init of [{ isComposing: true }, { isComposing: false, keyCode: 229 }]) {
			const e = escape(init);
			// Prevented too, or the platform's cancel would close it.
			expect(e.defaultPrevented, JSON.stringify(init)).toBe(true);
		}
		expect(p.onclose).not.toHaveBeenCalled();
		expect(dialog().open).toBe(true);
	});

	it('routes the platform cancel to onclose, keeping the dialog until open turns false', () => {
		const p = show();
		const e = new Event('cancel', { cancelable: true });
		dialog().dispatchEvent(e);
		expect(e.defaultPrevented).toBe(true);
		expect(p.onclose).toHaveBeenCalledTimes(1);
		expect(dialog().open).toBe(true);
	});

	it('disables Create while disabled', () => {
		const p = show({ defaultCwd: '/tmp/repo', disabled: true });
		expect(create().disabled).toBe(true);
		click(create());
		expect(p.oncreate).not.toHaveBeenCalled();
	});

	it('closes when open turns false, and starts afresh on the next open', () => {
		const p = show({ defaultCwd: '/tmp/repo' });
		click(radio('Codex'));
		type(nameInput(), 'x');
		type(folder(), 'relative');
		click(create());
		expect(alert()).not.toBeNull();
		p.open = false;
		flushSync();
		expect(dialog().open).toBe(false);
		p.defaultCwd = '/tmp/repo-feature';
		p.open = true;
		flushSync();
		expect(dialog().open).toBe(true);
		expect(folder().value).toBe('/tmp/repo-feature');
		expect(nameInput().value).toBe('');
		expect(radio('Shell').checked).toBe(true);
		expect(alert()).toBeNull();
		expect(document.activeElement).toBe(folder());
	});

	it('keeps what was typed when defaultCwd changes while open', () => {
		const p = show({ defaultCwd: '/tmp/repo' });
		type(folder(), '/tmp/other');
		p.defaultCwd = '/tmp/repo-feature';
		flushSync();
		expect(folder().value).toBe('/tmp/other');
	});
});
