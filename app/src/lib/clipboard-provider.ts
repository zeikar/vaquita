import type { ClipboardSelectionType, IClipboardProvider } from '@xterm/addon-clipboard';
import { writeClipboard, type ClipboardWriter } from './clipboard';

const MAX_CLIPBOARD = 1024 * 1024;

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// OSC 52 is write only: a program in the terminal must not read the clipboard.
// replaying says the parser is working through replayed output, whose old
// copies must not overwrite what the user has copied since.
export function clipboardProvider(
	replaying: () => boolean,
	report: (message: string) => void,
	write: ClipboardWriter = writeClipboard,
): IClipboardProvider {
	return {
		readText: (_selection: ClipboardSelectionType) => '',
		writeText: async (selection: ClipboardSelectionType, text: string) => {
			if (replaying()) return;
			// Like the default provider, only the system clipboard is written.
			if (selection !== 'c') return;
			if (text.length > MAX_CLIPBOARD) {
				report('clipboard write ignored: too large');
				return;
			}
			try {
				await write(text);
			} catch (e) {
				report(`clipboard write failed: ${errText(e)}`);
			}
		},
	};
}
