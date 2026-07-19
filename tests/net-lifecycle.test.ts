/**
 * net-lifecycle.test.ts — the tripwire.
 *
 * One invariant, asserted directly: a multiplayer session joins its room ONCE.
 * Every round after the first happens inside that room (see the engine's
 * rematch.ts, now consumed as @ben-gy/game-engine/rematch).
 *
 * This is the test that would have caught the shipped bug. It needs no relay, no
 * timing model and no browser — it just refuses to let the leave/rejoin pattern
 * exist. trystero-rejoin.test.ts documents WHY that pattern is fatal (against
 * the real library); this one makes it unreachable, so Trystero is stubbed here.
 *
 * Its triviality is the point. Do not "improve" it into something clever — a
 * clever version of this test is a version that can go green while the room is
 * a corpse.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/** A Trystero stand-in: enough surface for net.ts, with hand-drivable channels. */
const rooms: TestRoom[] = [];

interface TestRoom {
  id: string;
  left: boolean;
  /** channel name -> the single receiver net.ts registers with makeAction. */
  receivers: Map<string, (data: unknown, from: string) => void>;
  sent: { name: string; data: unknown; to?: string | string[] }[];
  /** Simulate an inbound message from a peer. */
  deliver(name: string, data: unknown, from: string): void;
}

vi.mock('trystero', () => ({
  selfId: 'self-id',
  joinRoom: (config: { appId: string }, roomId: string) => {
    const room: TestRoom = {
      id: `${config.appId}/${roomId}`,
      left: false,
      receivers: new Map(),
      sent: [],
      deliver(name, data, from) {
        this.receivers.get(name)?.(data, from);
      },
    };
    rooms.push(room);
    return {
      getPeers: () => ({}),
      onPeerJoin: () => {},
      onPeerLeave: () => {},
      makeAction: (name: string) => [
        (data: unknown, to?: string | string[]) => room.sent.push({ name, data, to }),
        (cb: (data: unknown, from: string) => void) => room.receivers.set(name, cb),
      ],
      // Mirrors the real thing: async, and settles later than the current tick.
      leave: async () => {
        await new Promise((res) => setTimeout(res, 5));
        room.left = true;
      },
    };
  },
}));

const { createNet, netStats, resetNetStats } = await import('@ben-gy/game-engine/net');

const APP = 'delvepack-lifecycle';

beforeEach(() => {
  rooms.length = 0;
  resetNetStats();
});

describe('createNet — one join per session', () => {
  it('counts a single join for a room', async () => {
    const net = createNet({ appId: APP, roomId: 'ONE' });
    expect(netStats().joins).toBe(1);
    expect(netStats().active).toEqual([`${APP}/ONE`]);
    await net.leave();
    expect(netStats().active).toEqual([]);
  });

  it('stays at joins === 1 for a whole multi-round session', async () => {
    // The invariant in its plainest form: however many rounds of Delvepack get
    // played, the room was joined exactly once and is still the same room.
    const net = createNet({ appId: APP, roomId: 'SESSION' });
    for (let round = 0; round < 5; round++) {
      // A round starting/ending touches channels, never the room.
      net.channel('in', () => {});
      expect(netStats().joins).toBe(1);
    }
    expect(rooms).toHaveLength(1);
    await net.leave();
  });

  it('REJECTS the rematch trap: leave() then rejoin in the same tick', async () => {
    const net = createNet({ appId: APP, roomId: 'TRAP' });

    // Precisely what a naive results screen does:
    //   leaveRoom();                 // net.leave(), not awaited
    //   createNet({ appId, roomId }) // same tick
    // Trystero would hand back the dying room and both peers would end up alone,
    // each elected host. Now it throws at the call site instead of going quiet.
    const leaving = net.leave();
    expect(() => createNet({ appId: APP, roomId: 'TRAP' })).toThrow(/still tearing down/);

    await leaving;
    // And crucially: no second room was ever constructed.
    expect(rooms).toHaveLength(1);
    expect(netStats().joins).toBe(1);
  });

  it('rejects a second Net for a room that is already joined', async () => {
    const net = createNet({ appId: APP, roomId: 'DUP' });
    expect(() => createNet({ appId: APP, roomId: 'DUP' })).toThrow(/already joined/);
    await net.leave();
  });

  it('allows a genuine rejoin once leave() has been awaited', async () => {
    const first = createNet({ appId: APP, roomId: 'BACK' });
    await first.leave();

    // Leaving to the menu and later coming back is legitimate — the rule is only
    // that the teardown must finish first.
    const second = createNet({ appId: APP, roomId: 'BACK' });
    expect(netStats().joins).toBe(2);
    expect(rooms).toHaveLength(2);
    await second.leave();
  });

  it('keeps rooms independent', async () => {
    const a = createNet({ appId: APP, roomId: 'AAAA' });
    const b = createNet({ appId: APP, roomId: 'BBBB' });
    expect(netStats().active.sort()).toEqual([`${APP}/AAAA`, `${APP}/BBBB`]);
    await a.leave();
    await b.leave();
  });
});

