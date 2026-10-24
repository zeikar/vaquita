// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AddRepo from './AddRepo.svelte';

let target: HTMLElement;
let app: ReturnType<typeof mount> | undefined;

function show(onadd = vi.fn()) {
	target = document.createElement('div');
	document.body.append(target);
	app = mount(AddRepo, { target, props: { disabled: false, onadd } });
	return onadd;
}

const button = () => target.querySelector<HTMLButtonElement>('button[aria-label="Add repo"]')!;
const field = () => target.querySelector<HTMLInputElement>('input');

function type(value: string, key = 'Enter') {
	const input = field()!;
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
	flushSync();
}

afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	target?.remove();
});

describe('AddRepo outside Tauri', () => {
	it('shows no field until the button is clicked', () => {
		show();
		expect(field()).toBeNull();
		button().click();
		flushSync();
		expect(field()?.placeholder).toBe('repo path');
	});

	it('rejects a relative path with an alert', () => {
		const onadd = show();
		button().click();
		flushSync();
		type('src/example');
		expect(target.querySelector('[role="alert"]')?.textContent).toBe('repo path must be an absolute path');
		expect(onadd).not.toHaveBeenCalled();
	});

	it('adds an absolute path and hides the field', () => {
		const onadd = show();
		button().click();
		flushSync();
		type(' /tmp/repo ');
		expect(onadd).toHaveBeenCalledWith('/tmp/repo');
		expect(field()).toBeNull();
	});

	it('hides the field on Escape', () => {
		show();
		button().click();
		flushSync();
		type('', 'Escape');
		expect(field()).toBeNull();
	});

	it('shows the field from open()', async () => {
		show();
		await (app as unknown as { open(): Promise<void> }).open();
		flushSync();
		expect(field()).not.toBeNull();
	});
});
