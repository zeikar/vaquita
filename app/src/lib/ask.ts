import { isTauri } from './tauri';

// A native yes-or-no question; in a plain browser, confirm() stands in.
export async function ask(message: string, okLabel: string): Promise<boolean> {
	if (!isTauri()) return window.confirm(message);
	const { ask } = await import('@tauri-apps/plugin-dialog');
	return ask(message, { kind: 'warning', okLabel, cancelLabel: 'Cancel' });
}
