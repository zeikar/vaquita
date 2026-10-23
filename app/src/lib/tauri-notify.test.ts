import { describe, expect, it, vi } from 'vitest';
import type { Notice, Target } from './notify';
import { createTauriNotifier, type NotificationApi } from './tauri-notify';

class FakeNative implements NotificationApi {
	calls: string[] = [];
	sent: Notice[] = [];
	allowed: boolean | string = true;
	sendError?: string;
	listener?: (payload: unknown) => void;
	unlistened = false;
	pending: unknown = null;

	async listen(onClick: (payload: unknown) => void) {
		this.calls.push('listen');
		this.listener = onClick;
		return () => void (this.unlistened = true);
	}
	async takeClick() {
		this.calls.push('takeClick');
		const p = this.pending;
		this.pending = null;
		return p;
	}
	async permission() {
		this.calls.push('permission');
		// The Rust command rejects with its error string.
		if (typeof this.allowed === 'string') throw this.allowed;
		return this.allowed;
	}
	async notify(n: Notice) {
		this.sent.push(n);
		if (this.sendError) throw this.sendError;
	}
	click(payload: unknown) {
		this.listener!(payload);
	}
}

const ignore = () => {};

describe('createTauriNotifier', () => {
	it('asks for the permission, then listens for clicks', async () => {
		const native = new FakeNative();
		await createTauriNotifier(ignore, ignore, native);
		expect(native.calls).toEqual(['permission', 'listen', 'takeClick']);
	});

	it('hands over a click that came before the page listened, once', async () => {
		const native = new FakeNative();
		native.pending = { sid: 3, inc: 'a' };
		const clicks: unknown[] = [];
		await createTauriNotifier((t) => clicks.push(t), ignore, native);
		expect(clicks).toEqual([{ sid: 3, inc: 'a' }]);
		await createTauriNotifier((t) => clicks.push(t), ignore, native);
		expect(clicks).toHaveLength(1);
	});

	it('drops the pending click when a live one arrived while it was being taken', async () => {
		const native = new FakeNative();
		let resolve!: (v: unknown) => void;
		native.takeClick = () => new Promise((r) => (resolve = r));
		const clicks: unknown[] = [];
		const made = createTauriNotifier((t) => clicks.push(t), ignore, native);
		await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
		native.click({ sid: 4, inc: 'b' });
		resolve({ sid: 3, inc: 'a' });
		await made;
		expect(clicks).toEqual([{ sid: 4, inc: 'b' }]);
	});

	it('ignores a pending click that is no target and reports a failed take', async () => {
		const native = new FakeNative();
		native.pending = { sid: 'x' };
		const clicks: unknown[] = [];
		await createTauriNotifier((t) => clicks.push(t), ignore, native);
		expect(clicks).toEqual([]);
		const errors: unknown[] = [];
		native.takeClick = async () => {
			throw 'boom';
		};
		await createTauriNotifier(ignore, (e) => errors.push(e), native);
		expect(errors).toEqual(['boom']);
	});

	it('says whether macOS allows the notifications', async () => {
		const native = new FakeNative();
		expect((await createTauriNotifier(ignore, ignore, native)).allowed).toBe(true);
	});

	it('still sends when notifications are turned off, since they may be turned on later', async () => {
		const native = new FakeNative();
		native.allowed = false;
		const notifier = await createTauriNotifier(ignore, ignore, native);
		expect(notifier.allowed).toBe(false);
		notifier.show({ title: 'build done', body: 'ok', target: { sid: 3, inc: 'a' } });
		expect(native.sent).toHaveLength(1);
	});

	it('fails without listening when macOS cannot be asked', async () => {
		const native = new FakeNative();
		native.allowed = 'notifications need the app bundle';
		await expect(createTauriNotifier(ignore, ignore, native)).rejects.toBe('notifications need the app bundle');
		expect(native.calls).toEqual(['permission']);
	});

	it('sends each notice with its target, and none for the summary', async () => {
		const native = new FakeNative();
		const notifier = await createTauriNotifier(ignore, ignore, native);
		notifier.show({ title: 'build done', body: 'ok', target: { sid: 3, inc: 'a' } });
		notifier.show({ title: 'vaquita', body: '2 notifications while you were away' });
		expect(native.sent).toEqual([
			{ title: 'build done', body: 'ok', target: { sid: 3, inc: 'a' } },
			{ title: 'vaquita', body: '2 notifications while you were away' },
		]);
	});

	it('reports a notice that could not be sent instead of throwing', async () => {
		const native = new FakeNative();
		const errors: unknown[] = [];
		const notifier = await createTauriNotifier(ignore, (e) => errors.push(e), native);
		native.sendError = 'ipc down';
		expect(() => notifier.show({ title: 'build done', body: 'ok' })).not.toThrow();
		await new Promise((r) => setTimeout(r));
		expect(errors).toEqual(['ipc down']);
	});

	it('hands a click the target its notification carries, else none', async () => {
		const native = new FakeNative();
		const clicks: (Target | undefined)[] = [];
		await createTauriNotifier((t) => clicks.push(t), ignore, native);
		native.click({ sid: 3, inc: 'a' });
		native.click(null);
		native.click({});
		native.click({ sid: '3', inc: 'a' });
		expect(clicks).toEqual([{ sid: 3, inc: 'a' }, undefined, undefined, undefined]);
	});

	it('removes the click listener on stop', async () => {
		const native = new FakeNative();
		const notifier = await createTauriNotifier(ignore, ignore, native);
		expect(native.unlistened).toBe(false);
		notifier.stop();
		expect(native.unlistened).toBe(true);
	});
});
