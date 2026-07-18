/**
 * takeover.test.ts — CONTRACT GATE: the host leaving must not freeze the run.
 *
 * The automated half of the gate (the other half is closing the host tab in a
 * two-tab smoke test). It exists because rhythm-relay shipped with host transfer
 * impossible-by-construction — createNet with no onHostChange — and every test was
 * green.
 *
 * `createSession` takes an optional `net`, so the whole thing runs with no relay
 * and no browser. Promotion is `setHost(true)`, exactly what net.ts's onHostChange
 * calls. Delvepack is host-authoritative (guests do not simulate monsters at all),
 * so the properties differ slightly from a predict-everything game:
 *
 *   before promotion — a guest does NOT drive the shared world: monsters do not
 *     move, the run cannot end. It defers entirely to the host's snapshot. That
 *     freeze is EXACTLY why the host leaving must promote someone.
 *   after promotion  — the survivor recomputes the derived combat stats the wire
 *     never carried (rebuildStats / rehydrateEnemies), runs the sim, BROADCASTS
 *     it, and the run can still reach game-over — never a frozen arena.
 */

import { describe, expect, it, vi } from 'vitest';
import { createSession, type SessionSeat } from '../src/net-game';
import { Game, type HeroSpec } from '../src/game';
import { MODES } from '../src/modes';
import type { Net, PeerId } from '../src/engine/net';

/** A Net connected to nothing — the situation one ms after the host tab closes. */
function silentNet(selfId: PeerId, host: PeerId | null, sent?: Record<string, unknown[]>): Net {
  return {
    selfId,
    peers: () => [selfId],
    host: () => host,
    isHost: () => host === selfId,
    hostSettled: () => host !== null,
    count: () => 1,
    channel: <T>(name: string) => {
      const send = ((d: T) => {
        if (sent) (sent[name] ??= []).push(d);
      }) as ((d: T, to?: PeerId | PeerId[]) => void) & { off: () => void };
      send.off = () => {};
      return send;
    },
    ping: async () => 0,
    leave: async () => {},
  };
}

