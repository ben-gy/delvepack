/**
 * rematch.test.ts — the multi-round protocol, driven with N simulated peers.
 *
 * What this covers and what it deliberately does not:
 *
 *  - COVERED: our round protocol. Votes, quorum, monotonic round numbers, the
 *    frozen roster, the host's mode travelling frozen, host handover mid-results.
 *    This is our logic and a fake bus exercises it honestly.
 *
 *  - NOT COVERED: the transport bug that started all this. A fake bus sits ABOVE
 *    Trystero's room cache, so it structurally cannot contain that defect and
 *    would happily go green while the real game was broken. Two other tests own
 *    that: trystero-rejoin.test.ts pins the Trystero behaviour itself, and
 *    net-lifecycle.test.ts asserts the "one join per session" invariant that
 *    makes the trap unreachable — no network model required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo } from '@ben-gy/game-engine/rematch';
import type { Net, PeerId } from '@ben-gy/game-engine/net';
import { MODES } from '../src/modes';

/** A shared in-memory bus. Message delivery is synchronous — we are testing
 *  protocol decisions, not transport timing. Roster changes are real events
 *  though: rematch.ts now defers an auto-start until the roster has held still
 *  (ROSTER_SETTLE_MS), so a bus that changed its membership silently would let
 *  every test freeze a roster mid-formation — the exact bug being fixed. */
class Bus {
  peers = new Map<PeerId, Map<string, Set<(d: unknown, from: PeerId) => void>>>();
  /** peer id -> its roster-change subscribers (net.onPeersChange fans out). */
  watchers = new Map<PeerId, Set<(peers: PeerId[]) => void>>();
  /** A deliberate takeover, if one happened: id plus the term it minted. */
  claimed: { id: PeerId; epoch: number } | null = null;

  join(id: PeerId): void {
    this.peers.set(id, new Map());
    this.watchers.set(id, new Set());
    this.announceRoster();
  }

  part(id: PeerId): void {
    this.peers.delete(id);
    this.watchers.delete(id);
    if (this.claimed?.id === id) this.claimed = null;
    this.announceRoster();
  }

  /** Tell everyone still in the room who is in it now. */
  announceRoster(): void {
    const roster = this.roster();
    for (const subs of this.watchers.values()) for (const cb of [...subs]) cb(roster);
  }

  watch(id: PeerId, cb: (peers: PeerId[]) => void): () => void {
    const subs = this.watchers.get(id)!;
    subs.add(cb);
    return () => subs.delete(cb);
  }

  /** Whoever holds the room: an explicit claim outranks the min-id default. */
  hostId(): PeerId | null {
    return this.claimed?.id ?? this.roster()[0] ?? null;
  }

  roster(): PeerId[] {
    return [...this.peers.keys()].sort();
  }

  send(from: PeerId, name: string, data: unknown, to?: PeerId | PeerId[]): void {
    const targets = to ? (Array.isArray(to) ? to : [to]) : this.roster().filter((p) => p !== from);
    for (const t of targets) {
      for (const h of this.peers.get(t)?.get(name) ?? []) h(data, from);
    }
  }

  on(id: PeerId, name: string, h: (d: unknown, from: PeerId) => void): () => void {
    const chans = this.peers.get(id)!;
    if (!chans.has(name)) chans.set(name, new Set());
    chans.get(name)!.add(h);
    return () => chans.get(name)!.delete(h);
  }
}

function mockNet(bus: Bus, selfId: PeerId): Net {
  bus.join(selfId);
  return {
    selfId,
    peers: () => bus.roster(),
    // Same election rule as the real net.ts: an explicit claim if there is one,
    // otherwise the lexicographically smallest id.
    host: () => bus.hostId(),
    isHost: () => bus.hostId() === selfId,
    // These peers are all wired to each other from the first tick; net.ts's
    // settling window is its own business and host-election.test.ts owns it.
    hostSettled: () => true,
    // One term, held by whoever holds the room, advanced only by a takeover.
    hostEpoch: () => bus.claimed?.epoch ?? 1,
    count: () => bus.roster().length,
    onPeersChange(cb) {
      return bus.watch(selfId, cb);
    },
    channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
      const off = bus.on(selfId, name, onReceive as (d: unknown, from: PeerId) => void);
      const send = ((data: T, to?: PeerId | PeerId[]) => bus.send(selfId, name, data, to)) as ((
        data: T,
        to?: PeerId | PeerId[],
      ) => void) & { off: () => void };
      send.off = off;
      return send;
    },
    ping: async () => 0,
    takeover() {
      bus.claimed = { id: selfId, epoch: (bus.claimed?.epoch ?? 1) + 1 };
    },
    netDiag: () => ({
      selfId,
      host: bus.hostId(),
      epoch: bus.claimed?.epoch ?? 1,
      settled: true,
      peers: bus.roster(),
      relaySockets: {},
      turn: false,
    }),
    leave: async () => bus.part(selfId),
  };
}

