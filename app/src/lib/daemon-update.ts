import { STATE_RUNNING, type SessionInfo } from './protocol';

// What a vaquitad built without a release version reports, the Makefile's
// default: a developer's own, which the app leaves alone. A local `tauri build`
// ships one too, and never replaces a running daemon with it.
export const DEV_BUILD = 'dev';

// A release's build is its version, a +, and a fingerprint of the daemon's
// code (see daemon/Makefile), so releases that left the daemon alone ship the
// same code. A build from before fingerprints is compared whole.
function code(build: string): string {
	const plus = build.indexOf('+');
	return plus < 0 ? build : build.slice(plus + 1);
}

// A build as the bar names it: its version, without the fingerprint.
export function shownBuild(build: string): string {
	const plus = build.indexOf('+');
	return plus < 0 ? build : build.slice(0, plus);
}

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

// appBuild is the build of the vaquitad the app ships, null in a dev run,
// which never manages the daemon; daemonBuild is the hello's, undefined from a
// daemon older than builds. Builds are compared by the daemon code they name. An outdated
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
	if (appBuild === null || appBuild === DEV_BUILD || daemonBuild === DEV_BUILD) return 'none';
	if (daemonBuild !== undefined && code(daemonBuild) === code(appBuild)) return 'none';
	return daemonBuild !== undefined && running === 0 && !autoTried ? 'restart-now' : 'offer';
}

// The sessions a daemon restart ends. Records of an earlier run and exited
// sessions hold no process of the daemon's.
export function runningCount(list: Iterable<SessionInfo>): number {
	let n = 0;
	for (const info of list) if (info.state === STATE_RUNNING) n++;
	return n;
}
