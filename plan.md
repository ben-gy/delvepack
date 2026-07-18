# Game Plan: Delvepack

## Overview
- **Name:** Delvepack
- **Repo name:** delvepack
- **Tagline:** Descend a monster-choked dungeon — clear each floor, grab an upgrade, go deeper. Alone, or drop a friend into the same dungeon and revive each other.
- **Genre (directory category):** arcade

## Core Loop
Top-down arena. You are a delver. Move (WASD / left thumb-stick); your delver **auto-fires bolts at the nearest monster** on a cadence, so the skill is positioning and dodging, not aiming. **Dash** (Space / DASH button) is a short burst with a few invulnerability frames — your dodge and your repositioning tool, on a cooldown.

Clear every monster on a floor → the **exit rune** lights and **upgrade orbs** drop. Walk over an orb to gain it (fire rate, damage, multishot, move speed, max HP, dash, pierce…). Stand on the rune to charge it (faster with more delvers on it) → the party **descends**. Each floor deeper spawns more/tougher monsters — the ramp is the whole difficulty. Boss brutes on a mode-specific cadence.

Lose condition: HP hits 0 → you are **downed** (co-op: a teammate revives you by standing near; solo: run ends). All delvers down at once → **party wipe**, run over. Score = **deepest floor reached**.

The tension: the ramp always wins eventually. How deep can you get before it does?

## Controls
- **Desktop:** WASD / Arrows to move, Space (or click) to dash. P/Esc pause, M mute.
- **Mobile:** virtual D-pad (patterns/input.ts) to move, big DASH button. Auto-fire needs no input.

## Multiplayer
- **Mode:** live P2P (also fully solo, and any room is solo-complete if nobody joins).
- **Shape:** **co-op** (players vs the dungeon). *Why co-op, not versus:* the fantasy is descending *together*; it survives a 2-player count (two friends who want to play with each other, not knock each other out); it has **no seat-balance problem** (there is no seat to make unfair — everyone fights the same monsters); and a dropped peer degrades into "a harder run", never "a broken match". Versus would need a winner and would turn a descent into a race, which is a worse game.
- **Co-op specifics:** the opponent is the **difficulty ramp** (monster count/HP/speed rising every floor, bosses on a cadence). Players share **one fate at the extremes** (all-down = wipe) but their **own** HP in between (you get downed, not eliminated, and a teammate can revive you within a bleed-out window). What stops one strong player soloing it while the other watches: monsters target *all* delvers and scale with party size, floors get denser than one delver's DPS can hold, and a downed teammate must be physically reached — hogging just gets you both killed. Tension without anyone losing *to* anyone: the floor clock of attrition.
- **Topology:** host-authoritative snapshot star. The **host** owns the shared world — monsters (AI, HP), all bolts, each delver's HP + downed/dead state, floor phase, floor number, the rune charge, loot rolls — and broadcasts a full snapshot at ~14Hz. **Each peer owns only its own delver's position + dash + revive-intent** and broadcasts its pose at ~16Hz. The dungeon layout is generated deterministically from the shared seed via `patterns/rng.ts` (`seed ^ floor`), so **no level data is ever on the wire** — every peer walks the identical map.
- **Channels (≤12 bytes):** `w` (host world snapshot), `p` (peer pose), `rv`/`rs`/`rq` (rematch, from the engine). All ≤12 bytes.
- **Late joiner:** a peer joining mid-run receives the next snapshot (full state) and slots into a spectator until the next floor, then spawns in. A peer leaving mid-run: their delver dissolves; the run continues (harder). Host authority means no desync from a drop.
- **Host leaves:** `net.ts` re-elects the min-id survivor and fires `onHostChange`; the promoted peer's `Session.setHost(true)` adopts its last snapshot as the canonical world (it already holds the full monster/bolt/HP/floor state from the snapshot), re-anchors the clock, resumes monster AI + snapshot broadcast, and the run keeps going and can still reach game-over. Proven by `tests/takeover.test.ts` AND the two-tab smoke test (close the host tab).
- **End of round → rematch (MANDATORY):** uses `patterns/rematch.ts` (`createRounds`), **never touches the room**. "Play again" is a vote + a new round number + a fresh seed + the host's frozen roster; the Net and mesh stay up. While waiting: a visible roster of who's readied and a grace countdown (`state().startsInMs`); the host can force-start; "Back to lobby" returns without leaving the room. If a peer declines/closes, the round starts without them (no deadlock). If the **host** leaves at results, the promoted peer runs the rematch inheriting no tally. Nothing persists across runs except your local best-depth per mode.

## Juice Plan
- Procedural SFX (`sound.ts` extended): auto-fire *tick*, monster *hit*, monster *death* pop, delver *hurt*, *dash* whoosh, orb *pickup* chime, floor-*clear* fanfare, *descend* swoosh, *downed* sting, *revive* rise, boss *roar*, 3-2-1 countdown beats + go.
- Screen shake on taking damage, on a brute dying, on descend. Hit-stop (a few frames) on a kill.
- Particle bursts: bolt impacts, monster death shards (in the monster's colour), dash trail, orb sparkles, revive ring, descend implosion.
- Tweened: HP bar lerps, monster spawn scale-in, damage number pops, floor banner slide.
- `prefers-reduced-motion`: no shake, reduced particle counts.

## Style Direction
**Vibe:** neon-dark dungeon / clean-arcade.
**Palette:** deep slate dungeon (`#0b0f1a`) with an Okabe-Ito, colour-blind-safe delver/monster set (blue `#56b4e9`, orange `#e69f00`, green `#009e73`, vermilion `#d55e00`, purple `#cc79a7`, yellow `#f0e442`). Monsters read by shape as well as colour (grub=round, spitter=diamond, brute=big hexagon) so colour is never the only signal.
**Theme:** dark (action).
**Reference feel:** the readable top-down crunch of a good twin-stick roguelite (auto-aim like Soul Knight), the instant-play of a Google Doodle game.

## Technical Architecture
- **Stack:** vanilla TypeScript + Vite.
- **Render:** Canvas 2D (continuous motion, many entities, particles).
- **Engine modules copied from patterns/:** loop, input (virtual D-pad + dash button), net, lobby, rematch, rng, sound (extended), storage, mobile, identity.
- **Persistence:** localStorage — settings (mute, name, mode), best depth per mode, seen-help.

## Non-Goals
- No inventory/meta-progression between runs (each run is fresh; the only carry-over is a local best).
- No per-player blocking upgrade *menu* (upgrades are diegetic orbs you grab — a menu would stall co-op).
- No twitch-perfect aiming (auto-fire keeps it mobile-first).
- Not a versus mode.

## How To Play (player-facing copy)
Move to survive; you fire at the nearest monster automatically. **Dash** to dodge — you're briefly invincible mid-dash. Clear the floor, grab the glowing upgrade orbs, and stand on the rune to descend. It only gets harder. With friends: revive a downed teammate by standing next to them — if everyone goes down at once, the run's over. How deep can you delve?
