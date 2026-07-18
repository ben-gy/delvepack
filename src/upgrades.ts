/**
 * upgrades.ts — the diegetic upgrade orbs a delver grabs between floors.
 *
 * They are ORBS you walk over, not a menu that blocks the room — a co-op upgrade
 * screen that waits for everyone is a deadlock waiting to happen. So each delver
 * builds their own loadout by grabbing what they can reach, and the round never
 * stalls. Every effect is a pure mutation of a delver's stat block, so it is
 * trivially deterministic and needs no sync beyond "delver i grabbed orb k".
 */

export interface Stats {
  dmg: number;
  /** Shots per second. */
  fireRate: number;
  moveSpeed: number;
  dashCd: number;
  projectiles: number;
  pierce: number;
  boltSpeed: number;
  range: number;
  maxHp: number;
}

export interface Upgrade {
  id: string;
  name: string;
  /** One line for the pickup toast. */
  blurb: string;
  /** Okabe-Ito colour of the orb. */
  color: string;
  /** Mutate the delver's stats. Returns extra HP to also heal, if any. */
  apply: (s: Stats) => number;
}

export const UPGRADES: Upgrade[] = [
  {
    id: 'power',
    name: 'Sharpened',
    blurb: '+6 bolt damage',
    color: '#d55e00',
    apply: (s) => {
      s.dmg += 6;
      return 0;
    },
  },
  {
    id: 'rapid',
    name: 'Quickdraw',
    blurb: '+0.5 shots / sec',
    color: '#f0e442',
    apply: (s) => {
      s.fireRate += 0.5;
      return 0;
    },
  },
  {
    id: 'multishot',
    name: 'Split Bolt',
    blurb: '+1 bolt per shot',
    color: '#56b4e9',
    apply: (s) => {
      s.projectiles += 1;
      return 0;
    },
  },
  {
    id: 'swift',
    name: 'Fleetfoot',
    blurb: '+18 move speed',
    color: '#009e73',
    apply: (s) => {
      s.moveSpeed += 18;
      return 0;
    },
  },
  {
    id: 'vigor',
    name: 'Vigor',
    blurb: '+30 max HP (and heal it)',
    color: '#cc79a7',
    apply: (s) => {
      s.maxHp += 30;
      return 30;
    },
  },
  {
    id: 'pierce',
    name: 'Piercing',
    blurb: 'Bolts pierce +1 foe',
    color: '#0072b2',
    apply: (s) => {
      s.pierce += 1;
      return 0;
    },
  },
  {
    id: 'dash',
    name: 'Windstep',
    blurb: 'Dash recharges faster',
    color: '#e69f00',
    apply: (s) => {
      s.dashCd = Math.max(0.5, s.dashCd - 0.18);
      return 0;
    },
  },
  {
    id: 'velocity',
    name: 'Longshot',
    blurb: 'Faster bolts, longer reach',
    color: '#ffffff',
    apply: (s) => {
      s.boltSpeed += 90;
      s.range += 70;
      return 0;
    },
  },
];

export const UPGRADE_BY_ID: Record<string, Upgrade> = Object.fromEntries(
  UPGRADES.map((u) => [u.id, u]),
);

export function upgradeOf(id: unknown): Upgrade | undefined {
  return typeof id === 'string' && Object.hasOwn(UPGRADE_BY_ID, id) ? UPGRADE_BY_ID[id] : undefined;
}
