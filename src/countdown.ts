/**
 * countdown.ts — 3, 2, 1, GO.
 *
 * A floor never begins the instant the room appears. Without this, whoever
 * happens to be looking at their screen gets a free head start, and the room
 * reads as a jump-cut rather than a start. The AUDIO carries it — players watch
 * the arena, not the overlay — so each beat fires a sound whether or not anything
 * is rendering.
 *
 * Each peer counts locally from the host's start message; that leaves peers in
 * step to within one network hop, which is plenty (the round is host-authoritative
 * anyway). setInterval, never rAF alone: a backgrounded tab pauses rAF, and a
 * countdown that freezes when you glance at another tab is worse than none.
 */

export interface CountdownOpts {
  from?: number;
  beatMs?: number;
  onBeat: (n: number) => void;
  onDone: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface Countdown {
  cancel(): void;
  done(): boolean;
}

export function startCountdown(opts: CountdownOpts): Countdown {
  const from = opts.from ?? 3;
  const beatMs = opts.beatMs ?? 700;
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let n = from;
  let finished = false;
  let handle: unknown = null;

  opts.onBeat(n);

  const stop = (): void => {
    if (handle !== null) clearTimer(handle);
    handle = null;
  };

  handle = setTimer(() => {
    if (finished) return;
    n--;
    opts.onBeat(n);
    if (n <= 0) {
      finished = true;
      stop();
      opts.onDone();
    }
  }, beatMs);

  return {
    cancel() {
      if (finished) return;
      finished = true;
      stop();
    },
    done: () => finished,
  };
}
