const CONFIRM_MS = 3000;
// A double-click must not count as the confirming second click.
const MIN_CONFIRM_MS = 400;

// Buttons that act only on a second click: Tauri's WKWebView answers
// confirm() with Cancel, as wry implements no JavaScript confirm panel. The
// key says which button is armed, such as kill:3 or dismiss:3.
export class Confirm {
	armed = $state<string | undefined>();
	private armedAt = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;

	disarm = (): void => {
		clearTimeout(this.timer);
		this.armed = undefined;
	};

	click(key: string, act: () => void): void {
		if (this.armed === key) {
			if (performance.now() - this.armedAt < MIN_CONFIRM_MS) return;
			this.disarm();
			act();
			return;
		}
		this.disarm();
		this.armed = key;
		this.armedAt = performance.now();
		this.timer = setTimeout(this.disarm, CONFIRM_MS);
	}
}
