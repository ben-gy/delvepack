/**
 * game.ts — the deterministic dungeon-crawler simulation. No DOM, no network.
 *
 * ── the authority split (see net-game.ts) ────────────────────────────────────
 *
 * The sim is written so ONE class serves three roles without branching on which:
 *
 *   HOST / SOLO / BALANCE-SIM run the WHOLE thing: `stepSelf(i)` for every
 *     delver's own motion, then `stepWorld()` for monsters, bolts, damage, the
 *     floor lifecycle and the clock.
 *
 *   A GUEST runs only `stepSelf(me)` for its own delver (local, responsive) and
 *     `applySnapshot()` for everything else — monsters, other delvers, HP, the
 *     rune. It never runs monster AI, so a monster is never in two places at once.
 *
 * That split is exactly why host transfer is cheap: a snapshot fully describes the
 * world, so a promoted guest already holds a live dungeon and just starts running
 * `stepWorld()`.
 *
 * ── determinism ──────────────────────────────────────────────────────────────
 *
 * The FLOOR LAYOUT (arena, pillars, rune position, delver spawns) is a pure
 * function of `seed ^ floor`, generated identically on every peer — so it is
 * never on the wire. Monsters ARE host-owned and travel in the snapshot, because
 * only the host runs their AI. Nothing uses Math.random for anything a peer must
 * agree on.
 */

import { makeRng, type Rng, randFloat, randInt } from './engine/rng';
import { tuning } from './tuning';
import type { Mode } from './modes';
import { UPGRADES, type Stats } from './upgrades';

// ── constants ─────────────────────────────────────────────────────────────────

export const HERO_R = 13;
const DASH_SPEED_MUL = 3.2;
const DASH_TIME = 0.16; // seconds of invulnerable dash
const VEL_LERP = 14; // how snappily velocity chases the intent
const REVIVE_R = 48;
const REVIVE_SECS = 2.2;
const BLEED_SECS = 11;
const DESCEND_HEAL = 0.16; // fraction of maxHp healed on descending
const RUNE_R = 48;
const RUNE_FILL = 0.6; // charge/sec per delver standing on it
const RUNE_DRAIN = 0.55;
const RUNE_NEED = 1;
const CONTACT_CD = 0.6; // a monster's melee re-hit cooldown
const ORB_TTL = 16; // seconds an uncollected upgrade orb lingers

export const BASE_STATS: Stats = {
  dmg: 13,
  fireRate: 2.1,
  moveSpeed: 190,
  dashCd: 1.2,
  projectiles: 1,
  pierce: 0,
  boltSpeed: 460,
  range: 520,
  maxHp: 100,
};

export type EnemyKind = 'grub' | 'spitter' | 'brute' | 'boss';

interface EnemyBase {
  hp: number;
  spd: number;
  dmg: number;
  r: number;
  /** Spitters fire; melee kinds leave this undefined. */
  fireEvery?: number;
  boltSpeed?: number;
}

const ENEMY: Record<EnemyKind, EnemyBase> = {
  grub: { hp: 24, spd: 95, dmg: 8, r: 12 },
  spitter: { hp: 30, spd: 56, dmg: 10, r: 12, fireEvery: 2.1, boltSpeed: 220 },
  brute: { hp: 140, spd: 52, dmg: 18, r: 22 },
  boss: { hp: 520, spd: 46, dmg: 26, r: 32, fireEvery: 1.4, boltSpeed: 245 },
};

// ── entities ──────────────────────────────────────────────────────────────────

export interface HeroSpec {
  name: string;
  bot: boolean;
}

export interface Hero {
  i: number;
  name: string;
  bot: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  facing: number;
  /** Intent for this step. */
  ax: number;
  ay: number;
  dash: boolean;
  reviving: boolean;
  dashCd: number;
  dashT: number;
  fireCd: number;
  downed: boolean;
  dead: boolean;
  left: boolean;
  bleed: number;
  /** Being-revived accumulator (0..REVIVE_SECS). */
  revived: number;
  spawnT: number;
  hurtFlash: number;
  stats: Stats;
  ups: string[];
  st: { kills: number; dmg: number; revives: number; deepest: number };
}

export interface Enemy {
  id: number;
  kind: EnemyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  spd: number;
  dmg: number;
  r: number;
  fireEvery: number;
  boltSpeed: number;
  fireCd: number;
  atkCd: number;
  hitFlash: number;
  spawnT: number;
}

export interface Bolt {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  dmg: number;
  foe: boolean;
  ttl: number;
  pierce: number;
  owner: number;
  color: string;
}

export interface Orb {
  id: number;
  x: number;
  y: number;
  up: string;
  color: string;
  t: number;
}

export interface Pillar {
  x: number;
  y: number;
  r: number;
}

export type GameEvent =
  | { k: 'fire'; i: number; x: number; y: number; ang: number }
  | { k: 'spark'; x: number; y: number; color: string }
  | { k: 'kill'; x: number; y: number; kind: EnemyKind; i: number }
  | { k: 'hurt'; i: number; x: number; y: number; heavy: boolean }
  | { k: 'dash'; i: number; x: number; y: number }
  | { k: 'orb'; i: number; x: number; y: number; up: string; color: string }
  | { k: 'downed'; i: number; x: number; y: number }
  | { k: 'revive'; i: number; x: number; y: number }
  | { k: 'clear'; floor: number }
  | { k: 'descend'; floor: number }
  | { k: 'boss'; x: number; y: number }
  | { k: 'wipe'; floor: number };

