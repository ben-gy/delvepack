/**
 * ai.ts — a scripted delver, used ONLY by the balance sim (there are no AI
 * companions in the real game; solo is one human delver).
 *
 * It has to play well enough that the survival curve `tests/balance.test.ts`
 * measures is the curve a competent player would meet — an AI that walks into
 * monsters would make the dungeon look far deadlier than it is. So it kites at a
 * comfortable range, dashes out of danger, grabs orbs, revives downed teammates,
 * and stands on the rune to descend. It is not optimal, and it should not be:
 * the point is a fair reading of the ramp, not a speedrun.
 */

import type { Game, Hero } from './game';
import { HERO_R } from './game';
import type { Rng } from '@ben-gy/game-engine/rng';

export interface Intent {
  ax: number;
  ay: number;
  dash: boolean;
  reviving: boolean;
}

const IDLE: Intent = { ax: 0, ay: 0, dash: false, reviving: false };

export function heroIntent(g: Game, i: number, rng: Rng): Intent {
  const me = g.heroes[i];
  if (!me || me.downed || me.dead || me.left) return IDLE;

  // A dangerously close monster or incoming bolt → dash clear of it.
  const threat = nearestThreat(g, me);
  if (threat && threat.d < 46 && me.dashCd <= 0) {
    const away = norm(me.x - threat.x, me.y - threat.y);
    return { ax: away.x, ay: away.y, dash: true, reviving: false };
  }

  // Between floors: grab orbs, then ride the rune down.
  if (g.phase === 'clear') {
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (const o of g.orbs) {
      const d = (o.x - me.x) ** 2 + (o.y - me.y) ** 2;
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    const goal = best ?? g.rune;
    const to = norm(goal.x - me.x, goal.y - me.y);
    return { ax: to.x, ay: to.y, dash: false, reviving: false };
  }

  // Revive a downed teammate if it is safe-ish to approach.
  const downed = downedTeammate(g, me);
  if (downed && (!threat || threat.d > 90)) {
    const to = norm(downed.x - me.x, downed.y - me.y);
    const near = (downed.x - me.x) ** 2 + (downed.y - me.y) ** 2 < 44 ** 2;
    return { ax: near ? 0 : to.x, ay: near ? 0 : to.y, dash: false, reviving: near };
  }

  // Fight: kite the nearest monster at a comfortable range, strafing.
  const target = nearestEnemy(g, me);
  if (!target) {
    // Drift toward the middle if the floor is momentarily empty.
    const to = norm(-me.x, -me.y);
    return { ax: to.x * 0.4, ay: to.y * 0.4, dash: false, reviving: false };
  }
  const dx = target.x - me.x;
  const dy = target.y - me.y;
  const d = Math.hypot(dx, dy) || 1;
  const want = 175;
  const toward = norm(dx, dy);
  const perp = { x: -toward.y, y: toward.x };
  const side = (i % 2 === 0 ? 1 : -1) * (Math.sin(g.t * 0.6 + i) >= 0 ? 1 : -1);
  let ax = perp.x * side;
  let ay = perp.y * side;
  if (d < want - 30) {
    ax -= toward.x * 1.2;
    ay -= toward.y * 1.2;
  } else if (d > want + 60) {
    ax += toward.x * 0.9;
    ay += toward.y * 0.9;
  }

  // Spread out from teammates. This is what makes a party WORK: split apart and
  // the monsters split their chase, so each delver faces fewer pursuers and the
  // combined damage clears the floor faster. A clumped party is a worse party.
  for (const o of g.heroes) {
    if (o.i === me.i || o.downed || o.dead || o.left) continue;
    const ox = me.x - o.x;
    const oy = me.y - o.y;
    const od = Math.hypot(ox, oy);
    if (od < 150 && od > 0.1) {
      ax += (ox / od) * (1 - od / 150) * 1.3;
      ay += (oy / od) * (1 - od / 150) * 1.3;
    }
  }

  // Don't kite yourself into a wall — a competent player keeps room to retreat.
  const hw = g.mode.arenaW / 2;
  const hh = g.mode.arenaH / 2;
  if (me.x > hw * 0.78) ax -= (me.x / hw - 0.78) * 4;
  if (me.x < -hw * 0.78) ax -= (me.x / hw + 0.78) * 4;
  if (me.y > hh * 0.78) ay -= (me.y / hh - 0.78) * 4;
  if (me.y < -hh * 0.78) ay -= (me.y / hh + 0.78) * 4;

  // A little jitter so many delvers do not overlap perfectly.
  ax += (rng() - 0.5) * 0.3;
  ay += (rng() - 0.5) * 0.3;
  const dash = threat != null && threat.d < 70 && me.dashCd <= 0;
  const n = norm(ax, ay);
  return { ax: n.x, ay: n.y, dash, reviving: false };
}

function norm(x: number, y: number): { x: number; y: number } {
  const d = Math.hypot(x, y);
  return d < 0.001 ? { x: 0, y: 0 } : { x: x / d, y: y / d };
}

function nearestEnemy(g: Game, me: Hero): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (const e of g.enemies) {
    const d = (e.x - me.x) ** 2 + (e.y - me.y) ** 2;
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

function nearestThreat(g: Game, me: Hero): { x: number; y: number; d: number } | null {
  let best: { x: number; y: number; d: number } | null = null;
  for (const e of g.enemies) {
    const d = Math.hypot(e.x - me.x, e.y - me.y) - e.r - HERO_R;
    if (!best || d < best.d) best = { x: e.x, y: e.y, d };
  }
  for (const b of g.bolts) {
    if (!b.foe) continue;
    // Only count a bolt that is roughly heading at me.
    const rx = me.x - b.x;
    const ry = me.y - b.y;
    const along = rx * b.vx + ry * b.vy;
    if (along <= 0) continue;
    const d = Math.hypot(rx, ry) - b.r - HERO_R;
    if (!best || d < best.d) best = { x: b.x, y: b.y, d };
  }
  return best;
}

function downedTeammate(g: Game, me: Hero): Hero | null {
  let best: Hero | null = null;
  let bd = Infinity;
  for (const h of g.heroes) {
    if (h.i === me.i || !h.downed) continue;
    const d = (h.x - me.x) ** 2 + (h.y - me.y) ** 2;
    if (d < bd) {
      bd = d;
      best = h;
    }
  }
  return best;
}
