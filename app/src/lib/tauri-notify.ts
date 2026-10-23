import { isTarget, type Notice, type Notifier, type Target } from './notify';

// The app's notification commands (src-tauri/src/notify.rs). listen hears
// clicks, whose payload is the clicked notification's target or null.
// permission says whether macOS lets the app show notifications.
export interface NotificationApi {
	listen(onClick: (payload: unknown) => void): Promise<() => void>;
	permission(): Promise<boolean>;
	notify(n: Notice): Promise<void>;
}

// allowed is false when notifications are turned off for the app in System
// Settings. stop removes the click listener, so a page that sets up another
// notifier does not get each click twice.
export interface TauriNotifier extends Notifier {
	allowed: boolean;
	stop(): void;
}

// Loaded lazily so a plain-browser page never imports Tauri.
async function tauriApi(): Promise<NotificationApi> {
	const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
	return {
		listen: (onClick) => listen('notification-click', (event) => onClick(event.payload)),
		permission: () => invoke<boolean>('notification_permission'),
		notify: ({ title, body, target }) => invoke('notify', { title, body, target }),
	};
}

// Shows notifications through the app's own UNUserNotificationCenter commands.
// A click hands back the target its notification was sent with. onError gets
// a notification that could not be sent. Notifications turned off still get
// sent: macOS drops them until the user turns them on.
export async function createTauriNotifier(
	onClick: (target?: Target) => void,
	onError: (e: unknown) => void,
	api?: NotificationApi,
): Promise<TauriNotifier> {
	const native = api ?? (await tauriApi());
	const allowed = await native.permission();
	const stop = await native.listen((payload) => onClick(isTarget(payload) ? payload : undefined));
	return { allowed, show: (n) => void native.notify(n).catch(onError), stop };
}
