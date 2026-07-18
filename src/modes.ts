/**
 * modes.ts — the three shapes a run of Delvepack can take.
 *
 * A mode must change how the game PLAYS, not just a number. The spread here is
 * about ONE question: what is the space between you and the monsters?
 *
 *  - Delve   the classic. A mid-size hall, a balanced monster mix, a boss every
 *            5 floors. Room to kite, but the walls are close enough that a bad
 *            dash still ends you.
 *  - Warren  a big open cavern that spawns CROWDS of individually weaker
 *            monsters, denser every floor, boss every 4. The game becomes crowd
 *            control: there is space to kite, but so many things to kite that
 *            standing still is death. Multishot and move speed shine.
 *  - Crypt   a small, tight chamber with FEWER but much tougher and faster
 *            monsters, a steep ramp, a boss every 3. You cannot kite far — there
 *            is nowhere to run — so it is a knife-fight decided by dashing
 *            through gaps and burst damage. Claustrophobic on purpose.
 *
 * The host's pick travels FROZEN inside the round start (rematch roundOpts) — a
 * mode decides the arena SIZE and the monster budget, so two peers reading their
 * own menus would generate different dungeons off the same seed.
 */

export interface Mode {
  id: string;
  name: string;
  /** One line, player-facing. */
  blurb: string;
  /** Arena size in world units. */
  arenaW: number;
  arenaH: number;
  /** Monsters on floor 1 (before the per-floor and party ramps). */
  enemyBase: number;
  /** Added per floor. */
  enemyPer: number;
  /** Hard cap on simultaneous monsters, so a phone never melts. */
  enemyCap: number;
  /** Per-monster HP multiplier — Warren's crowds are individually softer. */
  hpMul: number;
  /** Per-monster speed multiplier. */
  spdMul: number;
  /** Per-monster damage multiplier. */
  dmgMul: number;
  /** A boss brute appears on floors that are a multiple of this. */
  bossEvery: number;
  /** Pillars scattered as cover, per floor. */
  pillars: number;
}

export const MODES: Record<string, Mode> = {
  delve: {
    id: 'delve',
    name: 'Delve',
    blurb: 'Mid hall · balanced foes · boss every 5 — the classic descent.',
    arenaW: 920,
    arenaH: 640,
    enemyBase: 5,
    enemyPer: 1.4,
    enemyCap: 20,
    hpMul: 1,
    spdMul: 1,
    dmgMul: 1,
    bossEvery: 5,
    pillars: 3,
  },
  warren: {
    id: 'warren',
    name: 'Warren',
    blurb: 'Wide cavern · crowds of weaker foes · boss every 4 — crowd control.',
    // Big, but not so big a lone kiter can circle forever — the crowd has to be
    // able to close the space, or "crowd control" is just running in circles.
    arenaW: 1020,
    arenaH: 700,
    enemyBase: 7,
    enemyPer: 2,
    enemyCap: 30,
    hpMul: 0.82,
    spdMul: 0.95,
    dmgMul: 0.92,
    bossEvery: 4,
    pillars: 5,
  },
  crypt: {
    id: 'crypt',
    name: 'Crypt',
    blurb: 'Tight chamber · few but brutal, fast foes · boss every 3 — a knife-fight.',
    arenaW: 700,
    arenaH: 520,
    enemyBase: 4,
    enemyPer: 1.1,
    enemyCap: 15,
    hpMul: 1.28,
    spdMul: 1.14,
    dmgMul: 1.18,
    bossEvery: 3,
    pillars: 2,
  },
};

export const DEFAULT_MODE = MODES.delve;
export const MODE_LIST: Mode[] = [MODES.delve, MODES.warren, MODES.crypt];

/** Room cap. Four delvers descend together; more would crowd the screen. */
export const MAX_PLAYERS = 4;

/**
 * Resolve a mode id off the wire or out of storage.
 *
 * `MODES[id] || DEFAULT` is a trap: 'constructor'/'toString' are truthy inherited
 * properties, so an untrusted id could hand the generator an object with no
 * `arenaW`. Object.hasOwn is the guard; an unknown id falls back rather than
 * reaching the sim as undefined.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id];
  return DEFAULT_MODE;
}
