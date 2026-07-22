// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * gen-icons.mjs — rasterise the Delvepack mark into the PNGs a home-screen
 * install needs. Run with `npm run icons`; the output is committed under public/.
 *
 *   node scripts/gen-icons.mjs
 *
 * Why not sharp: the game ships one tiny runtime dependency and sharp is a 30MB
 * native binary we would install to draw four small squares. So this carries its
 * own SDF rasteriser for the primitives the mark is made of — thick strokes
 * (drawn as capsules) — and a PNG encoder on node's built-in zlib. ART below is
 * the same descending-chevron rune as favicon.svg, expressed as the shapes it is
 * made of, so the icons and the favicon cannot drift into two different logos.
 *
 * The four outputs are NOT interchangeable:
 *  - icon-192 / icon-512: the manifest's own icons. Rounded, "any" purpose.
 *  - icon-maskable-512: Android crops adaptive icons to a device-chosen shape.
 *    Full-bleed, art shrunk into the centre-80% safe zone, NOT rounded (the
 *    platform rounds it).
 *  - apple-touch-icon: iOS ignores the manifest and composites transparency onto
 *    BLACK. Full-bleed, fully opaque, no rounding (iOS masks).
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// The dungeon slate, and the three Okabe-Ito rune colours from favicon.svg.
const SLATE = '#0b0f1a';
const BLUE = '#56b4e9';
const GREEN = '#009e73';
const ORANGE = '#e69f00';

// ── the mark ──────────────────────────────────────────────────────────────────
// Three descending chevrons (a stair rune) — the whole game in one frame: going
// down. Each chevron is two thick capsules meeting at the point. Stroke width 5
// in the 64-unit space, matching favicon.svg.
const SW = 2.6; // capsule radius (favicon stroke 5.2 -> radius 2.6)
function chevron(y, fill) {
  return [
    { t: 'capsule', x1: 18, y1: y, x2: 32, y2: y + 10, r: SW, fill },
    { t: 'capsule', x1: 32, y1: y + 10, x2: 46, y2: y, r: SW, fill },
  ];
}
const ART = [...chevron(20, BLUE), ...chevron(32, GREEN), ...chevron(44, ORANGE)];

// ── colour ──────────────────────────────────────────────────────────────────
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ── geometry: signed distance, so every edge antialiases the same way ─────────
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to a line segment, minus r — a rounded "capsule" / thick stroke. */
function sdCapsule(px, py, x1, y1, x2, y2, r) {
  const pax = px - x1;
  const pay = py - y1;
  const bax = x2 - x1;
  const bay = y2 - y1;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

function sdOf(shape, px, py) {
  switch (shape.t) {
    case 'rect':
      return sdRoundRect(px, py, shape.x, shape.y, shape.w, shape.h, shape.r ?? 0);
    case 'circle':
      return Math.hypot(px - shape.cx, py - shape.cy) - shape.r;
    case 'capsule':
      return sdCapsule(px, py, shape.x1, shape.y1, shape.x2, shape.y2, shape.r);
    default:
      throw new Error(`unknown shape ${shape.t}`);
  }
}

// ── raster ────────────────────────────────────────────────────────────────────
const SS = 4; // 4x4 supersamples per pixel

function render(shapes, size, space) {
  const px = new Uint8Array(size * size * 4);
  const prepared = shapes.map((s) => ({ ...s, rgb: rgb(s.fill), alpha: s.alpha ?? 1 }));
  const scale = space / size;
  const step = 1 / SS;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) * step) * scale;
          const uy = (y + (sy + 0.5) * step) * scale;
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const s of prepared) {
            const cov = Math.max(0, Math.min(1, 0.5 - sdOf(s, ux, uy) / scale));
            if (cov <= 0) continue;
            const sa = cov * s.alpha;
            const na = sa + ca * (1 - sa);
            if (na <= 0) continue;
            cr = (s.rgb[0] * sa + cr * ca * (1 - sa)) / na;
            cg = (s.rgb[1] * sa + cg * ca * (1 - sa)) / na;
            cb = (s.rgb[2] * sa + cb * ca * (1 - sa)) / na;
            ca = na;
          }
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const aa = a / n;
      px[i] = aa > 0 ? Math.round(r / a) : 0;
      px[i + 1] = aa > 0 ? Math.round(g / a) : 0;
      px[i + 2] = aa > 0 ? Math.round(b / a) : 0;
      px[i + 3] = Math.round(aa * 255);
    }
  }
  return px;
}

// ── PNG ───────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the four icons ─────────────────────────────────────────────────────────────
function art(space, inset) {
  const k = (space / 64) * inset;
  const off = (space - 64 * k) / 2;
  const m = (v) => v * k + off;
  return ART.map((s) => ({
    ...s,
    x1: m(s.x1),
    y1: m(s.y1),
    x2: m(s.x2),
    y2: m(s.y2),
    r: s.r * k,
  }));
}

const rounded = (space) => [
  { t: 'rect', x: 0, y: 0, w: space, h: space, r: space * (14 / 64), fill: SLATE },
  ...art(space, 1),
];

const bleed = (space, inset) => [
  { t: 'rect', x: -2, y: -2, w: space + 4, h: space + 4, r: 0, fill: SLATE },
  ...art(space, inset),
];

const ICONS = [
  { file: 'icon-192.png', size: 192, shapes: rounded(64) },
  { file: 'icon-512.png', size: 512, shapes: rounded(64) },
  { file: 'icon-maskable-512.png', size: 512, shapes: bleed(64, 0.7) },
  { file: 'apple-touch-icon.png', size: 180, shapes: bleed(64, 0.88) },
];

mkdirSync(OUT, { recursive: true });
for (const { file, size, shapes } of ICONS) {
  const px = render(shapes, size, 64);
  if (file === 'apple-touch-icon.png') {
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] !== 255) throw new Error('apple-touch-icon has transparent pixels');
    }
  }
  writeFileSync(join(OUT, file), encodePng(px, size));
  console.log(`wrote public/${file} (${size}x${size})`);
}
