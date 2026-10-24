import { STATE_RUNNING, type SessionInfo } from './protocol';

// What a vaquitad built without a release version reports, the Makefile's
// default VERSION: a developer's own, which the app leaves alone. A local
// `tauri build` ships one too, beside the version in tauri.conf.json, so
// comparing the two would find its own daemon outdated.
export const DEV_BUILD = 'dev';

export type UpdateAction = 'none' | 'restart-now' | 'offer';

// What the UI shows while the daemon is not the one this app ships and
// replacing it is left to the user.
export interface DaemonUpdate {
	// The running daemon's build; undefined for one older than builds.
	daemon?: string;
	app: string;
	// Why the last restart did not leave this app's daemon running.
	note?: string;
}

// appBuild is null in a dev run, which never manages the daemon; daemonBuild
// is the hello's, undefined from a daemon older than builds. An outdated
// daemon is restarted at once only when that ends no running session, and
// only once per app run, so a restart that brings back the same build never
// loops; otherwise the user is offered the restart. The daemon itself makes
// sure no session runs when it stops, which one older than builds cannot, so
// restarting that takes the user's click.
export function updateAction(
	appBuild: string | null,
	daemonBuild: string | undefined,
	running: number,
	autoTried: boolean,
): UpdateAction {
	if (appBuild === null || daemonBuild === DEV_BUILD || daemonBuild === appBuild) return 'none';
	return daemonBuild !== undefined && running === 0 && !autoTried ? 'restart-now' : 'offer';
}

// The sessions a daemon restart ends. Records of an earlier run and exited
// sessions hold no process of the daemon's.
export function runningCount(list: Iterable<SessionInfo>): number {
	let n = 0;
	for (const info of list) if (info.state === STATE_RUNNING) n++;
	return n;
}