export interface GameConfig {
  seed: number;
  mode: Mode;
  heroes: HeroSpec[];
}

// ── snapshot (host -> guests) ───────────────────────────────────────────────────

export interface HeroSnap {
  x: number;
  y: number;
  hp: number;
  mhp: number;
  f: number;
  d: 0 | 1; // downed
  x2: 0 | 1; // dead
  lf: 0 | 1; // left
  bl: number;
  rv: number;
  ms: number; // moveSpeed (for guest prediction)
  dc: number; // dashCd max
  up: string[];
}

export interface Snapshot {
  fl: number;
  ph: 0 | 1;
  t: number;
  ov: 0 | 1;
  rc: number;
  ra: 0 | 1;
  rx: number;
  ry: number;
  he: HeroSnap[];
  en: number[]; // [id,kind,x,y,hp,mhp,r] septuples
  bo: number[]; // [id,x,y,vx,vy,r,foe,dmg] octuples
  or: number[]; // [id,x,y,upIdx] quads
  gb: number[]; // grabs: [heroIndex, upIdx] pairs since last snap
}

const KIND_IDX: EnemyKind[] = ['grub', 'spitter', 'brute', 'boss'];

// ── the game ────────────────────────────────────────────────────────────────────

export class Game {
  readonly seed: number;
  readonly mode: Mode;
  readonly players: number;
  floor = 1;
  phase: 'fight' | 'clear' = 'fight';
  over = false;
  wipedFloor = 0;
  t = 0;
  heroes: Hero[] = [];
  enemies: Enemy[] = [];
  bolts: Bolt[] = [];
  orbs: Orb[] = [];
  pillars: Pillar[] = [];
  rune = { x: 0, y: 0, charge: 0, active: false };
  /** Seconds spent fighting the current floor — drives the enrage below. */
  floorT = 0;
  events: GameEvent[] = [];
  /** Grabs since the last snapshot() call, for the host to gossip. */
  private grabs: number[] = [];
  private nextId = 1;
  /** Host-side rolls (enemy fire jitter, orb types). Guests never call these. */
  private wrng: Rng;

  constructor(cfg: GameConfig) {
    this.seed = cfg.seed >>> 0;
    this.mode = cfg.mode;
    this.players = Math.max(1, cfg.heroes.length);
    this.wrng = makeRng(this.seed ^ 0x1a2b3c4d);
    this.heroes = cfg.heroes.map((h, i) => this.makeHero(h, i));
    this.generateFloor(this.floor);
  }

  private makeHero(spec: HeroSpec, i: number): Hero {
    return {
      i,
      name: spec.name,
      bot: spec.bot,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      hp: BASE_STATS.maxHp,
      facing: -Math.PI / 2,
      ax: 0,
      ay: 0,
      dash: false,
      reviving: false,
      dashCd: 0,
      dashT: 0,
      fireCd: 0,
      downed: false,
      dead: false,
      left: false,
      bleed: 0,
      revived: 0,
      spawnT: 0.5,
      hurtFlash: 0,
      stats: { ...BASE_STATS },
      ups: [],
      st: { kills: 0, dmg: 0, revives: 0, deepest: 1 },
    };
  }

  // ── floor layout — deterministic from seed ^ floor ───────────────────────────

  /** Rebuild the static parts of a floor. Run on EVERY peer (never on the wire). */
  generateFloor(floor: number): void {
    this.floor = floor;
    const rng = makeRng((this.seed ^ (floor * 0x9e3779b1)) >>> 0);
    const { arenaW: w, arenaH: h, pillars: np } = this.mode;

    // Delvers enter along the bottom edge, spread out.
    const n = this.heroes.length;
    for (const hero of this.heroes) {
      const t = n === 1 ? 0.5 : hero.i / (n - 1);
      hero.x = (-0.22 + t * 0.44) * w;
      hero.y = h * 0.4;
      hero.vx = 0;
      hero.vy = 0;
      hero.spawnT = 0.45;
    }

    // The rune sits at the far (top) end — you fight your way to it.
    this.rune = { x: randFloat(rng, -0.12, 0.12) * w, y: -h * 0.4, charge: 0, active: false };

    // Cover pillars, kept out of the spawn strip and the rune, and off each other.
    this.pillars = [];
    let guard = 0;
    while (this.pillars.length < np && guard++ < 200) {
      const px = randFloat(rng, -0.4, 0.4) * w;
      const py = randFloat(rng, -0.34, 0.28) * h;
      const r = randFloat(rng, 24, 40);
      if (Math.hypot(px - this.rune.x, py - this.rune.y) < r + RUNE_R + 20) continue;
      if (this.pillars.some((q) => Math.hypot(q.x - px, q.y - py) < q.r + r + 40)) continue;
      this.pillars.push({ x: px, y: py, r });
    }

    this.enemies = [];
    this.bolts = [];
    this.orbs = [];
    this.phase = 'fight';
    this.floorT = 0;
  }

