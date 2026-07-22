// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * tuning.ts — the load-bearing constants the whole game's feel and balance rest
 * on, in one place so a balance test can PIN them (principle #18).
 *
 * The ramp constants (`RAMP_*`) are the opponent in a co-op game: they decide how
 * fast the dungeon outgrows a delver's damage. They were not guessed — they were
 * moved until `tests/balance.test.ts` showed a survival curve that decays with
 * depth, rewards more players, and still terminates. `withTuning` lets that test
 * prove a constant is load-bearing: nudge it, and the curve breaks.
 */

export interface Tuning {
  /** Enemy HP growth per floor: hp *= 1 + (floor-1)*RAMP_HP. */
  RAMP_HP: number;
  /** Enemy contact/bolt damage growth per floor. */
  RAMP_DMG: number;
  /** Enemy speed growth per floor (capped by RAMP_SPD_CAP). */
  RAMP_SPD: number;
  RAMP_SPD_CAP: number;
  /** Extra enemies per additional delver: count *= 1 + (players-1)*PARTY_COUNT. */
  PARTY_COUNT: number;
  /** Extra enemy HP per additional delver — so a bigger party is not a free win. */
  PARTY_HP: number;
}

export const DEFAULT_TUNING: Tuning = {
  RAMP_HP: 0.36,
  RAMP_DMG: 0.32,
  // Speed is the load-bearing one: a monster that never outpaces a kiting delver
  // can never end the run, so the ramp MUST eventually let them run you down. At
  // 0.14 a grub outruns the base delver speed (190) by ~floor 8. The cap (3.2x =
  // ~304 u/s) sits ABOVE even a Fleetfoot-stacked delver, so the depths run down
  // a skilled kiter too — nobody is immortal, even in the open modes.
  RAMP_SPD: 0.14,
  RAMP_SPD_CAP: 3.2,
  // Deliberately light: a bigger party brings ~linear DPS but only a little more
  // monster budget, so its combined damage wins the exchange and it reaches at
  // least as deep as a solo delver — the extra monsters are flavour, not a tax.
  // (Measured: heavier scaling turned crowds into a co-op penalty.) No per-monster
  // HP scaling.
  PARTY_COUNT: 0.15,
  PARTY_HP: 0,
};

let current: Tuning = DEFAULT_TUNING;

export function tuning(): Tuning {
  return current;
}

/** Run `fn` with an overridden tuning, then restore. For the balance test only. */
export function withTuning<T>(over: Partial<Tuning>, fn: () => T): T {
  const prev = current;
  current = { ...prev, ...over };
  try {
    return fn();
  } finally {
    current = prev;
  }
}
