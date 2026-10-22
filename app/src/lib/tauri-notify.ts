import type { ActionPerformed, Options } from '@tauri-apps/plugin-notification';
import { isTarget, type Notifier, type Target } from './notify';

// The part of the notification plugin used here.
export interface NotificationApi {
	onAction(cb: (event: ActionPerformed) => void): Promise<{ unregister(): Promise<void> }>;
	isPermissionGranted(): Promise<boolean>;
	requestPermission(): Promise<unknown>;
	sendNotification(options: Options): void;
}

// stop removes the click listener, so a page that sets up another notifier
// does not get each click twice.
export interface TauriNotifier extends Notifier {
	stop(): Promise<void>;
}

// Shows notifications through the notification plugin. A click hands back
// the payload its notification was sent with, so each carries its own
// target there. The plugin is loaded lazily so a plain-browser page never
// imports Tauri.
export async function createTauriNotifier(onClick: (target?: Target) => void, api?: NotificationApi): Promise<TauriNotifier> {
	const plugin: NotificationApi = api ?? (await import('@tauri-apps/plugin-notification'));
	// A notification reports its click only if the listener existed when it
	// was sent, so the notifier is handed out once it does.
	const listener = await plugin.onAction((event) => {
		if (event.actionId !== 'tap') return;
		const extra = event.notification?.extra;
		onClick(isTarget(extra) ? extra : undefined);
	});
	// The plugin's desktop side always answers granted; whether macOS shows
	// the notifications is up to its settings for the app. A failure here
	// leaves no notifier to stop, so the listener goes with it.
	try {
		if (!(await plugin.isPermissionGranted())) await plugin.requestPermission();
	} catch (e) {
		await listener.unregister().catch(() => {});
		throw e;
	}
	return {
		show: ({ title, body, target }) =>
			plugin.sendNotification(target ? { title, body, extra: target } : { title, body }),
		stop: () => listener.unregister(),
	};
}