const heroes = (n: number): HeroSpec[] =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i}`, bot: false }));
const sseats = (ids: string[]): SessionSeat[] => ids.map((id) => ({ id, bot: false }));

/** A single-delver room, so a wipe is reachable (a lone downed delver = wipe;
 *  two idle delvers standing together would just revive each other forever). */
function mk(isHost: boolean) {
  const mode = MODES.crypt; // tight arena, fast to overwhelm an idle delver
  const g = new Game({ seed: 5, mode, heroes: heroes(1) });
  g.populate();
  const onEnd = vi.fn();
  const onHostChange = vi.fn();
  const sent: Record<string, unknown[]> = {};
  const s = createSession({
    game: g,
    me: 0,
    seats: sseats(['me']),
    net: silentNet('me', isHost ? 'me' : 'other', sent),
    host: isHost,
    onEnd,
    onHostChange,
  });
  return { g, s, onEnd, onHostChange, mode, sent };
}

/** Drive `secs` of wall clock through the session, as rAF + the HUD timer would. */
function pump(s: { pump: (n: number) => void }, from: number, secs: number, stepMs = 16): number {
  let t = from;
  const end = from + secs * 1000;
  while (t < end) {
    s.pump(t);
    t += stepMs;
  }
  s.pump(t);
  return t;
}

describe('before promotion, a guest does not drive the shared world', () => {
  it('does not move the monsters — they are the host s to narrate', () => {
    const { g, s } = mk(false);
    const e = g.enemies[0];
    const at = { x: e.x, y: e.y };
    pump(s, 1000, 3);
    expect(e.x).toBe(at.x);
    expect(e.y).toBe(at.y);
  });

  it('does not end the run on its own — it waits to be told (this is why transfer must happen)', () => {
    const { g, s, onEnd } = mk(false);
    pump(s, 1000, 6);
    expect(g.over).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('never narrates the world — a guest must not send snapshots', () => {
    const { s, sent } = mk(false);
    pump(s, 1000, 3);
    expect(sent.w ?? []).toHaveLength(0);
  });
});

describe('after promotion, the survivor takes over and the run can finish', () => {
  it('setHost(true) makes it host', () => {
    const { s, onHostChange } = mk(false);
    expect(s.isHost()).toBe(false);
    s.setHost(true);
    expect(s.isHost()).toBe(true);
    expect(onHostChange).toHaveBeenCalledWith(true);
  });

  it('starts moving the monsters the moment it is promoted', () => {
    const { g, s } = mk(false);
    pump(s, 1000, 1);
    const e = g.enemies[0];
    const before = { x: e.x, y: e.y };
    s.setHost(true);
    pump(s, 2000, 2);
    const moved = g.enemies.some((en) => en.id === e.id && (en.x !== before.x || en.y !== before.y));
    // Either the tracked monster moved, or it already reached and was resolved —
    // both prove the sim is running.
    expect(moved || !g.enemies.some((en) => en.id === e.id)).toBe(true);
  });

  it('starts BROADCASTING the world — the duty that actually transfers', () => {
    // Verified by mutation: make setHost a no-op and this goes red. "The run still
    // ends" does NOT catch a broken takeover on its own, so the broadcast is the
    // load-bearing assertion.
    const { s, sent } = mk(false);
    pump(s, 1000, 2);
    expect(sent.w ?? [], 'a guest must never narrate').toHaveLength(0);
    s.setHost(true);
    pump(s, 3000, 2);
    expect((sent.w ?? []).length, 'a promoted host must broadcast').toBeGreaterThan(0);
  });

  it('the run can still REACH game-over after the host vanishes', () => {
    const { g, s, onEnd } = mk(false);
    pump(s, 1000, 4);
    expect(g.over).toBe(false);
    s.setHost(true);
    // An idle, promoted survivor is swarmed and the run ends — never a frozen arena.
    pump(s, 5000, 40);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('recomputes the combat stats the wire never carried', () => {
    // A snapshot-derived monster has speed/damage 0 on a guest. Promotion must
    // rehydrate them or the "sim" would be a frozen tableau.
    const { g, s } = mk(false);
    // Simulate the guest state: monsters known but inert (as after applySnapshot).
    for (const e of g.enemies) {
      e.spd = 0;
      e.dmg = 0;
    }
    s.setHost(true);
    expect(g.enemies.every((e) => e.spd > 0)).toBe(true);
  });

  it('demotion is honoured too — two hosts must never both narrate', () => {
    const { s, onHostChange } = mk(true);
    expect(s.isHost()).toBe(true);
    s.setHost(false);
    expect(s.isHost()).toBe(false);
    expect(onHostChange).toHaveBeenCalledWith(false);
  });

  it('setHost is idempotent — a repeated announce changes nothing', () => {
    const { s, onHostChange } = mk(false);
    s.setHost(true);
    s.setHost(true);
    s.setHost(true);
    expect(onHostChange).toHaveBeenCalledTimes(1);
  });
});

describe('a peer leaving degrades, never freezes', () => {
  it("dissolves the leaver's delver and can wipe the party if it was the last up", () => {
    const mode = MODES.crypt;
    const g = new Game({ seed: 5, mode, heroes: heroes(2) });
    g.populate();
    const s = createSession({
      game: g,
      me: 0,
      seats: sseats(['me', 'them']),
      net: silentNet('me', 'me', {}),
      host: true,
      onEnd: vi.fn(),
    });
    // Down the local delver; the room is now carried by 'them' alone.
    g.heroes[0].downed = true;
    s.onPeerLeave('them');
    expect(g.heroes[1].left).toBe(true);
    // Nobody is up — the run ends rather than freezing on a dead party.
    expect(g.over).toBe(true);
  });

  it('ignores a leave from someone who was never seated', () => {
    const { g, s } = mk(true);
    const before = g.heroes.map((h) => h.left);
    s.onPeerLeave('a-stranger');
    expect(g.heroes.map((h) => h.left)).toEqual(before);
  });
});

describe('solo is the same code path', () => {
  it('runs with no net at all and can reach game-over', () => {
    const mode = MODES.crypt;
    const g = new Game({ seed: 9, mode, heroes: heroes(1) });
    g.populate();
    const onEnd = vi.fn();
    const s = createSession({ game: g, me: 0, seats: sseats(['me']), onEnd });
    expect(s.isHost()).toBe(true);
    pump(s, 0, 40);
    expect(g.over).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
    // …and it was a real fight, not an empty room.
    expect(g.heroes[0].st.dmg).toBeGreaterThan(0);
  });

  it('the local delver can act, and its bolts hurt the monsters', () => {
    const mode = MODES.delve;
    const g = new Game({ seed: 9, mode, heroes: heroes(1) });
    g.populate();
    const s = createSession({ game: g, me: 0, seats: sseats(['me']), onEnd: vi.fn() });
    s.intent(1, 0, false, false);
    pump(s, 0, 2);
    expect(g.heroes[0].ax).toBeCloseTo(1, 3);
    expect(g.heroes[0].st.dmg).toBeGreaterThan(0);
  });
});
