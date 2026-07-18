/**
 * fx.ts — the theatre. Particles, screen shake, hit-stop, floating numbers.
 *
 * The sim (game.ts) stays pure; this turns its events into light and noise. All
 * of it respects prefers-reduced-motion: shake goes to zero and particle counts
 * are cut, because the game must be playable, not just pretty.
 */

const reduce =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Okabe-Ito, colour-blind-safe. Delvers cycle these; monsters have their own. */
export const DELVER_COLORS = ['#56b4e9', '#e69f00', '#009e73', '#cc79a7'];

export function delverColor(i: number): string {
  return DELVER_COLORS[((i % DELVER_COLORS.length) + DELVER_COLORS.length) % DELVER_COLORS.length];
}

export const MONSTER_COLORS: Record<string, string> = {
  grub: '#8fbf6b',
  spitter: '#cc79a7',
  brute: '#d55e00',
  boss: '#e34b4b',
};

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}

interface Ring {
  x: number;
  y: number;
  t: number;
  max: number;
  color: string;
  r: number;
}

interface FloatNum {
  x: number;
  y: number;
  t: number;
  text: string;
  color: string;
}

export interface Fx {
  step(dt: number): void;
  burst(x: number, y: number, n: number, color: string, spd?: number, size?: number): void;
  ring(x: number, y: number, color: string, r: number): void;
  floatNum(x: number, y: number, text: string, color: string): void;
  shake(amount: number): void;
  stop(secs: number): void;
  stopped(): number;
  shakeVec(): { x: number; y: number };
  particles: Particle[];
  rings: Ring[];
  nums: FloatNum[];
}

export function createFx(): Fx {
  const particles: Particle[] = [];
  const rings: Ring[] = [];
  const nums: FloatNum[] = [];
  let shakeAmt = 0;
  let hitStop = 0;
  let sx = 0;
  let sy = 0;

  return {
    particles,
    rings,
    nums,
    step(dt) {
      if (hitStop > 0) hitStop = Math.max(0, hitStop - dt);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.92;
        p.vy *= 0.92;
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        rings[i].t += dt;
        if (rings[i].t >= rings[i].max) rings.splice(i, 1);
      }
      for (let i = nums.length - 1; i >= 0; i--) {
        nums[i].t += dt;
        nums[i].y -= 26 * dt;
        if (nums[i].t >= 0.8) nums.splice(i, 1);
      }
      shakeAmt *= Math.pow(0.001, dt);
      if (shakeAmt < 0.2) shakeAmt = 0;
      const a = reduce ? 0 : shakeAmt;
      sx = (Math.random() * 2 - 1) * a;
      sy = (Math.random() * 2 - 1) * a;
    },
    burst(x, y, n, color, spd = 140, size = 3) {
      const count = reduce ? Math.ceil(n * 0.4) : n;
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = spd * (0.3 + Math.random() * 0.7);
        particles.push({
          x,
          y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          life: 0.3 + Math.random() * 0.4,
          max: 0.7,
          color,
          size: size * (0.6 + Math.random() * 0.8),
        });
      }
    },
    ring(x, y, color, r) {
      rings.push({ x, y, t: 0, max: 0.5, color, r });
    },
    floatNum(x, y, text, color) {
      if (reduce && nums.length > 6) return;
      nums.push({ x, y, t: 0, text, color });
    },
    shake(amount) {
      if (reduce) return;
      shakeAmt = Math.min(28, shakeAmt + amount);
    },
    stop(secs) {
      hitStop = Math.max(hitStop, secs);
    },
    stopped: () => hitStop,
    shakeVec: () => ({ x: sx, y: sy }),
  };
}
