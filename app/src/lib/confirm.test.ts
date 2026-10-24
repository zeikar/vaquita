import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Confirm } from './confirm.svelte';

let now = 0;

beforeEach(() => {
	vi.useFakeTimers();
	now = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('Confirm', () => {
	it('acts on the second click of the same button only', () => {
		const c = new Confirm();
		const act = vi.fn();
		c.click('kill:1', act);
		expect(c.armed).toBe('kill:1');
		// A double-click is not a confirmation.
		now = 100;
		c.click('kill:1', act);
		expect(act).not.toHaveBeenCalled();
		// Another button takes the arming over.
		c.click('kill:2', act);
		expect(c.armed).toBe('kill:2');
		now = 600;
		c.click('kill:2', act);
		expect(act).toHaveBeenCalledTimes(1);
		expect(c.armed).toBeUndefined();
	});

	it('disarms after a while', () => {
		const c = new Confirm();
		c.click('restart', () => {});
		vi.advanceTimersByTime(3000);
		expect(c.armed).toBeUndefined();
	});
});