/** Morsel's round opts are `{ mode: <mode id> }`. RoundInfo.opts is generic and
 *  unknown by design, so unwrap it here rather than in every assertion. */
const modeOf = (i: RoundInfo): string | undefined => (i.opts as { mode?: string } | undefined)?.mode;

interface Seat {
  id: PeerId;
  net: Net;
  rounds: ReturnType<typeof createRounds>;
  got: RoundInfo[];
}

/**
 * Let the roster go quiet.
 *
 * rematch.ts refuses to freeze a roster that changed within the last
 * ROSTER_SETTLE_MS (4s) and re-attempts on its 1.5s resync poll, so 6s covers
 * the window plus the next tick. Every join AND every leave re-arms it. That
 * deferral is the fix for players being "ejected" the instant a round began —
 * the host used to freeze a roster from a half-formed mesh, and whoever was one
 * handshake behind was simply not in the game. So calling this is not a test
 * workaround: a room that starts without it is a room mid-formation.
 */
const settle = (): void => {
  vi.advanceTimersByTime(6000);
};

function table(
  ids: PeerId[],
  opts: { minPlayers?: number; modes?: Record<string, string> } = {},
): Seat[] {
  const bus = new Bus();
  const seated = ids.map((id) => {
    const net = mockNet(bus, id);
    const seat: Seat = { id, net, rounds: null as never, got: [] };
    seat.rounds = createRounds({
      net,
      playerName: id.toUpperCase(),
      minPlayers: opts.minPlayers ?? 2,
      // Each peer reports the mode ITS OWN menu is set to. Only the host's may
      // ever reach the dish — that is the whole point of roundOpts.
      roundOpts: opts.modes ? () => ({ mode: opts.modes![id] }) : undefined,
      onRound: (info) => seat.got.push(info),
    });
    return seat;
  });
  // The mesh has formed and held still. Everything after this is a lobby whose
  // roster is trustworthy, which is what the rest of these cases are about.
  settle();
  return seated;
}

