/**
 * sim.ts — drive AI-vs-the-dungeon runs so the balance test can measure the
 * difficulty curve instead of guessing it.
 *
 * In a co-op game the OPPONENT is the ramp, so the thing to measure is the
 * survival curve: P(a competent party reaches floor N). The delver AI (src/ai.ts)
 * plays well enough that this reads the ramp a real player would meet. Everything
 * is deterministic — seeded rng, fixed step, no wall clock — so the numbers the
 * test asserts on are stable, not flaky.
 */

import { Game } from '../../src/game';
import { heroIntent } from '../../src/ai';
import { makeRng } from '../../src/engine/rng';
import type { Mode } from '../../src/modes';

export interface RunResult {
  floor: number;
  steps: number;
  over: boolean;
  hitCap: boolean;
}

export interface RunOpts {
  seed: number;
  mode: Mode;
  players: number;
  maxFloor?: number;
  hz?: number;
}

export function playRun(opts: RunOpts): RunResult {
  const { seed, mode, players } = opts;
  const maxFloor = opts.maxFloor ?? 22;
  const hz = opts.hz ?? 60;
  const step = 1 / hz;

  const heroes = Array.from({ length: players }, (_, i) => ({ name: `P${i}`, bot: true }));
  const g = new Game({ seed, mode, heroes });
  g.populate();
  const rng = makeRng((seed ^ 0x51ed270b) >>> 0);
  const maxSteps = hz * 60 * 4; // a 4-minute hard stop against a pathological kite

  let steps = 0;
  while (!g.over && g.floor < maxFloor && steps < maxSteps) {
    for (let i = 0; i < players; i++) {
      const it = heroIntent(g, i, rng);
      g.setIntent(i, it.ax, it.ay, it.dash, it.reviving);
      g.stepSelf(i, step);
    }
    g.stepWorld(step);
    steps++;
  }
  return {
    floor: g.floor,
    steps,
    over: g.over,
    hitCap: g.floor >= maxFloor || steps >= maxSteps,
  };
}

export interface Sweep {
  runs: number;
  players: number;
  mode: string;
  floors: number[];
  meanFloor: number;
  medianFloor: number;
  capRate: number;
  /** Fraction of runs whose party reached at least floor k. */
  reach(k: number): number;
}

export interface SweepOpts {
  mode: Mode;
  players: number;
  maxFloor?: number;
  hz?: number;
}

export function sweep(n: number, opts: SweepOpts): Sweep {
  const floors: number[] = [];
  let capped = 0;
  for (let i = 0; i < n; i++) {
    const r = playRun({ seed: 1000 + i * 2654435761, ...opts });
    floors.push(r.floor);
    if (r.hitCap) capped++;
  }
  const sorted = [...floors].sort((a, b) => a - b);
  const meanFloor = floors.reduce((a, b) => a + b, 0) / n;
  const medianFloor = sorted[Math.floor(n / 2)];
  return {
    runs: n,
    players: opts.players,
    mode: opts.mode.name,
    floors,
    meanFloor,
    medianFloor,
    capRate: capped / n,
    reach: (k) => floors.filter((f) => f >= k).length / n,
  };
}

export function report(s: Sweep): string {
  const ks = [2, 3, 4, 5, 6, 8, 10, 12, 15];
  const curve = ks.map((k) => `f${k}:${(s.reach(k) * 100).toFixed(0)}%`).join(' ');
  return `[${s.mode} x${s.players}] mean=${s.meanFloor.toFixed(1)} med=${s.medianFloor} cap=${(s.capRate * 100).toFixed(0)}% ${curve}`;
}
