// Stands in for Tauri's webview internals, forwarding commands to bridge.mjs
// and polling it for events. Load it with Playwright's addInitScript before the
// page; window.__vqFire(event, payload) delivers an event as the app's Rust
// side would (the menu's `tab` event, say), and window.__vqLog lists calls.
(() => {
	const BRIDGE = 'http://127.0.0.1:14999';
	const callbacks = new Map();
	let nextCb = 1;
	const listeners = new Map(); // eventId -> {event, handler}
	let nextListener = 1;
	window.__vqLog = [];
	const note = (cmd, args) => window.__vqLog.push({ t: performance.now(), cmd, args });

	function deliver(event, payload) {
		for (const [id, l] of listeners) {
			if (l.event !== event) continue;
			const cb = callbacks.get(l.handler);
			if (cb) cb({ event, id, payload });
		}
	}
	window.__vqFire = deliver;

	async function invoke(cmd, args = {}) {
		note(cmd, args);
		if (cmd === 'plugin:event|listen') {
			const id = nextListener++;
			listeners.set(id, { event: args.event, handler: args.handler });
			return id;
		}
		if (cmd === 'plugin:event|unlisten') {
			listeners.delete(args.eventId);
			return null;
		}
		if (cmd.startsWith('plugin:event|')) return null;
		const res = await fetch(`${BRIDGE}/invoke`, { method: 'POST', body: JSON.stringify({ cmd, args }) });
		const body = await res.json();
		if (!body.ok) throw body.err;
		return body.value;
	}

	window.__TAURI_INTERNALS__ = {
		invoke,
		transformCallback(cb, once) {
			const id = nextCb++;
			callbacks.set(id, (data) => {
				if (once) callbacks.delete(id);
				return cb(data);
			});
			return id;
		},
		unregisterCallback(id) {
			callbacks.delete(id);
		},
		runCallback(id, data) {
			callbacks.get(id)?.(data);
		},
		callbacks,
		convertFileSrc(p) {
			return `${BRIDGE}/file?path=${encodeURIComponent(p)}`;
		},
		metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
		plugins: { path: { sep: '/', delimiter: ':' } },
	};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
		unregisterListener(event, id) {
			const l = listeners.get(id);
			if (l) callbacks.delete(l.handler);
			listeners.delete(id);
		},
	};

	let since = 0;
	async function poll() {
		try {
			const res = await fetch(`${BRIDGE}/events?since=${since}`);
			for (const e of await res.json()) {
				since = e.id;
				deliver(e.event, e.payload);
			}
		} catch (e) {
			console.warn('bridge poll failed', e);
		}
		setTimeout(poll, 300);
	}
	// Skip events from before this page load.
	fetch(`${BRIDGE}/events?since=0`)
		.then((r) => r.json())
		.then((all) => {
			since = all.length ? all[all.length - 1].id : 0;
			poll();
		}, () => poll());
})();