let seats: Seat[];
beforeEach(() => {
  seats = [];
  // The roster settle window and the grace countdown are both real timers now,
  // so every case in this file drives the clock rather than assuming zero.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRounds — starting a round', () => {
  it('starts once every peer has voted, with one host and an identical seed', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());

    // Auto-start fires when the last voter arrives; nobody had to press Start.
    expect(seats.map((s) => s.got.length)).toEqual([1, 1]);
    expect(seats[0].got[0].seed).toBe(seats[1].got[0].seed);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
    expect(seats[0].got[0].round).toBe(1);
  });

  it('freezes ONE roster into the start, so player indices match on every peer', () => {
    // Morsel seats blobs on a ring in roster order and seat i is a pure rotation
    // of seat 0 — two peers disagreeing about who is seat 0 is two peers driving
    // each other's blob.
    seats = table(['b', 'a', 'c'], { minPlayers: 3 });
    seats.forEach((s) => s.rounds.vote());

    const rosters = seats.map((s) => s.got[0].players.map((p) => `${p.id}:${p.name}`));
    expect(rosters[0]).toEqual(rosters[1]);
    expect(rosters[1]).toEqual(rosters[2]);
    expect(rosters[0]).toEqual(['a:A', 'b:B', 'c:C']);
  });

  it('waits below quorum', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 3 });
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats.every((s) => s.got.length === 0)).toBe(true);

    seats[2].rounds.vote();
    expect(seats.every((s) => s.got.length === 1)).toBe(true);
  });

  it('fills a full 4-player table with one seed and one roster', () => {
    seats = table(['a', 'b', 'c', 'd'], { minPlayers: 4 });
    seats.forEach((s) => s.rounds.vote());

    expect(seats.map((s) => s.got.length)).toEqual([1, 1, 1, 1]);
    const seeds = new Set(seats.map((s) => s.got[0].seed));
    expect(seeds.size).toBe(1);
    for (const s of seats) expect(s.got[0].players.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(seats.filter((s) => s.got[0].isHost)).toHaveLength(1);
  });

  it('lets the host start early with go(), leaving a non-voter out of the roster', () => {
    seats = table(['a', 'b', 'c']);
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(0); // c has not voted — no auto-start

    seats[0].rounds.go(); // host forces it
    expect(seats[0].got[0].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('ignores a start from a peer that is not the host', () => {
    seats = table(['a', 'b']);
    // 'b' is not the host; forge a start and make sure nobody honours it.
    seats[1].net.channel('rs', () => {})({
      round: 1,
      seed: 42,
      roster: [{ id: 'b', name: 'B' }],
    } as never);
    expect(seats.every((s) => s.got.length === 0)).toBe(true);
  });
});

describe("createRounds — the host's mode travels frozen", () => {
  it("gives every peer the HOST's mode, not the one their own menu is set to", () => {
    // The guest is sitting on Crypt. It must play the host's Delve, because a mode
    // decides the ARENA SIZE and the monster budget: if the guest believed its own
    // menu it would generate a 700-wide chamber off the same seed as the host's
    // 920-wide hall, and the two would be walking different dungeons.
    seats = table(['a', 'b'], { modes: { a: 'delve', b: 'crypt' } });
    seats.forEach((s) => s.rounds.vote());

    expect(seats[0].net.isHost()).toBe(true);
    for (const s of seats) expect(modeOf(s.got[0])).toBe('delve');
    // …and it resolves to a real mode on both sides, not a fallback.
    for (const s of seats) expect(MODES[modeOf(s.got[0])!].arenaW).toBe(920);
  });

  it('follows the mode when the HOST is the one on Crypt', () => {
    seats = table(['a', 'b'], { modes: { a: 'crypt', b: 'delve' } });
    seats.forEach((s) => s.rounds.vote());
    for (const s of seats) expect(modeOf(s.got[0])).toBe('crypt');
    expect(MODES.crypt.arenaW).toBe(700); // the difference that matters
  });

  it('carries the mode into every rematch, not just the first round', () => {
    seats = table(['a', 'b'], { modes: { a: 'warren', b: 'crypt' } });
    seats.forEach((s) => s.rounds.vote());
    seats.forEach((s) => s.rounds.finish());
    settle(); // finish() re-arms the settle window so a rematch never inherits a stale one
    seats.forEach((s) => s.rounds.vote());

    for (const s of seats) expect(modeOf(s.got[1])).toBe('warren');
  });

  it('re-reads the host mode each round, so a change takes effect', () => {
    const bus = new Bus();
    let hostMode = 'warren';
    const net = mockNet(bus, 'a');
    const guest = mockNet(bus, 'b');
    const got: RoundInfo[] = [];
    const host = createRounds({
      net,
      playerName: 'A',
      roundOpts: () => ({ mode: hostMode }),
      onRound: (i) => got.push(i),
    });
    const other = createRounds({ net: guest, playerName: 'B', onRound: () => {} });
    settle();

    host.vote();
    other.vote();
    expect(modeOf(got[0])).toBe('warren');

    host.finish();
    other.finish();
    settle();
    hostMode = 'crypt'; // the host changed its mind at the results screen
    host.vote();
    other.vote();
    expect(modeOf(got[1])).toBe('crypt');
  });

  it("gossips the host's mode into every peer's state, before any round starts", () => {
    // A lobby must be able to render what it is about to play. Showing the
    // guest's OWN menu selection as if it were the host's is a confident lie.
    seats = table(['a', 'b'], { modes: { a: 'crypt', b: 'delve' } });
    for (const s of seats) expect(s.rounds.state().hostOpts).toEqual({ mode: 'crypt' });
  });

  it('hands back an undefined opts when a game does not use them', () => {
    // rematch.ts is engine code shared across games; a game with no settings
    // must not have to know that roundOpts exists.
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    expect(seats[0].got[0].opts).toBeUndefined();
    expect(seats[1].got[0].opts).toBeUndefined();
  });
});

describe('createRounds — the rematch (the bug this all exists for)', () => {
  it('runs a second round in the SAME room, both peers together, one host', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    seats.forEach((s) => s.rounds.finish());
    settle(); // finish() re-arms the settle window so a rematch never inherits a stale one

    // Both players hit "Play again" — the exact sequence the user reported.
    seats.forEach((s) => s.rounds.vote());

    expect(seats.map((s) => s.got.length)).toEqual([2, 2]);
    expect(seats[0].got[1].round).toBe(2);
    expect(seats[0].got[1].seed).toBe(seats[1].got[1].seed);
    // The symptom was TWO hosts. There must be exactly one, every round.
    expect(seats.filter((s) => s.got[1].isHost)).toHaveLength(1);
    // …and a fresh dish, not a replay of round 1.
    expect(seats[0].got[1].seed).not.toBe(seats[0].got[0].seed);
  });

  it('lets a peer that LEFT and rejoined mid-match ready up again', () => {
    // The soft-deadlock found in Morsel's live two-tab smoke test. Sequence: the
    // host leaves, the guest is promoted, and then the peer who left reopens the
    // link to rejoin. The rejoiner's rounds instance is brand new — round 0 —
    // while the incumbent is already a round or two in. Before the fix, the
    // rejoiner's votes were "for" a round the room had finished, silently
    // dropped, and it could never reach quorum however many times it readied up.
    //
    // Rebuilt on the shared bus: 'a' and 'b' play round 1 together; then 'b'
    // leaves and a FRESH 'b' (new createRounds, round 0) rejoins. 'a' stays host
    // (a < b) at round 1. The rejoiner must catch up to the host's timeline and
    // a rematch must start.
    const bus = new Bus();
    const mk = (id: PeerId) => {
      const net = mockNet(bus, id);
      const seat: Seat = { id, net, rounds: null as never, got: [] };
      seat.rounds = createRounds({
        net,
        playerName: id.toUpperCase(),
        minPlayers: 2,
        onRound: (info) => seat.got.push(info),
      });
      return seat;
    };

    const a = mk('a');
    let b = mk('b');
    settle();
    a.rounds.vote();
    b.rounds.vote();
    expect(a.got[0].round).toBe(1); // round 1 played by both

    // 'b' closes the tab: detach its receivers and drop it from the room.
    b.rounds.destroy();
    void b.net.leave();

    a.rounds.finish(); // 'a' (host) returns to its results screen, reopens voting

    // A brand-new 'b' rejoins from scratch — round 0.
    b = mk('b');
    settle(); // …and the room is whole again before anyone starts anything

    // Both hit Play again. Without the catch-up this hangs: 'b' votes for round 1,
    // 'a' expects round 2, the votes never meet.
    a.rounds.vote();
    b.rounds.vote();

    expect(b.got.length, 'the rejoiner reached a new round').toBe(1);
    expect(a.got.length).toBe(2);
    expect(a.got[1].round).toBe(2);
    expect(b.got[0].round).toBe(2);
    expect(a.got[1].seed).toBe(b.got[0].seed);
    expect([a, b].filter((s) => s.got[s.got.length - 1].isHost)).toHaveLength(1);
  });

  it("keeps both peers in each other's roster across the rematch", () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    seats.forEach((s) => s.rounds.finish());
    settle(); // finish() re-arms the settle window so a rematch never inherits a stale one
    seats.forEach((s) => s.rounds.vote());

    // "Neither can see each other" — assert the opposite, directly.
    for (const s of seats) {
      expect(s.got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
      expect(s.net.count()).toBe(2);
    }
  });

  it('ignores a stale or duplicated start rather than restarting a live round', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote());
    const seed = seats[0].got[0].seed;

    // Replay round 1's start — e.g. a duplicate delivery, or both peers pressing
    // at the same instant. The monotonic guard must swallow it.
    seats[0].net.channel('rs', () => {})({
      round: 1,
      seed: 999,
      roster: [{ id: 'a', name: 'A' }],
    } as never);
    expect(seats[1].got.length).toBe(1);
    expect(seats[1].got[0].seed).toBe(seed);
  });

  it('does not start a rematch while a round is still being played', () => {
    seats = table(['a', 'b']);
    seats.forEach((s) => s.rounds.vote()); // round 1 playing; no finish()
    seats.forEach((s) => s.rounds.vote()); // premature "play again"
    expect(seats[0].got.length).toBe(1);
  });

  it('drops the vote of a peer who leaves, and still rematches the rest', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    seats.forEach((s) => s.rounds.finish());
    settle(); // finish() re-arms the settle window so a rematch never inherits a stale one

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(1); // still waiting on c

    seats[2].net.leave(); // c closes the tab
    settle(); // a departure re-arms the settle window too
    seats[0].rounds.vote(); // any nudge re-tallies

    // A departed peer must be dropped, not held for — and must not land in the
    // frozen roster as a seat nobody is driving.
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('createRounds — host handover', () => {
  it('promotes the next peer and still starts when the host leaves at results', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    seats.forEach((s) => s.rounds.finish());
    settle(); // finish() re-arms the settle window so a rematch never inherits a stale one
    expect(seats[0].net.isHost()).toBe(true);

    seats[0].net.leave(); // the host walks away between rounds
    expect(seats[1].net.isHost()).toBe(true); // b is promoted by min-id election
    settle(); // the promoted host waits for the roster to hold still, like any host

    seats[1].rounds.vote();
    seats[2].rounds.vote();

    // The promoted host must be able to run the rematch — inheriting no tally
    // from the old host is the classic way this deadlocks.
    expect(seats[1].got.length).toBe(2);
    expect(seats[1].got[1].players.map((p) => p.id)).toEqual(['b', 'c']);
    expect(seats[1].got[1].isHost).toBe(true);
    expect(seats[2].got[1].isHost).toBe(false);
    expect(seats[1].got[1].seed).toBe(seats[2].got[1].seed);
  });
});

describe('createRounds — never deadlock waiting for a vote that never comes', () => {
  it('starts anyway once the grace countdown expires, without the silent player', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    seats.forEach((s) => s.rounds.finish());
    settle(); // finish() re-arms the settle window so a rematch never inherits a stale one

    // Two of three hit "Play again". The third is still reading the scores —
    // which is the whole point of them, and takes a while. The OLD rule demanded
    // unanimity forever, so this hung the room with no way out but the menu.
    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].got.length).toBe(1); // not yet — the countdown is running

    const s = seats[0].rounds.state();
    expect(s.startsInMs).not.toBeNull(); // and it is VISIBLE, not a silent hang
    expect(s.startsInMs!).toBeGreaterThan(0);

    vi.advanceTimersByTime(8100);

    expect(seats[0].got.length).toBe(2);
    expect(seats[0].got[1].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('goes immediately when everyone votes, with no countdown', () => {
    seats = table(['a', 'b'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    seats.forEach((s) => s.rounds.finish());
    settle(); // finish() re-arms the settle window so a rematch never inherits a stale one
    seats.forEach((s) => s.rounds.vote());

    // Unanimity must not be punished with an 8s wait.
    expect(seats[0].got.length).toBe(2);
    expect(seats[0].rounds.state().startsInMs).toBeNull();
  });

  it('lets the host force the rematch immediately with go()', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    seats.forEach((s) => s.rounds.finish());
    settle(); // finish() re-arms the settle window so a rematch never inherits a stale one

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    seats[0].rounds.go(); // host is not made to wait out the countdown

    expect(seats[0].got.length).toBe(2);
  });

  it('cancels the countdown if quorum is lost again', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    seats.forEach((s) => s.rounds.finish());
    settle(); // finish() re-arms the settle window so a rematch never inherits a stale one

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    expect(seats[0].rounds.state().startsInMs!).toBeGreaterThan(0);

    seats[1].rounds.unvote(); // changed their mind
    expect(seats[0].rounds.state().startsInMs).toBeNull();

    vi.advanceTimersByTime(8100);
    expect(seats[0].got.length).toBe(1); // nothing started below quorum
  });

  it('a peer who readies up mid-countdown still lands in the roster', () => {
    seats = table(['a', 'b', 'c'], { minPlayers: 2 });
    seats.forEach((s) => s.rounds.vote());
    seats.forEach((s) => s.rounds.finish());
    settle(); // finish() re-arms the settle window so a rematch never inherits a stale one

    seats[0].rounds.vote();
    seats[1].rounds.vote();
    seats[2].rounds.vote(); // the straggler taps just in time

    expect(seats[2].got.length).toBe(2);
    expect(seats[2].got[1].players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('createRounds — teardown', () => {
  it('stops answering once destroyed', () => {
    seats = table(['a', 'b']);
    seats[1].rounds.destroy();
    seats.forEach((s) => s.rounds.vote());

    // A destroyed Rounds must not keep driving a screen that is gone.
    expect(seats[1].got.length).toBe(0);
  });
});
