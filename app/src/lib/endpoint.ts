import { invoke } from '@tauri-apps/api/core';
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
