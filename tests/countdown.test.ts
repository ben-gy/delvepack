/**
 * countdown.test.ts — 3, 2, 1, GO.
 *
 * Without it, whoever happens to be looking at their screen gets a free head
 * start and the dish reads as a jump-cut. The timer is injectable precisely so
 * this can be tested without waiting 2.1 real seconds.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCountdown } from '../src/countdown';

/** A hand-cranked setInterval. */
function fakeTimer() {
  let fn: (() => void) | null = null;
  let cleared = false;
  return {
    set: (f: () => void) => {
      fn = f;
      return 1;
    },
    clear: () => {
      cleared = true;
      fn = null;
    },
    tick(n = 1) {
      for (let i = 0; i < n; i++) fn?.();
    },
    get cleared() {
      return cleared;
    },
    get live() {
      return fn !== null;
    },
  };
}

describe('the countdown', () => {
  it('shows "3" immediately — waiting a beat looks like a hang', () => {
    const t = fakeTimer();
    const onBeat = vi.fn();
    startCountdown({ onBeat, onDone: vi.fn(), setTimer: t.set, clearTimer: t.clear });
    expect(onBeat).toHaveBeenCalledWith(3);
  });

  it('counts 3, 2, 1, then 0 for GO', () => {
    const t = fakeTimer();
    const beats: number[] = [];
    const onDone = vi.fn();
    startCountdown({
      onBeat: (n) => beats.push(n),
      onDone,
      setTimer: t.set,
      clearTimer: t.clear,
    });
    t.tick(3);
    expect(beats).toEqual([3, 2, 1, 0]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('stops its timer once it is done — no orphaned interval', () => {
    const t = fakeTimer();
    startCountdown({ onBeat: vi.fn(), onDone: vi.fn(), setTimer: t.set, clearTimer: t.clear });
    t.tick(3);
    expect(t.cleared).toBe(true);
  });

  it('never fires onDone twice, however hard the timer is cranked', () => {
    const t = fakeTimer();
    const onDone = vi.fn();
    startCountdown({ onBeat: vi.fn(), onDone, setTimer: t.set, clearTimer: t.clear });
    t.tick(10);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('cancels cleanly on teardown — the round must not start after you left', () => {
    const t = fakeTimer();
    const onDone = vi.fn();
    const c = startCountdown({ onBeat: vi.fn(), onDone, setTimer: t.set, clearTimer: t.clear });
    c.cancel();
    t.tick(5);
    expect(onDone).not.toHaveBeenCalled();
    expect(c.done()).toBe(true);
  });

  it('cancel is safe to call twice', () => {
    const t = fakeTimer();
    const c = startCountdown({ onBeat: vi.fn(), onDone: vi.fn(), setTimer: t.set, clearTimer: t.clear });
    c.cancel();
    expect(() => c.cancel()).not.toThrow();
  });

  it('honours a custom start', () => {
    const t = fakeTimer();
    const beats: number[] = [];
    startCountdown({
      from: 1,
      onBeat: (n) => beats.push(n),
      onDone: vi.fn(),
      setTimer: t.set,
      clearTimer: t.clear,
    });
    t.tick(1);
    expect(beats).toEqual([1, 0]);
  });

  it('uses setInterval, not rAF — a backgrounded tab must still count', () => {
    // rAF pauses in a hidden tab. A countdown that freezes when you glance at
    // another tab is worse than no countdown, and it cannot be tested headlessly.
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/countdown.ts'), 'utf8');
    expect(text).toContain('setInterval');
    expect(text).not.toContain('requestAnimationFrame');
  });
});
