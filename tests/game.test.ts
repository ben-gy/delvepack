/**
 * game.test.ts — the pure sim. Deterministic, no DOM, no network.
 *
 * Covers the rules that decide a run: floor generation, monster spawning, motion
 * and clamping, damage, downed/revive, the floor lifecycle, upgrades, and the
 * snapshot round-trip a guest depends on. Two tests here are mutation guards for
 * bugs the balance sim surfaced — the pillar softlock and the orb fixation — so
 * reverting either fix turns them red.
 */

import { describe, expect, it } from 'vitest';
import { Game, HERO_R, type HeroSpec } from '../src/game';
import { MODES } from '../src/modes';
import { UPGRADES } from '../src/upgrades';

const solo: HeroSpec[] = [{ name: 'A', bot: false }];
const party = (n: number): HeroSpec[] =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i}`, bot: false }));

function world(g: Game, secs: number): void {
  for (let i = 0; i < Math.round(secs * 60); i++) g.stepWorld(1 / 60);
}
function moveMe(g: Game, ax: number, ay: number, secs: number): void {
  for (let i = 0; i < Math.round(secs * 60); i++) {
    g.setIntent(0, ax, ay, false);
    g.stepSelf(0, 1 / 60);
  }
}

describe('floor generation is bounded and fair to start', () => {
  it('spawns delvers inside the arena with full HP', () => {
    const g = new Game({ seed: 3, mode: MODES.delve, heroes: party(4) });
    for (const h of g.heroes) {
      expect(Math.abs(h.x)).toBeLessThan(MODES.delve.arenaW / 2);
      expect(Math.abs(h.y)).toBeLessThan(MODES.delve.arenaH / 2);
      expect(h.hp).toBe(h.stats.maxHp);
      expect(h.downed).toBe(false);
    }
  });

  it('keeps pillars off the rune and off each other', () => {
    const g = new Game({ seed: 12, mode: MODES.warren, heroes: solo });
    for (const [i, p] of g.pillars.entries()) {
      expect(Math.hypot(p.x - g.rune.x, p.y - g.rune.y)).toBeGreaterThan(p.r);
      for (let j = i + 1; j < g.pillars.length; j++) {
        const q = g.pillars[j];
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(Math.min(p.r, q.r));
      }
    }
  });
});

describe('monster spawning scales with floor and party', () => {
  it('a bigger party faces more monsters', () => {
    const one = new Game({ seed: 7, mode: MODES.delve, heroes: solo });
    one.populate();
    const four = new Game({ seed: 7, mode: MODES.delve, heroes: party(4) });
    four.populate();
    expect(four.enemies.length).toBeGreaterThan(one.enemies.length);
  });

  it('a deeper floor is tougher — later monsters have more HP', () => {
    const g = new Game({ seed: 7, mode: MODES.delve, heroes: solo });
    g.populate();
    const f1 = Math.max(...g.enemies.filter((e) => e.kind === 'grub').map((e) => e.maxHp));
    g.generateFloor(6);
    g.populate();
    const f6 = Math.max(...g.enemies.filter((e) => e.kind === 'grub').map((e) => e.maxHp));
    expect(f6).toBeGreaterThan(f1);
  });

  it('a boss shows up on the boss cadence', () => {
    const g = new Game({ seed: 7, mode: MODES.delve, heroes: solo });
    g.generateFloor(MODES.delve.bossEvery);
    g.populate();
    expect(g.enemies.some((e) => e.kind === 'boss')).toBe(true);
  });

  it('never exceeds the monster cap', () => {
    const g = new Game({ seed: 7, mode: MODES.warren, heroes: party(4) });
    g.generateFloor(20);
    g.populate();
    expect(g.enemies.length).toBeLessThanOrEqual(MODES.warren.enemyCap + 1);
  });
});

describe('delver motion', () => {
  it('clamps to the arena instead of walking off the edge', () => {
    const g = new Game({ seed: 1, mode: MODES.delve, heroes: solo });
    moveMe(g, 1, 0, 6);
    expect(g.heroes[0].x).toBeLessThanOrEqual(MODES.delve.arenaW / 2 - HERO_R + 0.01);
  });

  it('a dash grants brief invulnerability', () => {
    const g = new Game({ seed: 1, mode: MODES.delve, heroes: solo });
    g.setIntent(0, 1, 0, true);
    g.stepSelf(0, 1 / 60);
    expect(g.heroes[0].dashT).toBeGreaterThan(0);
  });

  it('a dash is on cooldown afterwards', () => {
    const g = new Game({ seed: 1, mode: MODES.delve, heroes: solo });
    g.setIntent(0, 1, 0, true);
    g.stepSelf(0, 1 / 60);
    expect(g.heroes[0].dashCd).toBeGreaterThan(0);
    g.setIntent(0, 0, 1, true);
    g.stepSelf(0, 1 / 60);
    // Cannot dash again while on cooldown — still the first dash's timer.
    expect(g.heroes[0].dashCd).toBeGreaterThan(0);
  });
});

describe('damage, downed and the wipe', () => {
  it('taking a fatal hit downs a solo delver and ends the run (wipe)', () => {
    const g = new Game({ seed: 2, mode: MODES.delve, heroes: solo });
    const h = g.heroes[0];
    h.hp = 20;
    h.spawnT = 0;
    // A hard-hitting monster parked on the delver — one contact is fatal.
    g.enemies = [
      {
        id: 1,
        kind: 'brute',
        x: h.x,
        y: h.y,
        vx: 0,
        vy: 0,
        hp: 9999,
        maxHp: 9999,
        spd: 220,
        dmg: 60,
        r: 22,
        fireEvery: 0,
        boltSpeed: 0,
        fireCd: 0,
        atkCd: 0,
        hitFlash: 0,
        spawnT: 0,
      },
    ];
    world(g, 2);
    expect(g.heroes[0].downed || g.heroes[0].dead).toBe(true);
    expect(g.over).toBe(true);
    expect(g.wipedFloor).toBeGreaterThanOrEqual(1);
  });

  it('a dashing delver takes no contact damage (i-frames)', () => {
    const g = new Game({ seed: 2, mode: MODES.crypt, heroes: solo });
    g.populate();
    const h = g.heroes[0];
    // Park a monster on top of the delver and keep the dash i-frame up.
    g.enemies.length = 1;
    const e = g.enemies[0];
    e.x = h.x;
    e.y = h.y;
    e.atkCd = 0;
    h.dashT = 1;
    const before = h.hp;
    g.stepWorld(1 / 60);
    expect(h.hp).toBe(before);
  });
});

describe('revive', () => {
  it('a downed delver is revived by a teammate standing next to it', () => {
    const g = new Game({ seed: 2, mode: MODES.delve, heroes: party(2) });
    g.enemies = [];
    const [a, b] = g.heroes;
    a.downed = true;
    a.hp = 0;
    a.bleed = 11;
    b.x = a.x + 20;
    b.y = a.y;
    world(g, 3);
    expect(a.downed).toBe(false);
    expect(a.hp).toBeGreaterThan(0);
    expect(b.st.revives).toBeGreaterThan(0);
  });

  it('a downed delver with nobody near bleeds out and dies', () => {
    const g = new Game({ seed: 2, mode: MODES.delve, heroes: party(2) });
    g.enemies = [];
    const [a, b] = g.heroes;
    a.downed = true;
    a.hp = 0;
    a.bleed = 2;
    b.x = a.x + 800; // far away
    b.y = a.y + 800;
    world(g, 3);
    expect(a.dead).toBe(true);
  });
});

describe('the floor lifecycle', () => {
  it('clearing every monster opens the rune and drops loot', () => {
    const g = new Game({ seed: 2, mode: MODES.delve, heroes: solo });
    g.enemies = [];
    g.stepWorld(1 / 60);
    expect(g.phase).toBe('clear');
    expect(g.orbs.length).toBeGreaterThan(0);
    expect(g.rune.active).toBe(true);
  });

  it('standing on the rune descends to a fresh, harder floor', () => {
    const g = new Game({ seed: 2, mode: MODES.delve, heroes: solo });
    g.enemies = [];
    g.orbs = [];
    g.stepWorld(1 / 60); // -> clear
    const h = g.heroes[0];
    h.x = g.rune.x;
    h.y = g.rune.y;
    world(g, 3);
    expect(g.floor).toBe(2);
    expect(g.phase).toBe('fight');
    expect(g.enemies.length).toBeGreaterThan(0);
  });
});

describe('upgrades', () => {
  it('walking over an orb applies its effect', () => {
    const g = new Game({ seed: 2, mode: MODES.delve, heroes: solo });
    g.enemies = [];
    g.stepWorld(1 / 60); // clear + loot
    const orb = g.orbs[0];
    const up = UPGRADES.find((u) => u.id === orb.up)!;
    const before = { ...g.heroes[0].stats };
    g.heroes[0].x = orb.x;
    g.heroes[0].y = orb.y;
    g.stepWorld(1 / 60);
    expect(g.heroes[0].ups).toContain(orb.up);
    // At least one stat moved (or HP healed for vigor).
    const moved = JSON.stringify(before) !== JSON.stringify(g.heroes[0].stats);
    expect(moved || up.id === 'vigor').toBe(true);
  });
});

describe('MUTATION GUARD: hero bolts pass through pillars (the softlock fix)', () => {
  it('a bolt fired through a pillar still kills the monster behind it', () => {
    // Revert the fix (block hero bolts on pillars) and this goes red: the monster
    // sits behind cover, unkillable, and the floor never clears — the exact stall
    // the balance sim found.
    const g = new Game({ seed: 2, mode: MODES.delve, heroes: solo });
    const h = g.heroes[0];
    h.x = -200;
    h.y = 0;
    h.spawnT = 0;
    g.pillars = [{ x: -100, y: 0, r: 30 }]; // squarely between the delver and its target
    g.enemies = [
      {
        id: 999,
        kind: 'grub',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        hp: 20,
        maxHp: 20,
        spd: 0, // stays put behind the cover
        dmg: 0,
        r: 12,
        fireEvery: 0,
        boltSpeed: 0,
        fireCd: 0,
        atkCd: 0,
        hitFlash: 0,
        spawnT: 0,
      },
    ];
    world(g, 3);
    expect(g.enemies.length, 'the monster behind the pillar must be reachable').toBe(0);
  });
});

describe('MUTATION GUARD: uncollected orbs expire (the fixation fix)', () => {
  it('an orb nobody grabs fades, so the rune is never blocked by fixation', () => {
    const g = new Game({ seed: 2, mode: MODES.delve, heroes: solo });
    // Delver parked far from the loot so it never grabs anything.
    g.heroes[0].x = MODES.delve.arenaW / 2 - HERO_R;
    g.heroes[0].y = MODES.delve.arenaH / 2 - HERO_R;
    g.enemies = [];
    g.stepWorld(1 / 60); // clear + loot
    expect(g.orbs.length).toBeGreaterThan(0);
    world(g, 18);
    expect(g.orbs.length, 'orbs must not linger forever').toBe(0);
  });
});

describe('the snapshot a guest depends on', () => {
  it('round-trips the world onto a fresh guest game', () => {
    const host = new Game({ seed: 42, mode: MODES.delve, heroes: party(2) });
    host.populate();
    world(host, 2);
    const guest = new Game({ seed: 42, mode: MODES.delve, heroes: party(2) });
    guest.applySnapshot(host.snapshot(), 1); // guest is seat 1

    expect(guest.floor).toBe(host.floor);
    expect(guest.enemies.length).toBe(host.enemies.length);
    // Seat 0 (remote) position is adopted from the host; HP for all is authoritative.
    expect(guest.heroes[0].x).toBe(Math.round(host.heroes[0].x));
    for (const [i, h] of host.heroes.entries()) expect(guest.heroes[i].hp).toBe(Math.round(h.hp));
  });

  it('keeps the local delver s own position (it owns its motion)', () => {
    const host = new Game({ seed: 42, mode: MODES.delve, heroes: party(2) });
    host.populate();
    const guest = new Game({ seed: 42, mode: MODES.delve, heroes: party(2) });
    guest.heroes[1].x = 123;
    guest.heroes[1].y = 456;
    guest.applySnapshot(host.snapshot(), 1);
    // Seat 1 is "me": the snapshot must not move it.
    expect(guest.heroes[1].x).toBe(123);
    expect(guest.heroes[1].y).toBe(456);
  });

  it('a promoted guest can rehydrate monster combat stats deterministically', () => {
    const host = new Game({ seed: 42, mode: MODES.crypt, heroes: solo });
    host.populate();
    const guest = new Game({ seed: 42, mode: MODES.crypt, heroes: solo });
    guest.applySnapshot(host.snapshot(), -1);
    // Snapshot monsters arrive inert; rehydrate must restore their speed/damage.
    expect(guest.enemies.every((e) => e.spd === 0)).toBe(true);
    guest.rehydrateEnemies();
    expect(guest.enemies.every((e) => e.spd > 0 && e.dmg > 0)).toBe(true);
  });
});

describe('a delver leaving the room', () => {
  it('dissolves cleanly and can trigger a wipe if it was the last one up', () => {
    const g = new Game({ seed: 1, mode: MODES.delve, heroes: party(2) });
    g.heroes[0].downed = true;
    g.dissolve(1);
    expect(g.heroes[1].left).toBe(true);
    expect(g.over).toBe(true);
  });
});
