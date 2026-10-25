import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AppUpdate } from './app-update';
import { isTauri } from './tauri';

export interface Endpoint {
	url: string;
	token: string;
	pid: number;
}

export class NotRunningError extends Error {
	constructor() {
		super('daemon not running');
		this.name = 'NotRunningError';
	}
}

function isEndpoint(v: unknown): v is Endpoint {
	const e = v as Partial<Endpoint> | null;
	return typeof e?.url === 'string' && typeof e.token === 'string';
}

export async function readEndpoint(): Promise<Endpoint> {
	if (isTauri()) {
		try {
			const body: unknown = await invoke('endpoint');
			if (!isEndpoint(body)) throw new Error('malformed endpoint');
			return body;
		} catch (e) {
			if (e === 'not-running') throw new NotRunningError();
			throw new Error(String(e));
		}
	}
	const res = await fetch('/__vaquita/endpoint');
	if (res.status === 503) throw new NotRunningError();
	if (!res.ok) throw new Error(`endpoint request failed: ${res.status}`);
	const body: unknown = await res.json();
	if (!isEndpoint(body)) throw new Error('malformed endpoint');
	return body;
}

// Keep this hint identical to the one in src-tauri/src/lib.rs.
const DEV_HINT =
	'dev run: start the daemon from a terminal: VAQUITA_HOME=~/.vaquita-dev vaquitad serve --allow-origin http://localhost:1420';

// Resolves once the daemon has written its endpoint file.
export async function startDaemon(): Promise<void> {
	if (!isTauri()) throw new Error(DEV_HINT);
	try {
		await invoke('start_daemon');
	} catch (e) {
		throw new Error(String(e));
	}
}

// A release build's version, which the release also stamps into the vaquitad
// it ships; null in a dev run and in a plain browser.
export async function appBuild(): Promise<string | null> {
	if (!isTauri()) return null;
	return invoke<string | null>('app_build');
}

// Rejects when the app could not start a daemon of its own, so that none is
// stopped.
export async function checkRestart(): Promise<void> {
	if (!isTauri()) throw new Error(DEV_HINT);
	try {
		await invoke('check_restart');
	} catch (e) {
		throw new Error(String(e));
	}
}

// Stops the daemon at endpoint, with SIGTERM when signal is set, else waiting
// for it to exit after it agreed to a shutdown request, and starts the app's
// own; resolves once the new one has written its endpoint file.
export async function restartDaemon(endpoint: Endpoint, signal: boolean): Promise<void> {
	if (!isTauri()) throw new Error(DEV_HINT);
	try {
		await invoke('restart_daemon', { pid: endpoint.pid, token: endpoint.token, signal });
	} catch (e) {
		throw new Error(String(e));
	}
}

// The newer release this app could install, null when there is none; also in
// a dev run, a plain browser and a build without an update feed.
export async function checkAppUpdate(): Promise<AppUpdate | null> {
	if (!isTauri()) return null;
	try {
		return await invoke<AppUpdate | null>('check_app_update');
	} catch (e) {
		throw new Error(String(e));
	}
}

// Downloads and installs the update found, then restarts the app, so on success
// the promise never settles.
export async function installAppUpdate(): Promise<void> {
	if (!isTauri()) throw new Error('updates are installed by the app, not in a browser');
	try {
		await invoke('install_app_update');
	} catch (e) {
		throw new Error(String(e));
	}
}

// Runs ask on each click of the app menu's Check for Updates, which only a
// release build has; resolves to a function that stops listening.
export async function onUpdateCheckAsked(ask: () => void): Promise<() => void> {
	if (!isTauri()) return () => {};
	return listen('check-app-update', ask);
}
