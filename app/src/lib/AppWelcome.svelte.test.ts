// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppWelcome from './AppWelcome.svelte';

let target: HTMLElement;
let shown: ReturnType<typeof mount> | undefined;

function show(props: { version?: string; addDisabled?: boolean } = {}) {
	target = document.createElement('div');
	document.body.append(target);
	const onaddrepo = vi.fn();
	const onnewsession = vi.fn();
	shown = mount(AppWelcome, { target, props: { addDisabled: false, ...props, onaddrepo, onnewsession } });
	flushSync();
	return { onaddrepo, onnewsession, welcome: shown as { focus(): void } };
}

const button = (text: string) =>
	[...target.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

afterEach(() => {
	if (shown) unmount(shown);
	shown = undefined;
	target.remove();
});

describe('AppWelcome', () => {
	it('shows the name, the lede, the actions, the hint and the version', () => {
		show({ version: '0.1.19' });
		expect(target.querySelector('h1')?.textContent).toBe('vaquita');
		expect(target.textContent).toContain(
			'Claude Code and Codex, side by side on your Mac. Sessions keep running when the app quits.',
		);
		expect(button('Add a repo')).toBeTruthy();
		expect(button('New session').querySelector('kbd')?.textContent).toBe('⌘T');
		expect(button('Add a repo').querySelector('kbd')).toBeNull();
		expect(target.textContent).toContain('Or drop a folder on the sidebar.');
		expect(target.textContent).toContain('0.1.19');
	});

	it('shows no version when it is unknown', () => {
		show();
		expect(target.textContent).not.toMatch(/\d+\.\d+/);
	});

	it('calls back from each action', () => {
		const { onaddrepo, onnewsession } = show();
		button('Add a repo').click();
		expect(onaddrepo).toHaveBeenCalledTimes(1);
		expect(onnewsession).not.toHaveBeenCalled();
		button('New session').click();
		expect(onnewsession).toHaveBeenCalledTimes(1);
	});

	it('disables Add a repo on request', () => {
		const { onaddrepo } = show({ addDisabled: true });
		expect(button('Add a repo').disabled).toBe(true);
		expect(button('New session').disabled).toBe(false);
		button('Add a repo').click();
		expect(onaddrepo).not.toHaveBeenCalled();
	});

	it('takes the focus on its root', () => {
		const { welcome } = show();
		welcome.focus();
		const root = target.firstElementChild as HTMLElement;
		expect(root.tabIndex).toBe(-1);
		expect(document.activeElement).toBe(root);
	});
});
