// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * render.ts — draw the dungeon. The whole arena is fit to the viewport (no
 * camera scroll) so every delver stays on screen — this is a co-op game and you
 * need to see your teammates and the downed one you are running to revive.
 *
 * Monsters and remote delvers arrive at ~16Hz in a snapshot; drawing their raw
 * positions would stutter. So the renderer keeps a smoothed display position per
 * entity and eases it toward the sim each frame, decoupling visual smoothness
 * from the network rate. The LOCAL delver is never smoothed — it is simulated
 * here, every frame, and must feel instant.
 */

import { Game, HERO_R, type Hero, type Enemy } from './game';
import { delverColor, MONSTER_COLORS, type Fx } from './fx';
import { UPGRADE_BY_ID } from './upgrades';

const BG = '#0b0f1a';
const FLOOR = '#141b2e';
const GRID = '#1d2740';
const WALL = '#2a3450';

interface Smooth {
  x: number;
  y: number;
}

export function createRenderer(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  let W = canvas.width;
  let H = canvas.height;
  let dpr = 1;
  let scale = 1;
  let ox = 0;
  let oy = 0;
  const es = new Map<number, Smooth>();
  const hs = new Map<number, Smooth>();

  function resize(w: number, h: number, ratio: number): void {
    if (w <= 0 || h <= 0) return; // ignore transient 0-size measurements
    dpr = ratio;
    W = w;
    H = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  function fit(g: Game): void {
    // Less padding on the short side so a landscape arena uses more of a portrait
    // phone; the top/bottom margins are where the HUD and the touch pad live.
    const pad = Math.max(10, Math.min(W, H) * 0.03);
    const aw = g.mode.arenaW;
    const ah = g.mode.arenaH;
    scale = Math.min((W - pad * 2) / aw, (H - pad * 2) / ah);
    ox = W / 2;
    oy = H / 2;
  }

  const sx = (x: number): number => ox + x * scale;
  const sy = (y: number): number => oy + y * scale;

  function ease(map: Map<number, Smooth>, id: number, x: number, y: number, dt: number): Smooth {
    let s = map.get(id);
    if (!s) {
      s = { x, y };
      map.set(id, s);
    }
    const k = 1 - Math.exp(-18 * dt);
    s.x += (x - s.x) * k;
    s.y += (y - s.y) * k;
    return s;
  }

  function draw(g: Game, me: number, fx: Fx, dt: number): void {
    fit(g);
    const sh = fx.shakeVec();
    ctx.setTransform(dpr, 0, 0, dpr, sh.x * dpr, sh.y * dpr);
    ctx.clearRect(-40, -40, W + 80, H + 80);
    ctx.fillStyle = BG;
    ctx.fillRect(-40, -40, W + 80, H + 80);

    // Arena floor + grid.
    const hw = (g.mode.arenaW / 2) * scale;
    const hh = (g.mode.arenaH / 2) * scale;
    ctx.fillStyle = FLOOR;
    roundRect(ctx, ox - hw, oy - hh, hw * 2, hh * 2, 14);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, ox - hw, oy - hh, hw * 2, hh * 2, 14);
    ctx.clip();
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    const gs = 64 * scale;
    for (let x = ox - hw; x <= ox + hw; x += gs) line(ctx, x, oy - hh, x, oy + hh);
    for (let y = oy - hh; y <= oy + hh; y += gs) line(ctx, ox - hw, y, ox + hw, y);
    ctx.restore();
    ctx.strokeStyle = WALL;
    ctx.lineWidth = 3;
    roundRect(ctx, ox - hw, oy - hh, hw * 2, hh * 2, 14);
    ctx.stroke();

    // Pillars.
    for (const p of g.pillars) {
      ctx.fillStyle = '#20293f';
      circle(ctx, sx(p.x), sy(p.y), p.r * scale);
      ctx.fill();
      ctx.strokeStyle = WALL;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Rune (exit) — pulses when active.
    if (g.rune.active || g.phase === 'clear') drawRune(ctx, g, sx(g.rune.x), sy(g.rune.y), scale);

    // Orbs.
    for (const o of g.orbs) {
      const pulse = 1 + Math.sin(o.t * 5) * 0.12;
      const r = 11 * scale * pulse;
      const gx = sx(o.x);
      const gy = sy(o.y);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = o.color;
      circle(ctx, gx, gy, r * 1.8);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = o.color;
      circle(ctx, gx, gy, r);
      ctx.fill();
      ctx.fillStyle = '#0b0f1a';
      ctx.font = `${Math.round(11 * scale)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(glyph(o.up), gx, gy + 0.5);
    }

    // Bolts.
    for (const b of g.bolts) {
      ctx.fillStyle = b.color;
      if (b.foe) {
        circle(ctx, sx(b.x), sy(b.y), b.r * scale);
        ctx.fill();
      } else {
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 3 * scale;
        ctx.lineCap = 'round';
        const len = 10 * scale;
        const d = Math.hypot(b.vx, b.vy) || 1;
        line(ctx, sx(b.x), sy(b.y), sx(b.x) - (b.vx / d) * len, sy(b.y) - (b.vy / d) * len);
      }
    }

    // Monsters (smoothed).
    for (const e of g.enemies) {
      const s = ease(es, e.id, e.x, e.y, dt);
      drawEnemy(ctx, e, sx(s.x), sy(s.y), scale);
    }
    // Prune stale smoothers.
    if (es.size > g.enemies.length + 40) {
      const live = new Set(g.enemies.map((e) => e.id));
      for (const id of es.keys()) if (!live.has(id)) es.delete(id);
    }

    // Delvers.
    for (const h of g.heroes) {
      if (h.left) continue;
      const pos = h.i === me ? { x: h.x, y: h.y } : ease(hs, h.i, h.x, h.y, dt);
      drawHero(ctx, h, sx(pos.x), sy(pos.y), scale, h.i === me);
    }

    // Particles.
    for (const p of fx.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      circle(ctx, sx(p.x), sy(p.y), p.size * scale);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Rings.
    for (const r of fx.rings) {
      const t = r.t / r.max;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3 * (1 - t) * scale;
      circle(ctx, sx(r.x), sy(r.y), (r.r * (0.4 + t)) * scale);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Floating numbers.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of fx.nums) {
      ctx.globalAlpha = Math.max(0, 1 - n.t / 0.8);
      ctx.fillStyle = n.color;
      ctx.font = `700 ${Math.round(15 * scale + 4)}px system-ui, sans-serif`;
      ctx.fillText(n.text, sx(n.x), sy(n.y));
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function toWorld(px: number, py: number): { x: number; y: number } {
    return { x: (px - ox) / scale, y: (py - oy) / scale };
  }

  return { resize, draw, toWorld };
}

function drawEnemy(ctx: CanvasRenderingContext2D, e: Enemy, x: number, y: number, scale: number): void {
  const r = e.r * scale * (e.spawnT > 0 ? 1 - e.spawnT / 0.35 : 1);
  const color = e.hitFlash > 0 ? '#ffffff' : MONSTER_COLORS[e.kind] ?? '#aaa';
  ctx.fillStyle = color;
  ctx.strokeStyle = '#0b0f1a';
  ctx.lineWidth = 2;
  if (e.kind === 'grub') {
    circle(ctx, x, y, r);
    ctx.fill();
    ctx.stroke();
  } else if (e.kind === 'spitter') {
    poly(ctx, x, y, r * 1.15, 4, Math.PI / 4);
    ctx.fill();
    ctx.stroke();
  } else {
    poly(ctx, x, y, r * 1.1, 6, 0);
    ctx.fill();
    ctx.stroke();
    if (e.kind === 'boss') {
      ctx.strokeStyle = '#f0e442';
      ctx.lineWidth = 3;
      poly(ctx, x, y, r * 1.35, 6, 0);
      ctx.stroke();
    }
  }
  // HP bar for anything not at full.
  if (e.hp < e.maxHp) {
    const bw = e.r * scale * 1.8;
    const frac = Math.max(0, e.hp / e.maxHp);
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(x - bw / 2, y - r - 8, bw, 4);
    ctx.fillStyle = '#e34b4b';
    ctx.fillRect(x - bw / 2, y - r - 8, bw * frac, 4);
  }
}

function drawHero(
  ctx: CanvasRenderingContext2D,
  h: Hero,
  x: number,
  y: number,
  scale: number,
  isMe: boolean,
): void {
  const color = delverColor(h.i);
  const r = HERO_R * scale;
  if (h.dead) {
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    line(ctx, x - r * 0.6, y - r * 0.6, x + r * 0.6, y + r * 0.6);
    line(ctx, x - r * 0.6, y + r * 0.6, x + r * 0.6, y - r * 0.6);
    ctx.globalAlpha = 1;
    label(ctx, h.name, x, y + r + 12, color, scale);
    return;
  }

  if (h.dashT > 0) {
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = color;
    circle(ctx, x, y, r * 1.5);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Barrel showing where auto-fire points.
  if (!h.downed) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4 * scale;
    ctx.lineCap = 'round';
    line(ctx, x, y, x + Math.cos(h.facing) * r * 1.6, y + Math.sin(h.facing) * r * 1.6);
  }

  ctx.fillStyle = h.downed ? '#5a6580' : h.hurtFlash > 0 ? '#ffffff' : color;
  circle(ctx, x, y, r);
  ctx.fill();
  ctx.strokeStyle = isMe ? '#ffffff' : '#0b0f1a';
  ctx.lineWidth = isMe ? 3 : 2;
  ctx.stroke();

  if (h.downed) {
    // A revive arc filling around a downed delver.
    ctx.strokeStyle = '#f0e442';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.6, -Math.PI / 2, -Math.PI / 2 + (h.revived / 2.2) * Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#f0e442';
    ctx.font = `700 ${Math.round(12 * scale + 2)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', x, y);
  } else {
    // HP bar.
    const bw = r * 2.6;
    const frac = Math.max(0, h.hp / h.stats.maxHp);
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    ctx.fillRect(x - bw / 2, y - r - 9, bw, 4);
    ctx.fillStyle = frac > 0.4 ? '#009e73' : '#e69f00';
    ctx.fillRect(x - bw / 2, y - r - 9, bw * frac, 4);
  }
  label(ctx, h.name + (isMe ? ' (you)' : ''), x, y + r + 12, color, scale);
}

function drawRune(ctx: CanvasRenderingContext2D, g: Game, x: number, y: number, scale: number): void {
  const r = 48 * scale;
  const pulse = 1 + Math.sin(g.t * 4) * 0.08;
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#56b4e9';
  circle(ctx, x, y, r * pulse);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#56b4e9';
  ctx.lineWidth = 2;
  circle(ctx, x, y, r);
  ctx.stroke();
  // Descending chevrons.
  ctx.strokeStyle = '#8fd3ff';
  ctx.lineWidth = 3 * scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = -1; i <= 1; i++) {
    const cy = y + i * 12 * scale;
    ctx.beginPath();
    ctx.moveTo(x - 14 * scale, cy - 5 * scale);
    ctx.lineTo(x, cy + 5 * scale);
    ctx.lineTo(x + 14 * scale, cy - 5 * scale);
    ctx.stroke();
  }
  // Charge arc.
  if (g.rune.charge > 0) {
    ctx.strokeStyle = '#f0e442';
    ctx.lineWidth = 5 * scale;
    ctx.beginPath();
    ctx.arc(x, y, r + 6 * scale, -Math.PI / 2, -Math.PI / 2 + g.rune.charge * Math.PI * 2);
    ctx.stroke();
  }
}

function glyph(up: string): string {
  const map: Record<string, string> = {
    power: '⚔',
    rapid: '»',
    multishot: '∴',
    swift: '❯',
    vigor: '♥',
    pierce: '→',
    dash: '⚡',
    velocity: '▶',
  };
  return map[up] ?? UPGRADE_BY_ID[up]?.name?.[0] ?? '?';
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  scale: number,
): void {
  ctx.font = `600 ${Math.round(10 * scale + 2)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillText(text, x + 1, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// ── canvas primitives ─────────────────────────────────────────────────────────

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function poly(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  sides: number,
  rot: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