describe('createNet — channel fan-out', () => {
  it('delivers to EVERY receiver on a name, not just the first', async () => {
    const net = createNet({ appId: APP, roomId: 'FAN' });
    const seen: string[] = [];

    // The old channel() memoized on name and silently dropped the second
    // receiver, so a rematch mounted on a live Net was permanently deaf. Both
    // must fire.
    net.channel<string>('t', (d) => seen.push(`one:${d}`));
    net.channel<string>('t', (d) => seen.push(`two:${d}`));

    rooms[0].deliver('t', 'hi', 'peer-1');
    expect(seen).toEqual(['one:hi', 'two:hi']);

    await net.leave();
  });

  it('off() detaches one receiver and leaves the others attached', async () => {
    const net = createNet({ appId: APP, roomId: 'OFF' });
    const seen: string[] = [];
    const a = net.channel<string>('t', (d) => seen.push(`a:${d}`));
    net.channel<string>('t', (d) => seen.push(`b:${d}`));

    a.off();
    rooms[0].deliver('t', 'x', 'peer-1');

    expect(seen).toEqual(['b:x']);
    await net.leave();
  });

  it('shares one sender across receivers on the same name', async () => {
    const net = createNet({ appId: APP, roomId: 'SEND' });
    const send = net.channel<string>('t', () => {});
    send('ping');
    expect(rooms[0].sent).toContainEqual({ name: 't', data: 'ping', to: undefined });
    await net.leave();
  });

  it("still refuses channel names over Trystero's 12-byte limit", async () => {
    const net = createNet({ appId: APP, roomId: 'LONG' });
    expect(() => net.channel('thisnameiswaytoolong', () => {})).toThrow(/12 bytes/);
    await net.leave();
  });

  it('keeps the rematch protocol on exactly four reserved names', () => {
    // net.channel() fans out, so a game channel colliding with rematch.ts's
    // reserved names would feed every message to both subsystems.
    //
    // We read the reserved set straight out of the engine's rematch.ts rather
    // than restating it, so a channel added upstream turns this red instead of
    // silently colliding. Engine v1.1.0 added 'rk' — the start ACK that lets the
    // host re-broadcast to a peer whose data channel opened late, which is the
    // fix for players being "ejected" the moment a round began.
    const src = readFileSync(
      'node_modules/@ben-gy/game-engine/src/rematch.ts',
      'utf8',
    );
    const reserved = [...src.matchAll(/net\.channel<[^>]*>\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(reserved.sort()).toEqual(['rk', 'rq', 'rs', 'rv']);
    for (const c of reserved) expect(c.length).toBeLessThanOrEqual(12);
    // And the game must not itself claim any of them.
    const game = readFileSync('src/net-game.ts', 'utf8');
    for (const c of reserved) {
      expect(game, `net-game.ts collides with reserved channel '${c}'`).not.toMatch(
        new RegExp(`channel<[^>]*>\\(\\s*'${c}'`),
      );
    }
  });
});
