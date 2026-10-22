import type { ActionPerformed, ActiveNotification, Options } from '@tauri-apps/plugin-notification';
import { describe, expect, it } from 'vitest';
import type { Target } from './notify';
import { createTauriNotifier, type NotificationApi } from './tauri-notify';

class FakePlugin implements NotificationApi {
	calls: string[] = [];
	sent: Options[] = [];
	granted = true;
	listener?: (event: ActionPerformed) => void;
	registered?: () => void;
	unregistered = false;

	onAction(cb: (event: ActionPerformed) => void) {
		this.calls.push('onAction');
		this.listener = cb;
		const unregister = async () => void (this.unregistered = true);
		return new Promise<{ unregister(): Promise<void> }>((resolve) => (this.registered = () => resolve({ unregister })));
	}
	async isPermissionGranted() {
		this.calls.push('isPermissionGranted');
		return this.granted;
	}
	async requestPermission() {
		this.calls.push('requestPermission');
		return 'granted';
	}
	sendNotification(options: Options) {
		this.sent.push(options);
	}
	tap(actionId: string, extra?: Record<string, unknown>) {
		const notification = extra && ({ id: 1, groupSummary: false, data: {}, extra, attachments: [] } as ActiveNotification);
		this.listener!({ actionId, inputValue: null, notification: notification ?? null });
	}
}

async function ready(plugin: FakePlugin, onClick: (target?: Target) => void = () => {}) {
	const notifier = createTauriNotifier(onClick, plugin);
	await Promise.resolve();
	plugin.registered!();
	return notifier;
}

describe('createTauriNotifier', () => {
	it('resolves only once the click listener is registered', async () => {
		const plugin = new FakePlugin();
		let done = false;
		const notifier = createTauriNotifier(() => {}, plugin).then(() => (done = true));
		await new Promise((r) => setTimeout(r));
		expect(plugin.calls).toEqual(['onAction']);
		expect(done).toBe(false);
		plugin.registered!();
		await notifier;
		expect(plugin.calls).toEqual(['onAction', 'isPermissionGranted']);
	});

	it('asks for permission when it is not granted', async () => {
		const plugin = new FakePlugin();
		plugin.granted = false;
		await ready(plugin);
		expect(plugin.calls).toEqual(['onAction', 'isPermissionGranted', 'requestPermission']);
	});

	it('sends the target in the extra payload, and none for the summary', async () => {
		const plugin = new FakePlugin();
		const notifier = await ready(plugin);
		notifier.show({ title: 'build done', body: 'ok', target: { sid: 3, inc: 'a' } });
		notifier.show({ title: 'vaquita', body: '2 notifications while you were away' });
		expect(plugin.sent).toEqual([
			{ title: 'build done', body: 'ok', extra: { sid: 3, inc: 'a' } },
			{ title: 'vaquita', body: '2 notifications while you were away' },
		]);
		expect('extra' in plugin.sent[1]).toBe(false);
	});

	it('hands a click the target its notification carries, else none', async () => {
		const plugin = new FakePlugin();
		const clicks: (Target | undefined)[] = [];
		await ready(plugin, (t) => clicks.push(t));
		plugin.tap('tap', { sid: 3, inc: 'a' });
		plugin.tap('tap', {});
		plugin.tap('tap');
		plugin.tap('tap', { sid: '3', inc: 'a' });
		expect(clicks).toEqual([{ sid: 3, inc: 'a' }, undefined, undefined, undefined]);
	});

	it('removes the click listener on stop', async () => {
		const plugin = new FakePlugin();
		const notifier = await ready(plugin);
		expect(plugin.unregistered).toBe(false);
		await notifier.stop();
		expect(plugin.unregistered).toBe(true);
	});

	it('ignores actions other than a click on the notification', async () => {
		const plugin = new FakePlugin();
		const clicks: (Target | undefined)[] = [];
		await ready(plugin, (t) => clicks.push(t));
		plugin.tap('snooze', { sid: 3, inc: 'a' });
		expect(clicks).toEqual([]);
	});
});