  /**
   * The dungeon closes in if you dawdle. After ~40s on a floor the survivors get
   * faster and hit harder, ramping to 2x — so camping or an unlucky stalemate
   * always resolves into a clear or a death, never an endless kite.
   */
  private enrage(): number {
    return 1 + Math.min(1, Math.max(0, this.floorT - 40) * 0.02);
  }

  /** HOST/SOLO only: spawn this floor's monsters. Guests receive them in a snap. */
  populate(): void {
    const t = tuning();
    const f = this.floor;
    const m = this.mode;
    const rng = makeRng((this.seed ^ (f * 0x85ebca6b)) >>> 0);

    const partyCount = 1 + (this.players - 1) * t.PARTY_COUNT;
    let total = Math.round((m.enemyBase + f * m.enemyPer) * partyCount);
    total = Math.max(1, Math.min(m.enemyCap, total));

    const isBoss = f % m.bossEvery === 0;
    let brutes = f >= 3 ? Math.min(3, Math.floor(total * 0.15)) : 0;
    let spitters = f >= 2 ? Math.floor(total * 0.3) : 0;
    if (isBoss) {
      total = Math.max(3, Math.round(total * 0.7));
      brutes = Math.min(brutes, 1);
      spitters = Math.min(spitters, Math.floor(total * 0.3));
    }
    const grubs = Math.max(0, total - brutes - spitters);

    const plan: EnemyKind[] = [
      ...(isBoss ? (['boss'] as EnemyKind[]) : []),
      ...Array<EnemyKind>(brutes).fill('brute'),
      ...Array<EnemyKind>(spitters).fill('spitter'),
      ...Array<EnemyKind>(grubs).fill('grub'),
    ];

    for (const kind of plan) this.spawnEnemy(kind, rng);
    if (isBoss) {
      const boss = this.enemies[0];
      if (boss) this.events.push({ k: 'boss', x: boss.x, y: boss.y });
    }
  }

  private spawnEnemy(kind: EnemyKind, rng: Rng): void {
    const t = tuning();
    const f = this.floor;
    const base = ENEMY[kind];
    const hpRamp = 1 + (f - 1) * t.RAMP_HP;
    const spdRamp = Math.min(t.RAMP_SPD_CAP, 1 + (f - 1) * t.RAMP_SPD);
    const dmgRamp = 1 + (f - 1) * t.RAMP_DMG;
    const partyHp = 1 + (this.players - 1) * t.PARTY_HP;
    const hp = base.hp * this.mode.hpMul * hpRamp * partyHp;

    // Spawn in the upper two-thirds, away from the delver entry strip.
    const { arenaW: w, arenaH: h } = this.mode;
    let x = 0;
    let y = 0;
    let guard = 0;
    do {
      x = randFloat(rng, -0.44, 0.44) * w;
      y = randFloat(rng, -0.42, 0.12) * h;
      guard++;
    } while (guard < 30 && this.pillars.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + base.r + 6));

