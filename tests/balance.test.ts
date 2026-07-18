/**
 * balance.test.ts — is the dungeon still a fair fight? (principle #18)
 *
 * In a co-op game the opponent is the DIFFICULTY RAMP, so the thing to measure —
 * and the thing no unit test and no ninety-second playthrough can see — is the
 * survival curve: P(a competent party reaches floor N). This ran BEFORE any
 * constant was tuned, and it earned its keep: the design assumed a bigger party
 * would obviously go deeper, and the sim said the opposite (crowds plus revive
 * cascades made co-op a tax). The tuning that followed — light party scaling, a
 * speed ramp steep enough to eventually run a lone kiter down — was chosen by the
 * numbers below, not by argument.
 *
 * The shape we require of every mode and party size:
 *   - the OPENING is reliably winnable (floors 1–3), or the game is not fun;
 *   - it RESOLVES — a run is not immortal, the ramp wins in the end;
 *   - it has SPREAD and DECAYS with depth — the depth you reach is a real result;
 *   - every party size is survivable and roughly COMPARABLE (co-op is not punished).
 *
 * Deterministic: seeded rng, fixed step, no wall clock. The numbers are measured;
 * where a bound looks loose it is because the interesting direction is one-sided.
 * Runtime is a few seconds — the price of the only test that can see the ramp.
 */

import { describe, expect, it } from 'vitest';
import { sweep, playRun, report, type Sweep } from './helpers/sim';
import { MODES } from '../src/modes';
import { withTuning } from '../src/tuning';

const N = 40;

// Buy each sweep once — sim time is the budget.
const sweeps: Record<string, Record<number, Sweep>> = {};
for (const mode of Object.values(MODES)) {
  sweeps[mode.id] = {};
  for (const players of [1, 2, 4]) sweeps[mode.id][players] = sweep(N, { mode, players });
}
const cases = Object.values(MODES).flatMap((m) =>
  [1, 2, 4].map((p) => ({ mode: m, players: p, s: sweeps[m.id][p] })),
);

describe('the opening is winnable — floors 1–3 are the fun, accessible part', () => {
  for (const { mode, players, s } of cases) {
    it(`${mode.name} x${players}: floor 1 is a gentle intro and most clear the opening`, () => {
      expect(s.reach(2), report(s)).toBeGreaterThan(0.9);
      // Even Crypt — the deliberately brutal mode — lets most parties past the
      // opening; the default Delve is much friendlier (checked below).
      expect(s.reach(3), report(s)).toBeGreaterThan(0.72);
      expect(s.reach(4), report(s)).toBeGreaterThan(0.5);
    });
  }
  it('Delve (the default) has a forgiving on-ramp', () => {
    expect(sweeps.delve[1].reach(4)).toBeGreaterThan(0.82);
  });
});

describe('the run resolves — the ramp is the opponent and it wins in the end', () => {
  for (const { mode, players, s } of cases) {
    it(`${mode.name} x${players}: it decays with depth — the floor you reach means something`, () => {
      // A flat curve would be a game with no arc. The opening must be far more
      // survivable than the depths.
      expect(s.reach(4) - s.reach(12), report(s)).toBeGreaterThan(0.3);
    });

    it(`${mode.name} x${players}: the depths thin out — reaching floor 15 is not the default`, () => {
      // Solo in the open modes is the most kitable (a great player can go deep,
      // which is the score-attack), so it gets the loosest bound; a co-op run
      // resolves markedly harder.
      const bound = players === 1 ? 0.5 : 0.25;
      expect(s.reach(15), report(s)).toBeLessThan(bound);
    });
  }
});

describe('spread — not everyone dies on floor 1, not everyone lives forever', () => {
  for (const { mode, players, s } of cases) {
    it(`${mode.name} x${players}: the median run lands in a sane band`, () => {
      expect(s.medianFloor, report(s)).toBeGreaterThanOrEqual(4);
      expect(s.medianFloor, report(s)).toBeLessThanOrEqual(16);
    });
  }
});

describe('every party size is survivable and reaches a fair depth', () => {
  for (const mode of Object.values(MODES)) {
    it(`${mode.name}: a full party of four gets a real run, not a punished one`, () => {
      const four = sweeps[mode.id][4];
      // A bigger party should be a genuinely playable experience: it reliably
      // gets several floors in (its payoff is resilience and playing together,
      // not necessarily going DEEPER than a lone kite — an honest reading the sim
      // forced, since it refused to make co-op strictly deeper).
      expect(four.medianFloor, report(four)).toBeGreaterThanOrEqual(5);
      expect(four.reach(5), report(four)).toBeGreaterThan(0.6);
    });
  }
});

describe('runs terminate — no pathological immortal kite', () => {
  it('a run is never STUCK — it either wipes or makes real progress downward', () => {
    // The pathology to catch is a party kiting forever on a shallow floor without
    // killing or dying. So the property is progress, not a hard step count: a long
    // run that keeps descending is fine; a run that eats the whole clock at a
    // shallow floor is a bug.
    for (const mode of Object.values(MODES)) {
      for (let seed = 0; seed < 12; seed++) {
        const r = playRun({ seed: seed * 7919 + 3, mode, players: 2 });
        expect(r.over || r.floor >= 8, `${mode.name} seed ${seed}: ${JSON.stringify(r)}`).toBe(true);
      }
    }
  });
});

describe('the constants the balance rests on', () => {
  it('RAMP_SPD is load-bearing: a flat speed ramp lets a lone kiter delve forever', () => {
    // Pin it, per principle #18. If monsters never outpace the delver, nothing
    // ends the run and "how deep can you delve" becomes "how long will you sit
    // here". Measured: at RAMP_SPD 0.02 solo Delve caps near-always vs ~36%
    // shipped. This stops "let's make it feel calmer" from quietly re-arming it.
    const flat = withTuning({ RAMP_SPD: 0.02 }, () => sweep(30, { mode: MODES.delve, players: 1 }));
    const shipped = sweep(30, { mode: MODES.delve, players: 1 });
    expect(flat.capRate, `${report(flat)}\n${report(shipped)}`).toBeGreaterThan(shipped.capRate);
    expect(flat.meanFloor).toBeGreaterThan(shipped.meanFloor);
  });

  it('the three modes are genuinely different fights, not one dial', () => {
    // Crypt (tight, brutal) must resolve markedly shallower than Delve (open),
    // or "modes" is a lie. Measured: Crypt solo median ~5 vs Delve ~10.
    const crypt = sweeps.crypt[1];
    const delve = sweeps.delve[1];
    expect(crypt.medianFloor, `${report(crypt)}\n${report(delve)}`).toBeLessThan(delve.medianFloor);
  });
});
