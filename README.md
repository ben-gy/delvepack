# Delvepack

**Descend a monster-choked dungeon — clear each floor, grab an upgrade, go deeper. Alone, or drop in a friend and revive each other.**

🎮 Play: https://delvepack.benrichardson.dev

## What it is

Delvepack is a top-down co-op dungeon crawler. You are a delver in an arena full of monsters; you move to survive and **fire at the nearest one automatically**, so the skill is positioning and dodging, not aiming. **Dash** for a short burst of invulnerability — it is your escape from a swing or a bolt. Clear every monster on a floor and the exit **rune** lights up and **upgrade orbs** drop; grab what you can reach (fire rate, damage, multishot, pierce, speed, dash, HP) and stand on the rune to descend. Every floor spawns more and tougher monsters — the ramp is the whole difficulty. How deep can you delve?

Solo it is a score-attack: your best depth per mode is saved locally. With friends it becomes co-op — up to four delvers descend the **same** deterministic dungeon **together, against the dungeon**. A delver at 0 HP is **downed**, not eliminated: a teammate revives you by standing next to you. If everyone goes down at once, the run is over. A friend who drops just makes the run harder.

The difficulty curve was not eyeballed — it is refereed by an AI-vs-the-dungeon balance sim (`tests/balance.test.ts`) that measures the survival curve per party size, so the opening is reliably winnable, deep runs are a real achievement, and the run always resolves.

## How to play

- **Move:** WASD / arrows on desktop, an on-screen D-pad on touch.
- **Dash:** space, click, or the ⚡ button — brief invulnerability, on a cooldown.
- **Auto-fire:** automatic, at the nearest monster. No aiming.
- **Descend:** clear the floor, grab the glowing orbs, stand on the rune.
- **Revive (co-op):** stand next to a downed teammate.

**Three modes** that change the space between you and the monsters: **Delve** (mid hall, balanced, the classic), **Warren** (wide cavern, crowds of weaker foes — crowd control), **Crypt** (tight chamber, few but brutal and fast — a knife-fight).

## Multiplayer

Live **peer-to-peer** for 2–4 delvers, plus solo. Host-authoritative: the host owns the shared world (monsters, bolts, HP, the floor lifecycle, the rune) and broadcasts a snapshot; each peer owns only its own delver's motion. The dungeon layout is generated deterministically from a shared seed, so no level data crosses the wire. Create a room and share the 4-character code (or the link), or type a friend's code to join. If the host leaves, a survivor is promoted and the run keeps going. There is **no game server** — a free public signaling relay only brokers the initial WebRTC connection, after which nothing about your run touches anyone's server, and nothing is stored.

## Tech

- Vite 6 + vanilla TypeScript
- Canvas 2D rendering
- Shared engine: fixed-timestep loop, unified keyboard/touch input, procedural audio, Trystero P2P netcode, deterministic seeded RNG
- Vitest for logic, P2P-sync determinism, host-transfer, room-code, rematch lifecycle, and the AI-vs-dungeon balance sim
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

`npm run icons` regenerates the home-screen icons from the game's mark.

## License

MIT
