// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * net-game.ts — one Session drives a run, solo or peer-to-peer.
 *
 * ONE path, deliberately. rhythm-relay shipped broken because its co-op shape got
 * bespoke netcode that never had host transfer wired in. So solo here is simply "a
 * Session whose net is undefined" — the same code, so it cannot drift away from
 * the multiplayer one.
 *
 * ── who owns what ─────────────────────────────────────────────────────────────
 *
 *   EVERY PEER owns its own delver's MOTION. It runs `stepSelf(me)` locally for a
 *     responsive dodge, and broadcasts its pose on 'p'. That is the only thing a
 *     guest simulates.
 *
 *   THE HOST owns the whole shared world — monsters, bolts, every delver's HP and
 *     downed/dead state, the floor lifecycle, the rune, loot. It runs
 *     `stepWorld()` and broadcasts a full snapshot on 'w'; guests adopt it.
 *
 * Co-op makes host authority over HP acceptable in a way a versus game could not:
 * you are downed, not eliminated, so a hit you take to another machine's latency
 * costs a sliver of a shared bar, not your game. The dash i-frame still protects
 * you within one hop, because your pose carries the dash flag.
 *
 * ── host transfer ─────────────────────────────────────────────────────────────
 *
 * A snapshot fully describes the world, so a promoted guest already holds a live
 * dungeon. `setHost(true)` recomputes the derived combat stats the wire never
 * carried (pure functions of floor + upgrades — see game.rebuildStats /
 * rehydrateEnemies) and starts running + broadcasting. The run keeps going and can
 * still reach game-over. Proven by tests/takeover.test.ts and the two-tab smoke
 * test (close the host tab).
 */

import { Game } from './game';
import type { Net, PeerId } from '@ben-gy/game-engine/net';

/** Host -> all: the whole world. */
type WorldMsg = ReturnType<Game['snapshot']>;

/** Peer -> host: where my delver is. */
interface PoseMsg {
  i: number;
  x: number;
  y: number;
  /** Dashing this instant — the host grants i-frames without waiting for 'w'. */
  d?: 1;
}

export interface SessionSeat {
  /** Peer id for a human seat; undefined for a sim-only seat. */
  id?: PeerId;
  bot: boolean;
}

export interface SessionCfg {
  game: Game;
  /** The local delver's seat, or -1 for a spectator (late joiner). */
  me: number;
  seats: SessionSeat[];
  /** Absent = solo. */
  net?: Net;
  /** True if this peer starts the run as host. Ignored when solo. */
  host?: boolean;
  onEnd: () => void;
  onHostChange?: (isHost: boolean) => void;
}

export interface Session {
  pump(nowMs: number): void;
  intent(ax: number, ay: number, dash: boolean, reviving: boolean): void;
  setHost(isHost: boolean): void;
  onPeerLeave(id: PeerId): void;
  isHost(): boolean;
  destroy(): void;
}

const W_HZ = 16;
const P_HZ = 18;
const MAX_STEP = 1 / 60;
const MAX_CATCHUP = 8;

export function createSession(cfg: SessionCfg): Session {
  const { game: g, me, seats, net } = cfg;
  let host = net ? !!cfg.host : true;

  const seatOf = new Map<PeerId, number>();
  for (const [i, s] of seats.entries()) if (s.id) seatOf.set(s.id, i);

  let started = 0;
  let last = 0;
  let acc = 0;
  let wAcc = 0;
  let pAcc = 0;
  let ended = false;
  let ax = 0;
  let ay = 0;
  let dash = false;
  let reviving = false;

  const sendW = net?.channel<WorldMsg>('w', (msg, from) => {
    // Only the elected host may narrate the world.
    if (host || from !== net.host()) return;
    g.applySnapshot(msg, me);
    if (g.over && !ended) {
      ended = true;
      cfg.onEnd();
    }
  });

  const sendP = net?.channel<PoseMsg>('p', (msg, from) => {
    const i = seatOf.get(from);
    // A peer may only move its OWN delver, and never the local one.
    if (i == null || i !== msg.i || i === me) return;
    const h = g.heroes[i];
    if (!h) return;
    h.x = msg.x;
    h.y = msg.y;
    if (msg.d) g.setDashing(i);
  });

  return {
    pump(nowMs) {
      if (ended) return;
      if (!started) {
        started = nowMs;
        last = nowMs;
        if (net && host) broadcast();
        return;
      }
      const dt = Math.min(0.1, (nowMs - last) / 1000);
      last = nowMs;

      acc += dt;
      let steps = 0;
      while (acc >= MAX_STEP && steps < MAX_CATCHUP) {
        if (me >= 0) {
          g.setIntent(me, ax, ay, dash, reviving);
          dash = false;
          g.stepSelf(me, MAX_STEP);
        }
        if (host) {
          // Decay i-frames/flags of the delvers this peer does not step itself,
          // so a guest who stops sending its dash flag is not invulnerable forever.
          for (let i = 0; i < seats.length; i++) if (i !== me) g.decayRemote(i, MAX_STEP);
          g.stepWorld(MAX_STEP);
        }
        acc -= MAX_STEP;
        steps++;
      }
      if (steps >= MAX_CATCHUP) acc = 0;

      // ── talk ──────────────────────────────────────────────────────────────────
      if (net && me >= 0) {
        pAcc += dt;
        if (pAcc >= 1 / P_HZ) {
          pAcc = 0;
          const h = g.heroes[me];
          if (h) {
            const msg: PoseMsg = { i: me, x: Math.round(h.x), y: Math.round(h.y) };
            if (h.dashT > 0) msg.d = 1;
            sendP?.(msg);
          }
        }
      }
      if (net && host) {
        wAcc += dt;
        if (wAcc >= 1 / W_HZ) {
          wAcc = 0;
          broadcast();
        }
      }

      if (g.over && !ended) {
        ended = true;
        cfg.onEnd();
      }
    },

    intent(nx, ny, d, rev) {
      ax = nx;
      ay = ny;
      dash = dash || d;
      reviving = rev;
    },

    setHost(isHost) {
      if (isHost === host) return;
      host = isHost;
      if (host) {
        // THE TAKEOVER. This peer holds a full world from the last snapshot; it
        // just needs the derived combat stats the wire never carried, then it can
        // run and narrate. No reconstruction — pure functions of floor + upgrades.
        g.rebuildStats();
        g.rehydrateEnemies();
        acc = 0;
        broadcast();
      }
      cfg.onHostChange?.(host);
    },

    onPeerLeave(id) {
      const i = seatOf.get(id);
      if (i == null) return;
      // Every peer does this locally: the run must degrade identically even if the
      // host is the one who vanished.
      g.dissolve(i);
    },

    isHost: () => host,

    destroy() {
      ended = true;
      (sendW as unknown as { off?: () => void })?.off?.();
      (sendP as unknown as { off?: () => void })?.off?.();
    },
  };

  function broadcast(): void {
    if (!net || !host) return;
    sendW?.(g.snapshot());
  }
}
