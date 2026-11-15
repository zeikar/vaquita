import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPathChecker, type PathQuery } from './path-exists';

type Call = { paths: PathQuery[]; resolve: (r: unknown) => void; reject: (e: unknown) => void };

function setup() {
	const calls: Call[] = [];
	let t = 1_000;
	const clock = { advance: (ms: number) => void (t += ms) };
	const checker = createPathChecker(
		(paths) => new Promise((resolve, reject) => void calls.push({ paths, resolve: resolve as Call['resolve'], reject })),
		() => t,
	);
	return { calls, clock, checker };
}

// Lets the checker's promise handlers run.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createPathChecker', () => {
	let warn: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('makes one call per ask, with each text as gateTarget gives it', async () => {
		const { calls, checker } = setup();
		const p = checker.ask(['/tmp/a.ts', '~/b.ts', 'file://localhost/tmp/c%20d.txt']);
		await flush();
		expect(calls).toHaveLength(1);
		expect(calls[0].paths).toEqual([
			{ path: '/tmp/a.ts', host: '' },
			{ path: '~/b.ts', host: '' },
			{ path: '/tmp/c d.txt', host: 'localhost' },
		]);
		calls[0].resolve([true, false, true]);
		await p;
	});

	it('knows nothing before the answer and true or false after', async () => {
		const { calls, checker } = setup();
		expect(checker.known('/tmp/a.ts')).toBeUndefined();
		const p = checker.ask(['/tmp/a.ts', '/tmp/b.ts']);
		await flush();
		calls[0].resolve([true, false]);
		await p;
		expect(checker.known('/tmp/a.ts')).toBe(true);
		expect(checker.known('/tmp/b.ts')).toBe(false);
	});

	it('leaves a null answer unknown and asks again', async () => {
		const { calls, checker } = setup();
		const p = checker.ask(['/tmp/a.ts', '/tmp/b.ts']);
		await flush();
		calls[0].resolve([null, true]);
		await p;
		expect(checker.known('/tmp/a.ts')).toBeUndefined();
		expect(checker.known('/tmp/b.ts')).toBe(true);
		const q = checker.ask(['/tmp/a.ts', '/tmp/b.ts']);
		await flush();
		expect(calls).toHaveLength(2);
		expect(calls[1].paths).toEqual([{ path: '/tmp/a.ts', host: '' }]);
		calls[1].resolve([false]);
		await q;
	});

	it('keeps a yes for 60 s and a no for 5 s', async () => {
		const { calls, clock, checker } = setup();
		const p = checker.ask(['/tmp/yes.ts', '/tmp/no.ts']);
		await flush();
		calls[0].resolve([true, false]);
		await p;
		clock.advance(4_999);
		expect(checker.known('/tmp/no.ts')).toBe(false);
		clock.advance(1);
		expect(checker.known('/tmp/no.ts')).toBeUndefined();
		expect(checker.known('/tmp/yes.ts')).toBe(true);
		clock.advance(55_000);
		expect(checker.known('/tmp/yes.ts')).toBeUndefined();
		const q = checker.ask(['/tmp/yes.ts', '/tmp/no.ts']);
		await flush();
		expect(calls).toHaveLength(2);
		expect(calls[1].paths).toHaveLength(2);
		calls[1].resolve([true, true]);
		await q;
	});

	it('makes no call when everything is known', async () => {
		const { calls, checker } = setup();
		const p = checker.ask(['/tmp/a.ts']);
		await flush();
		calls[0].resolve([true]);
		await p;
		await checker.ask(['/tmp/a.ts']);
		expect(calls).toHaveLength(1);
	});

	it('does not ask a text in flight a second time, and the second ask waits on the first call', async () => {
		vi.useFakeTimers();
		const { calls, checker } = setup();
		const p = checker.ask(['/tmp/a.ts']);
		await vi.advanceTimersByTimeAsync(0);
		let done = false;
		const q = checker.ask(['/tmp/a.ts']).then(() => void (done = true));
		await vi.advanceTimersByTimeAsync(100);
		expect(calls).toHaveLength(1);
		expect(done).toBe(false);
		calls[0].resolve([true]);
		await Promise.all([p, q]);
		expect(checker.known('/tmp/a.ts')).toBe(true);
	});

	it('a second ask for a text in flight still resolves after the wait', async () => {
		vi.useFakeTimers();
		const { calls, checker } = setup();
		void checker.ask(['/tmp/a.ts']);
		await vi.advanceTimersByTimeAsync(0);
		let done = false;
		void checker.ask(['/tmp/a.ts']).then(() => void (done = true));
		await vi.advanceTimersByTimeAsync(250);
		expect(done).toBe(true);
		expect(calls).toHaveLength(1);
		expect(checker.known('/tmp/a.ts')).toBeUndefined();
	});

	it('drops the expired entries when a reply is stored', async () => {
		const { calls, clock, checker } = setup();
		const p = checker.ask(['/tmp/a.ts', '/tmp/b.ts']);
		await flush();
		calls[0].resolve([false, true]);
		await p;
		expect(checker.size).toBe(2);
		clock.advance(5_000);
		expect(checker.size).toBe(2);
		const q = checker.ask(['/tmp/c.ts']);
		await flush();
		calls[1].resolve([true]);
		await q;
		expect(checker.size).toBe(2);
		expect(checker.known('/tmp/b.ts')).toBe(true);
	});

	it('resolves after 250 ms for a call that never settles, and keeps its late answer', async () => {
		vi.useFakeTimers();
		const { calls, checker } = setup();
		let done = false;
		const p = checker.ask(['/tmp/a.ts']).then(() => (done = true));
		await vi.advanceTimersByTimeAsync(249);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await p;
		expect(checker.known('/tmp/a.ts')).toBeUndefined();
		calls[0].resolve([true]);
		await vi.advanceTimersByTimeAsync(0);
		expect(checker.known('/tmp/a.ts')).toBe(true);
	});

	it('clears its timer when the answer comes first', async () => {
		vi.useFakeTimers();
		const { calls, checker } = setup();
		const p = checker.ask(['/tmp/a.ts']);
		await vi.advanceTimersByTimeAsync(0);
		calls[0].resolve([true]);
		await p;
		expect(vi.getTimerCount()).toBe(0);
	});

	it('leaves every text unknown on a failure, and warns once over several', async () => {
		const { calls, checker } = setup();
		const failures: ((c: Call) => void)[] = [
			(c) => c.reject(new Error('boom')),
			(c) => c.resolve(null),
			(c) => c.resolve([true]),
		];
		for (const [i, fail] of failures.entries()) {
			const texts = [`/tmp/a${i}.ts`, `/tmp/b${i}.ts`];
			const p = checker.ask(texts);
			await flush();
			fail(calls[i]);
			await p;
			expect(texts.map((t) => checker.known(t))).toEqual([undefined, undefined]);
		}
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('swallows a rejection that lands after the wait', async () => {
		vi.useFakeTimers();
		const { calls, checker } = setup();
		const p = checker.ask(['/tmp/a.ts']);
		await vi.advanceTimersByTimeAsync(250);
		await p;
		calls[0].reject(new Error('late'));
		await vi.advanceTimersByTimeAsync(0);
		expect(checker.known('/tmp/a.ts')).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
