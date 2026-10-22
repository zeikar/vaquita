import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from './tauri';

// Calls set with whether the window has focus, now and on every change,
// until the returned function is called. Inside Tauri that is the native
// window's focus, outside it the page's. onError gets a failure to watch
// the native window.
export function watchFocus(set: (focused: boolean) => void, onError: (e: unknown) => void): () => void {
	if (isTauri()) {
		const win = getCurrentWindow();
		// The window is asked once the listener is in place; a change heard
		// before the answer comes is newer than it.
		let heard = false;
		const unlisten = win.onFocusChanged(({ payload }) => {
			heard = true;
			set(payload);
		});
		void unlisten
			.then(() => win.isFocused())
			.then(
				(focused) => {
					if (!heard) set(focused);
				},
				(e) => {
					// Left as it was, the focus could hide notifications the
					// user needs; the page's focus is the best guess left.
					if (!heard) set(document.hasFocus());
					onError(e);
				},
			);
		// A failure to listen was reported above.
		return () => void unlisten.then((stop) => stop(), () => {});
	}
	const focus = () => set(true);
	const blur = () => set(false);
	window.addEventListener('focus', focus);
	window.addEventListener('blur', blur);
	set(document.hasFocus());
	return () => {
		window.removeEventListener('focus', focus);
		window.removeEventListener('blur', blur);
	};
}