    this.enemies.push({
      id: this.nextId++,
      kind,
      x,
      y,
      vx: 0,
      vy: 0,
      hp,
      maxHp: hp,
      spd: base.spd * this.mode.spdMul * spdRamp,
      dmg: base.dmg * this.mode.dmgMul * dmgRamp,
      r: base.r,
      fireEvery: base.fireEvery ?? 0,
      boltSpeed: base.boltSpeed ?? 0,
      fireCd: base.fireEvery ? randFloat(rng, 0.4, base.fireEvery) : 0,
      atkCd: 0,
      hitFlash: 0,
      spawnT: 0.35,
    });
  }

  // ── intents ──────────────────────────────────────────────────────────────────

  setIntent(i: number, ax: number, ay: number, dash: boolean, reviving = false): void {
    const hero = this.heroes[i];
    if (!hero) return;
    hero.ax = ax;
    hero.ay = ay;
    hero.dash = hero.dash || dash;
    hero.reviving = reviving;
  }

  // ── per-delver motion (owned by that delver's peer) ──────────────────────────

  /** Advance delver `i`'s own motion + dash. Every peer runs this for its own. */
  stepSelf(i: number, dt: number): void {
    const hero = this.heroes[i];
    if (!hero || hero.dead || hero.left) return;
    if (hero.spawnT > 0) hero.spawnT = Math.max(0, hero.spawnT - dt);
    if (hero.hurtFlash > 0) hero.hurtFlash = Math.max(0, hero.hurtFlash - dt);
    if (hero.dashCd > 0) hero.dashCd = Math.max(0, hero.dashCd - dt);
    if (hero.dashT > 0) hero.dashT = Math.max(0, hero.dashT - dt);

    if (hero.downed) {
      // A downed delver cannot move — it lies where it fell and bleeds. The bleed
      // clock is host-authoritative (advanced in stepWorld); locally we just stop.
      hero.vx = 0;
      hero.vy = 0;
      hero.dash = false;
      return;
    }

    const len = Math.hypot(hero.ax, hero.ay);
    let ix = 0;
    let iy = 0;
    if (len > 0.001) {
      ix = hero.ax / len;
      iy = hero.ay / len;
    }

    // Dash: a committed burst in the current heading, with i-frames.
    if (hero.dash && hero.dashCd <= 0 && (len > 0.001 || hero.dashT > 0)) {
      hero.dashCd = hero.stats.dashCd;
      hero.dashT = DASH_TIME;
      const dx = len > 0.001 ? ix : Math.cos(hero.facing);
      const dy = len > 0.001 ? iy : Math.sin(hero.facing);
      hero.vx = dx * hero.stats.moveSpeed * DASH_SPEED_MUL;
      hero.vy = dy * hero.stats.moveSpeed * DASH_SPEED_MUL;
      this.events.push({ k: 'dash', i, x: hero.x, y: hero.y });
    }
    hero.dash = false;

    const targetVx = ix * hero.stats.moveSpeed;
    const targetVy = iy * hero.stats.moveSpeed;
    const k = hero.dashT > 0 ? 0 : Math.min(1, VEL_LERP * dt);
    hero.vx += (targetVx - hero.vx) * k;
    hero.vy += (targetVy - hero.vy) * k;

    hero.x += hero.vx * dt;
    hero.y += hero.vy * dt;
    this.clampToArena(hero, HERO_R);
    for (const p of this.pillars) this.pushOut(hero, HERO_R, p);
  }

  private clampToArena(e: { x: number; y: number; vx: number; vy: number }, r: number): void {
    const hw = this.mode.arenaW / 2 - r;
    const hh = this.mode.arenaH / 2 - r;
    if (e.x < -hw) {
      e.x = -hw;
      if (e.vx < 0) e.vx = 0;
    } else if (e.x > hw) {
      e.x = hw;
      if (e.vx > 0) e.vx = 0;
    }
    if (e.y < -hh) {
      e.y = -hh;
      if (e.vy < 0) e.vy = 0;
    } else if (e.y > hh) {
      e.y = hh;
      if (e.vy > 0) e.vy = 0;
    }
  }

  private pushOut(e: { x: number; y: number }, r: number, p: Pillar): void {
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d = Math.hypot(dx, dy);
    const min = r + p.r;
    if (d < min && d > 0.001) {
      e.x = p.x + (dx / d) * min;
      e.y = p.y + (dy / d) * min;
    }
  }

  // ── the shared world (host / solo / sim only) ────────────────────────────────

  stepWorld(dt: number): void {
    if (this.over) return;
    this.t += dt;
    if (this.phase === 'fight') this.floorT += dt;

    this.autoFire(dt);
    this.stepEnemies(dt);
    this.stepBolts(dt);
    this.stepRevive(dt);
    this.devourStragglers(dt);

    if (this.phase === 'fight' && this.enemies.length === 0) {
      this.phase = 'clear';
      this.spawnLoot();
      this.events.push({ k: 'clear', floor: this.floor });
    }
    if (this.phase === 'clear') this.stepRune(dt);
    this.pickUpOrbs();
    // Orbs fade if left too long — grab them or lose them. It also guarantees the
    // rune is never blocked by fixation on an orb tucked behind a pillar.
    for (const o of this.orbs) o.t += dt;
    if (this.orbs.some((o) => o.t > ORB_TTL)) this.orbs = this.orbs.filter((o) => o.t <= ORB_TTL);
  }

  private upHeroes(): Hero[] {
    return this.heroes.filter((h) => !h.downed && !h.dead && !h.left);
  }

  private nearestEnemy(x: number, y: number, maxR = Infinity): Enemy | null {
    let best: Enemy | null = null;
    let bd = maxR * maxR;
    for (const e of this.enemies) {
      const d = (e.x - x) ** 2 + (e.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private autoFire(dt: number): void {
    for (const hero of this.heroes) {
      if (hero.downed || hero.dead || hero.left || hero.spawnT > 0) continue;
      const target = this.nearestEnemy(hero.x, hero.y);
      if (target) hero.facing = Math.atan2(target.y - hero.y, target.x - hero.x);
      hero.fireCd -= dt;
      if (hero.fireCd > 0) continue;
      if (!target) continue;
      if (Math.hypot(target.x - hero.x, target.y - hero.y) > hero.stats.range) continue;
      hero.fireCd = 1 / hero.stats.fireRate;
      const s = hero.stats;
      const spread = 0.14;
      for (let p = 0; p < s.projectiles; p++) {
        const off = (p - (s.projectiles - 1) / 2) * spread;
        const ang = hero.facing + off;
        this.bolts.push({
          id: this.nextId++,
          x: hero.x + Math.cos(ang) * HERO_R,
          y: hero.y + Math.sin(ang) * HERO_R,
          vx: Math.cos(ang) * s.boltSpeed,
          vy: Math.sin(ang) * s.boltSpeed,
          r: 5,
          dmg: s.dmg,
          foe: false,
          ttl: s.range / s.boltSpeed + 0.15,
          pierce: s.pierce,
          owner: hero.i,
          color: '#f0e442',
        });
      }
      this.events.push({ k: 'fire', i: hero.i, x: hero.x, y: hero.y, ang: hero.facing });
    }
  }

  private stepEnemies(dt: number): void {
    const en = this.enrage();
    for (const e of this.enemies) {
      if (e.spawnT > 0) e.spawnT = Math.max(0, e.spawnT - dt);
      if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt);
      if (e.atkCd > 0) e.atkCd -= dt;
      const spd = e.spd * en;
      const dmg = e.dmg * en;

      const target = this.nearestUpHero(e.x, e.y);
      if (!target) {
        e.vx *= 0.9;
        e.vy *= 0.9;
      } else {
        const dx = target.x - e.x;
        const dy = target.y - e.y;
        const d = Math.hypot(dx, dy) || 1;
        const ux = dx / d;
        const uy = dy / d;
        if (e.fireEvery > 0) {
          // Ranged: hold a mid distance and shoot. Under enrage it stops keeping
          // its distance and closes in, so a stalemate always resolves.
          const want = en > 1.4 ? 60 : 260;
          const move = d > want + 40 ? 1 : d < want - 40 ? -0.7 : 0;
          e.vx = ux * spd * move;
          e.vy = uy * spd * move;
          e.fireCd -= dt;
          if (e.fireCd <= 0 && d < 520) {
            e.fireCd = e.fireEvery;
            const lead = d / e.boltSpeed;
            const tx = target.x + target.vx * lead;
            const ty = target.y + target.vy * lead;
            const a = Math.atan2(ty - e.y, tx - e.x);
            this.bolts.push({
              id: this.nextId++,
              x: e.x + Math.cos(a) * e.r,
              y: e.y + Math.sin(a) * e.r,
              vx: Math.cos(a) * e.boltSpeed,
              vy: Math.sin(a) * e.boltSpeed,
              r: 7,
              dmg,
              foe: true,
              ttl: 3,
              pierce: 0,
              owner: -1,
              color: '#cc79a7',
            });
          }
        } else {
          e.vx = ux * spd;
          e.vy = uy * spd;
        }
      }

      e.x += e.vx * dt;
      e.y += e.vy * dt;
      this.clampToArena(e, e.r);
      for (const p of this.pillars) this.pushOut(e, e.r, p);

      // Melee contact. Knockback pushes the delver AWAY from the monster.
      if (target && this.overlap(e, target, HERO_R) && e.atkCd <= 0) {
        this.hurtHero(
          target,
          dmg,
          e.kind === 'brute' || e.kind === 'boss',
          target.x - e.x,
          target.y - e.y,
        );
        e.atkCd = CONTACT_CD;
      }
    }
  }

  /**
   * A hard backstop against a floor that will not resolve — an enemy wedged in
   * geometry, an unlucky stalemate. After ~55s the dungeon devours the survivors,
   * so no floor can last more than about a minute regardless of the AI or the
   * layout. Real play clears in well under this; it only ever bites a stall.
   */
  private devourStragglers(dt: number): void {
    if (this.floorT < 55) return;
    for (const e of [...this.enemies]) {
      this.damageEnemy(e, e.maxHp * 0.22 * dt, -1);
    }
  }

  private nearestUpHero(x: number, y: number): Hero | null {
    let best: Hero | null = null;
    let bd = Infinity;
    for (const h of this.upHeroes()) {
      const d = (h.x - x) ** 2 + (h.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  }

  private overlap(e: Enemy, h: Hero, hr: number): boolean {
    return (e.x - h.x) ** 2 + (e.y - h.y) ** 2 < (e.r + hr) ** 2;
  }

  private stepBolts(dt: number): void {
    const keep: Bolt[] = [];
    for (const b of this.bolts) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.ttl -= dt;
      if (b.ttl <= 0 || this.outOfArena(b)) continue;
      // Pillars block ENEMY fire only — they are cover for the delvers. Hero bolts
      // fly over them; if they were absorbed too, a spitter could camp behind a
      // pillar and become unkillable, softlocking the floor (a real sim finding).
      if (b.foe && this.pillars.some((p) => (b.x - p.x) ** 2 + (b.y - p.y) ** 2 < (p.r + b.r) ** 2)) {
        this.events.push({ k: 'spark', x: b.x, y: b.y, color: '#7a8699' });
        continue;
      }

      if (b.foe) {
        let hit = false;
        for (const h of this.upHeroes()) {
          if ((b.x - h.x) ** 2 + (b.y - h.y) ** 2 < (HERO_R + b.r) ** 2) {
            this.hurtHero(h, b.dmg, false, b.vx, b.vy);
            hit = true;
            break;
          }
        }
        if (hit) continue;
      } else {
        let consumed = false;
        for (const e of this.enemies) {
          if ((b.x - e.x) ** 2 + (b.y - e.y) ** 2 < (e.r + b.r) ** 2) {
            this.damageEnemy(e, b.dmg, b.owner);
            this.events.push({ k: 'spark', x: b.x, y: b.y, color: '#f0e442' });
            if (b.pierce > 0) {
              b.pierce -= 1;
            } else {
              consumed = true;
            }
            break;
          }
        }
        if (consumed) continue;
      }
      keep.push(b);
    }
    this.bolts = keep;
  }

  private outOfArena(b: Bolt): boolean {
    const hw = this.mode.arenaW / 2 + 30;
    const hh = this.mode.arenaH / 2 + 30;
    return b.x < -hw || b.x > hw || b.y < -hh || b.y > hh;
  }

  private damageEnemy(e: Enemy, dmg: number, owner: number): void {
    e.hp -= dmg;
    e.hitFlash = 0.08;
    const h = this.heroes[owner];
    if (h) h.st.dmg += dmg;
    if (e.hp <= 0) {
      this.enemies.splice(this.enemies.indexOf(e), 1);
      if (h) h.st.kills += 1;
      this.events.push({ k: 'kill', x: e.x, y: e.y, kind: e.kind, i: owner });
    }
  }

  private hurtHero(h: Hero, dmg: number, heavy: boolean, kx: number, ky: number): void {
    if (h.downed || h.dead || h.left || h.dashT > 0 || h.spawnT > 0) return;
    h.hp -= dmg;
    h.hurtFlash = 0.25;
    const kick = heavy ? 120 : 60;
    const d = Math.hypot(kx, ky) || 1;
    h.vx += (kx / d) * kick;
    h.vy += (ky / d) * kick;
    this.events.push({ k: 'hurt', i: h.i, x: h.x, y: h.y, heavy });
    if (h.hp <= 0) this.goDown(h);
  }

  private goDown(h: Hero): void {
    h.hp = 0;
    h.downed = true;
    h.bleed = BLEED_SECS;
    h.revived = 0;
    h.vx = 0;
    h.vy = 0;
    this.events.push({ k: 'downed', i: h.i, x: h.x, y: h.y });
    this.checkWipe();
  }

  private stepRevive(dt: number): void {
    for (const h of this.heroes) {
      if (!h.downed) continue;
      // A living delver standing close fills the revive meter (faster with more).
      // Proximity is enough — no button; running to a fallen friend IS the input.
      let helpers = 0;
      for (const r of this.upHeroes()) {
        if ((r.x - h.x) ** 2 + (r.y - h.y) ** 2 < REVIVE_R ** 2) helpers++;
      }
      if (helpers > 0) {
        h.revived += dt * helpers;
        if (h.revived >= REVIVE_SECS) {
          h.downed = false;
          h.bleed = 0;
          h.revived = 0;
          h.hp = h.stats.maxHp * 0.4;
          h.spawnT = 0.3;
          for (const r of this.upHeroes()) {
            if ((r.x - h.x) ** 2 + (r.y - h.y) ** 2 < REVIVE_R ** 2) r.st.revives += 1;
          }
          this.events.push({ k: 'revive', i: h.i, x: h.x, y: h.y });
        }
      } else {
        h.revived = Math.max(0, h.revived - dt * 0.5);
        h.bleed -= dt;
        if (h.bleed <= 0) {
          h.downed = false;
          h.dead = true;
          this.checkWipe();
        }
      }
    }
  }

  private checkWipe(): void {
    if (this.over) return;
    if (this.upHeroes().length === 0) {
      this.over = true;
      this.wipedFloor = this.floor;
      this.events.push({ k: 'wipe', floor: this.floor });
    }
  }

  private spawnLoot(): void {
    const n = 2 + (this.floor % this.mode.bossEvery === 0 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const up = UPGRADES[randInt(this.wrng, 0, UPGRADES.length - 1)];
      // Place near the centre but clear of pillars, so an orb is always reachable.
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 20; tries++) {
        const a = (i / n) * Math.PI * 2 + randFloat(this.wrng, 0, 1);
        const rad = randFloat(this.wrng, 60, 130);
        x = Math.cos(a) * rad;
        y = Math.sin(a) * rad * 0.6;
        if (!this.pillars.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + 26)) break;
      }
      this.orbs.push({ id: this.nextId++, x, y, up: up.id, color: up.color, t: 0 });
    }
  }

  private pickUpOrbs(): void {
    if (!this.orbs.length) return;
    const keep: Orb[] = [];
    for (const o of this.orbs) {
      let taken = false;
      for (const h of this.upHeroes()) {
        if ((o.x - h.x) ** 2 + (o.y - h.y) ** 2 < (HERO_R + 15) ** 2) {
          this.applyUpgrade(h, o.up);
          this.events.push({ k: 'orb', i: h.i, x: h.x, y: h.y, up: o.up, color: o.color });
          this.grabs.push(h.i, UPGRADES.findIndex((u) => u.id === o.up));
          taken = true;
          break;
        }
      }
      if (!taken) keep.push(o);
    }
    this.orbs = keep;
  }

  private applyUpgrade(h: Hero, upId: string): void {
    const up = UPGRADES.find((u) => u.id === upId);
    if (!up) return;
    const heal = up.apply(h.stats);
    h.hp = Math.min(h.stats.maxHp, h.hp + heal);
    h.ups.push(upId);
  }

  private stepRune(dt: number): void {
    this.rune.active = true;
    let on = 0;
    for (const h of this.upHeroes()) {
      if ((h.x - this.rune.x) ** 2 + (h.y - this.rune.y) ** 2 < RUNE_R ** 2) on++;
    }
    if (on > 0) this.rune.charge = Math.min(RUNE_NEED, this.rune.charge + RUNE_FILL * on * dt);
    else this.rune.charge = Math.max(0, this.rune.charge - RUNE_DRAIN * dt);
    if (this.rune.charge >= RUNE_NEED) this.descend();
  }

  private descend(): void {
    this.floor += 1;
    for (const h of this.upHeroes()) {
      h.hp = Math.min(h.stats.maxHp, h.hp + h.stats.maxHp * DESCEND_HEAL);
      h.st.deepest = this.floor;
    }
    this.generateFloor(this.floor);
    this.populate();
    this.events.push({ k: 'descend', floor: this.floor });
  }

  // ── snapshot ─────────────────────────────────────────────────────────────────

  snapshot(): Snapshot {
    const gb = this.grabs.splice(0);
    return {
      fl: this.floor,
      ph: this.phase === 'clear' ? 1 : 0,
      t: Math.round(this.t * 10) / 10,
      ov: this.over ? 1 : 0,
      rc: Math.round(this.rune.charge * 100) / 100,
      ra: this.rune.active ? 1 : 0,
      rx: Math.round(this.rune.x),
      ry: Math.round(this.rune.y),
      he: this.heroes.map((h) => ({
        x: Math.round(h.x),
        y: Math.round(h.y),
        hp: Math.round(h.hp),
        mhp: Math.round(h.stats.maxHp),
        f: Math.round(h.facing * 100) / 100,
        d: h.downed ? 1 : 0,
        x2: h.dead ? 1 : 0,
        lf: h.left ? 1 : 0,
        bl: Math.round(h.bleed * 10) / 10,
        rv: Math.round(h.revived * 100) / 100,
        ms: Math.round(h.stats.moveSpeed),
        dc: Math.round(h.stats.dashCd * 100) / 100,
        up: h.ups,
      })),
      en: this.enemies.flatMap((e) => [
        e.id,
        KIND_IDX.indexOf(e.kind),
        Math.round(e.x),
        Math.round(e.y),
        Math.round(e.hp),
        Math.round(e.maxHp),
        e.r,
      ]),
      bo: this.bolts.flatMap((b) => [
        b.id,
        Math.round(b.x),
        Math.round(b.y),
        Math.round(b.vx),
        Math.round(b.vy),
        b.r,
        b.foe ? 1 : 0,
        Math.round(b.dmg),
      ]),
      or: this.orbs.flatMap((o) => [
        o.id,
        Math.round(o.x),
        Math.round(o.y),
        UPGRADES.findIndex((u) => u.id === o.up),
      ]),
      gb,
    };
  }

  /**
   * Apply a host snapshot on a guest. `me` keeps its OWN position (it owns its
   * motion) but adopts everything else. Synthesises juice events by diffing.
   */
  applySnapshot(snap: Snapshot, me: number): void {
    // A floor change means the static layout changed — rebuild it locally (never
    // on the wire) before adopting monsters, so pillars/rune match the host.
    if (snap.fl !== this.floor) {
      const climbed = snap.fl > this.floor;
      this.floor = snap.fl;
      this.generateFloor(this.floor);
      if (climbed) this.events.push({ k: 'descend', floor: this.floor });
    }
    this.phase = snap.ph ? 'clear' : 'fight';
    this.t = snap.t;
    this.rune.x = snap.rx;
    this.rune.y = snap.ry;
    this.rune.charge = snap.rc;
    this.rune.active = !!snap.ra;

    for (const [i, hs] of snap.he.entries()) {
      const h = this.heroes[i];
      if (!h) continue;
      const wasDown = h.downed || h.dead;
      if (i !== me) {
        h.x = hs.x;
        h.y = hs.y;
      }
      const prevHp = h.hp;
      h.hp = hs.hp;
      h.stats.maxHp = hs.mhp;
      h.stats.moveSpeed = hs.ms;
      h.stats.dashCd = hs.dc;
      h.facing = hs.f;
      h.downed = !!hs.d;
      h.dead = !!hs.x2;
      h.left = !!hs.lf;
      h.bleed = hs.bl;
      h.revived = hs.rv;
      h.ups = hs.up;
      if (hs.hp < prevHp - 0.5 && !h.downed && !h.dead) {
        h.hurtFlash = 0.25;
        this.events.push({ k: 'hurt', i, x: h.x, y: h.y, heavy: prevHp - hs.hp > 15 });
      }
      if ((h.downed || h.dead) && !wasDown) this.events.push({ k: 'downed', i, x: h.x, y: h.y });
      if (!h.downed && !h.dead && wasDown && h.hp > 0)
        this.events.push({ k: 'revive', i, x: h.x, y: h.y });
    }

    // Monsters: diff the id set to fire death bursts for the ones that vanished.
    const prev = new Map(this.enemies.map((e) => [e.id, e]));
    const next: Enemy[] = [];
    const seen = new Set<number>();
    for (let k = 0; k + 6 < snap.en.length; k += 7) {
      const id = snap.en[k];
      seen.add(id);
      const kind = KIND_IDX[snap.en[k + 1]] ?? 'grub';
      const old = prev.get(id);
      const e: Enemy =
        old ??
        ({
          id,
          kind,
          x: snap.en[k + 2],
          y: snap.en[k + 3],
          hp: snap.en[k + 4],
          maxHp: snap.en[k + 5],
          spd: 0,
          dmg: 0,
          r: snap.en[k + 6],
          vx: 0,
          vy: 0,
          fireEvery: 0,
          boltSpeed: 0,
          fireCd: 0,
          atkCd: 0,
          hitFlash: 0,
          spawnT: 0.35,
        } as Enemy);
      // Smooth toward the host's position rather than snapping.
      e.hitFlash = e.hp > snap.en[k + 4] ? 0.08 : e.hitFlash;
      e.x = snap.en[k + 2];
      e.y = snap.en[k + 3];
      e.hp = snap.en[k + 4];
      e.maxHp = snap.en[k + 5];
      e.r = snap.en[k + 6];
      next.push(e);
    }
    for (const [eid, e] of prev) {
      if (!seen.has(eid)) this.events.push({ k: 'kill', x: e.x, y: e.y, kind: e.kind, i: -1 });
    }
    this.enemies = next;

    this.bolts = [];
    for (let k = 0; k + 7 < snap.bo.length; k += 8) {
      this.bolts.push({
        id: snap.bo[k],
        x: snap.bo[k + 1],
        y: snap.bo[k + 2],
        vx: snap.bo[k + 3],
        vy: snap.bo[k + 4],
        r: snap.bo[k + 5],
        foe: snap.bo[k + 6] === 1,
        dmg: snap.bo[k + 7],
        ttl: 3,
        pierce: 0,
        owner: -1,
        color: snap.bo[k + 6] === 1 ? '#cc79a7' : '#f0e442',
      });
    }

    this.orbs = [];
    for (let k = 0; k + 3 < snap.or.length; k += 4) {
      const up = UPGRADES[snap.or[k + 3]];
      this.orbs.push({
        id: snap.or[k],
        x: snap.or[k + 1],
        y: snap.or[k + 2],
        up: up?.id ?? 'power',
        color: up?.color ?? '#fff',
        t: 0,
      });
    }

    for (let k = 0; k + 1 < snap.gb.length; k += 2) {
      const h = this.heroes[snap.gb[k]];
      const up = UPGRADES[snap.gb[k + 1]];
      if (h && up) this.events.push({ k: 'orb', i: h.i, x: h.x, y: h.y, up: up.id, color: up.color });
    }

    this.over = !!snap.ov;
    if (this.over && !this.wipedFloor) this.wipedFloor = this.floor;
  }

  // ── host transfer support ────────────────────────────────────────────────────
  //
  // A guest's world came entirely from snapshots, which carry positions and HP
  // but not the derived COMBAT stats (a snapshot has no reason to). When such a
  // peer is promoted it must run the sim, so it recomputes those stats from the
  // same deterministic formulas the host used — no reconstruction from the wire,
  // just the pure functions every peer already agrees on.

  /** Rebuild every delver's stat block from base + its collected upgrades. */
  rebuildStats(): void {
    for (const h of this.heroes) {
      const hp = h.hp;
      h.stats = { ...BASE_STATS };
      for (const id of h.ups) {
        const up = UPGRADES.find((u) => u.id === id);
        up?.apply(h.stats);
      }
      h.hp = Math.min(hp, h.stats.maxHp);
    }
  }

  /** Recompute monster combat stats (speed/damage/fire) from kind + floor. */
  rehydrateEnemies(): void {
    const t = tuning();
    const f = this.floor;
    const spdRamp = Math.min(t.RAMP_SPD_CAP, 1 + (f - 1) * t.RAMP_SPD);
    const dmgRamp = 1 + (f - 1) * t.RAMP_DMG;
    for (const e of this.enemies) {
      const base = ENEMY[e.kind];
      e.spd = base.spd * this.mode.spdMul * spdRamp;
      e.dmg = base.dmg * this.mode.dmgMul * dmgRamp;
      e.fireEvery = base.fireEvery ?? 0;
      e.boltSpeed = base.boltSpeed ?? 0;
    }
  }

  /** Set a delver's dash i-frame timer from a peer's pose flag (host only). */
  setDashing(i: number): void {
    const h = this.heroes[i];
    if (h) h.dashT = Math.max(h.dashT, 0.12);
  }

  /** Decay the transient timers of a delver this peer does not itself step. */
  decayRemote(i: number, dt: number): void {
    const h = this.heroes[i];
    if (!h) return;
    if (h.dashT > 0) h.dashT = Math.max(0, h.dashT - dt);
    if (h.hurtFlash > 0) h.hurtFlash = Math.max(0, h.hurtFlash - dt);
    if (h.spawnT > 0) h.spawnT = Math.max(0, h.spawnT - dt);
  }

  // ── a delver leaves the room ─────────────────────────────────────────────────

  dissolve(i: number): void {
    const h = this.heroes[i];
    if (!h || h.left) return;
    h.left = true;
    h.downed = false;
    h.dead = false;
    this.checkWipe();
  }

  // ── queries for HUD / results ────────────────────────────────────────────────

  /** Living, not-downed delvers standing on the lit rune (for the HUD). */
  onRune(): number {
    if (!this.rune.active) return 0;
    let n = 0;
    for (const h of this.upHeroes())
      if ((h.x - this.rune.x) ** 2 + (h.y - this.rune.y) ** 2 < RUNE_R ** 2) n++;
    return n;
  }

  aliveCount(): number {
    return this.upHeroes().length;
  }
}

