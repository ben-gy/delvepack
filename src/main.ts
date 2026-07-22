// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * main.ts — bootstrap and screen wiring. Owns no game logic.
 *
 * The shape: menu -> (solo | room entry -> lobby) -> countdown -> run ->
 * results -> (rematch inside the same room | back to lobby | menu).
 *
 * The rule that governs this file: ONE ROOM PER SESSION. The Net is created once
 * when you enter a room and lives until you leave for the menu. "Play again"
 * never touches it — rematch.ts versions rounds inside the living room.
 */

// feedback:begin (managed by hub/scripts/feedback/backfill.mjs)
import { mountFeedback } from './feedback';
mountFeedback();
// feedback:end

import './styles/mobile.css';
import './styles/main.css';

import { Game, type HeroSpec } from './game';
import { MODE_LIST, MAX_PLAYERS, modeOf, DEFAULT_MODE, type Mode } from './modes';
import { createSession, type Session, type SessionSeat } from './net-game';
import { createRenderer } from './render';
import { createFx, delverColor, MONSTER_COLORS } from './fx';
import { createSfx } from './sound';
import { startCountdown, type Countdown } from './countdown';
import { UPGRADE_BY_ID } from './upgrades';
import {
  summarize,
  tallyRound,
  emptyTally,
  renderSummary,
  shareText,
  type MatchTally,
} from './results';
import { createLoop } from '@ben-gy/game-engine/loop';
import { createInput } from '@ben-gy/game-engine/input';
import { createStore } from '@ben-gy/game-engine/storage';
import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type Rounds } from '@ben-gy/game-engine/rematch';
import { resolveName, withName } from '@ben-gy/game-engine/identity';
import { hardenViewport } from '@ben-gy/game-engine/mobile';
import {
  createLobby,
  createRoomEntry,
  normalizeRoomCode,
  clearRoomInUrl,
  setRoomInUrl,
} from '@ben-gy/game-engine/lobby';
import { newSeed } from '@ben-gy/game-engine/rng';

hardenViewport();

/** The slug every mesh on this page keys off. */
const SLUG = 'delvepack';

/**
 * TURN credentials, fetched the instant the module evaluates.
 *
 * Trystero builds ONE global pool of pre-made RTCPeerConnections from whichever
 * joinRoom fires first on the page, so a turnless first mesh leaves the
 * initiating half of every later pair STUN-only — which is invisible in testing
 * and fatal on carrier-grade NAT, where the data channel never opens and both
 * players sit in the right room code staring at an empty lobby. Starting the
 * fetch here and awaiting it in enterRoom() means the FIRST join this page ever
 * makes already carries TURN. getTurnConfig() is session-cached and fails open
 * to [], so this can only ever delay a join by its own 3s timeout, and only on
 * the first room of a session.
 */
const turnReady: Promise<void> = getTurnConfig().then(
  (servers) => setTurnConfig(servers),
  () => setTurnConfig([]),
);

const store = createStore(SLUG);
const app = document.querySelector<HTMLDivElement>('#app')!;

const sfx = createSfx(store.get('muted', false));
let myName = resolveName(store, () => 'Delver');

let net: Net | null = null;
let rounds: Rounds | null = null;
let session: Session | null = null;
let game: Game | null = null;
let countdown: Countdown | null = null;
let tally: MatchTally = emptyTally();
let mySeat = 0;
let roomCode = '';
let mode: Mode = modeOf(store.get('mode', DEFAULT_MODE.id));
let deepLinkUsed = false;

const el = (html: string): HTMLElement => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
};

const FOOTER = `<footer class="site-footer">
  Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
  · <a class="hub-link" href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
</footer>`;

function shell(inner: string): void {
  app.innerHTML = `<div class="main-content">${inner}</div>${FOOTER}`;
  const hub = app.querySelector<HTMLAnchorElement>('.hub-link');
  if (hub) hub.href = withName('https://hub.benrichardson.dev', myName);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// ── menu ────────────────────────────────────────────────────────────────────

function showMenu(): void {
  teardownRoom();
  clearRoomInUrl();

  shell(`
    <div class="menu">
      <h1 class="title">Delvepack</h1>
      <p class="tagline">Descend a monster-choked dungeon. Clear each floor, grab an upgrade, go deeper.<br/>Alone, or drop in a friend and revive each other. How deep can you delve?</p>

      <div class="modes" role="radiogroup" aria-label="Mode">
        ${MODE_LIST.map(
          (m) => `<button class="mode${m.id === mode.id ? ' on' : ''}" role="radio"
            aria-checked="${m.id === mode.id}" data-mode="${m.id}">
            <b>${m.name}</b><span>${esc(m.blurb)}</span></button>`,
        ).join('')}
      </div>

      <div class="menu-actions">
        <button class="btn primary" id="play">Play</button>
        <button class="btn" id="friends">Play with friends</button>
      </div>

      <label class="namebox">Your name
        <input id="name" maxlength="12" value="${esc(myName)}" autocomplete="off" spellcheck="false" />
      </label>

      <div class="menu-links">
        <button class="btn ghost" id="how">How to play</button>
        <button class="btn ghost" id="about">About</button>
        <button class="btn ghost" id="mute">${sfx.muted() ? 'Sound off' : 'Sound on'}</button>
      </div>
      <p class="best">${bestLine()}</p>
    </div>`);

  for (const b of app.querySelectorAll<HTMLElement>('.mode')) {
    b.addEventListener('click', () => {
      mode = modeOf(b.dataset.mode);
      store.set('mode', mode.id);
      sfx.unlock();
      sfx.play('select');
      showMenu();
    });
  }

  app.querySelector('#play')!.addEventListener('click', () => {
    sfx.unlock();
    startSolo();
  });
  app.querySelector('#friends')!.addEventListener('click', () => {
    sfx.unlock();
    showRoomEntry();
  });
  app.querySelector('#how')!.addEventListener('click', () => showHelp());
  app.querySelector('#about')!.addEventListener('click', showAbout);
  app.querySelector('#mute')!.addEventListener('click', () => {
    sfx.setMuted(!sfx.muted());
    store.set('muted', sfx.muted());
    sfx.unlock();
    sfx.play('select');
    showMenu();
  });

  const name = app.querySelector<HTMLInputElement>('#name')!;
  name.addEventListener('change', () => {
    myName = name.value.trim().slice(0, 12) || 'Delver';
    store.set('name', myName);
    name.value = myName;
  });

  if (!store.get('seen-help', false)) showHelp();
}

function bestLine(): string {
  const best = store.get<number>(`best:${mode.id}`, 0);
  return best > 0 ? `Your best ${mode.name}: Floor ${best}` : '';
}

// ── help / about ──────────────────────────────────────────────────────────────

function modal(title: string, body: string): void {
  const m = el(`<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-card">
      <h2>${esc(title)}</h2>
      ${body}
      <button class="btn primary modal-x">Got it</button>
    </div>
  </div>`);
  document.body.appendChild(m);
  const close = (): void => m.remove();
  m.querySelector('.modal-x')!.addEventListener('click', close);
  m.addEventListener('click', (e) => {
    if (e.target === m) close();
  });
}

function showHelp(): void {
  store.set('seen-help', true);
  modal(
    'How to play',
    `<ul class="how">
      <li><b>Move</b> to survive — you fire at the nearest monster <b>automatically</b>, so aiming is done for you.</li>
      <li><b>Dash</b> to dodge. You are briefly <b>invincible</b> mid-dash — it is your escape from a swing or a bolt.</li>
      <li><b>Clear the floor</b>, grab the glowing <b>upgrade orbs</b>, then stand on the <b>rune</b> to descend. It only gets harder.</li>
      <li><b>With friends:</b> revive a downed teammate by <b>standing next to them</b>. If everyone goes down at once, the run is over.</li>
    </ul>
    <p class="how-ctl"><b>Move:</b> WASD / arrows, or the on-screen pad.
    <b>Dash:</b> space, click, or the ⚡ button.</p>`,
  );
}

function showAbout(): void {
  modal(
    'About Delvepack',
    `<p>A dungeon that gets deadlier the deeper you go, and one question: how far can you get before it wins?</p>
     <p>Play solo as a score-attack, or share a room code with friends — up to ${MAX_PLAYERS} delvers descend the <b>same</b> dungeon together, against the dungeon, reviving each other.</p>
     <p class="fine">Multiplayer is <b>peer-to-peer</b>: your browsers talk directly over WebRTC and there is no game server.
     A free public signaling relay only brokers the initial connection — after that, nothing about your run touches anyone's server, and nothing is stored.</p>
     <p class="fine">No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via Cloudflare Web Analytics.</p>
     <p class="fine">Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>.</p>`,
  );
}

// ── room entry + lobby ────────────────────────────────────────────────────────

function showRoomEntry(): void {
  teardownRoom();
  shell('<div class="screen" id="entry"></div>');
  createRoomEntry({
    container: app.querySelector<HTMLElement>('#entry')!,
    onSubmit: (code, created) => void enterRoom(normalizeRoomCode(code), created),
    onCancel: showMenu,
    subtitle: `Start a room and share the code, or type a friend's. Up to ${MAX_PLAYERS} delvers.`,
  });
}

async function enterRoom(code: string, created: boolean): Promise<void> {
  // Nothing is torn down or mutated until TURN is in force — see `turnReady`.
  await turnReady;
  teardownRoom();
  roomCode = code;
  setRoomInUrl(code);

  net = createNet(
    { appId: roomAppId(SLUG), roomId: code, claimHost: created },
    {
      onHostChange: (_id, isSelfHost) => {
        session?.setHost(isSelfHost);
        if (session && isSelfHost) flashHud("The host left — you're leading now");
      },
      onPeerLeave: (id) => session?.onPeerLeave(id),
    },
  );

  rounds = createRounds({
    net,
    playerName: myName,
    minPlayers: 2,
    // The host's mode travels FROZEN inside the round start — a mode decides the
    // arena size and monster budget, so two peers reading their own menus would
    // generate different dungeons off the same seed.
    roundOpts: () => ({ mode: mode.id }),
    onRound: (info) => {
      const opts = info.opts as { mode?: unknown } | undefined;
      const m = modeOf(opts?.mode);
      startRound(info.seed, m, info.players, info.isHost);
    },
  });

  showLobby();
}

function showLobby(): void {
  if (!net || !rounds) return showMenu();
  shell('<div class="screen" id="lobby"></div>');
  const box = app.querySelector<HTMLElement>('#lobby')!;
  const lobby = createLobby({
    container: box,
    net,
    rounds,
    roomCode,
    minPlayers: 2,
    maxPlayers: MAX_PLAYERS,
    onCancel: showMenu,
  });

  const strip = el('<div class="lobby-mode"></div>');
  box.appendChild(strip);
  const paint = (): void => {
    if (!rounds || !net) return;
    const s = rounds.state();
    const hostOpts = s.hostOpts as { mode?: unknown } | null;
    const shown = modeOf(hostOpts?.mode);
    strip.innerHTML = net.isHost()
      ? `<span class="lm-label">Your dungeon (everyone delves this)</span>
         <div class="lm-modes">${MODE_LIST.map(
           (m) =>
             `<button class="lm${m.id === mode.id ? ' on' : ''}" data-mode="${m.id}">${m.name}</button>`,
         ).join('')}</div>
         <span class="lm-blurb">${esc(mode.blurb)}</span>`
      : hostOpts
        ? `<span class="lm-label">The host picked</span>
           <div class="lm-modes"><button class="lm on" disabled>${shown.name}</button></div>
           <span class="lm-blurb">${esc(shown.blurb)}</span>`
        : `<span class="lm-label"><span class="spinner sm"></span> Waiting for the host's pick…</span>`;
    for (const b of strip.querySelectorAll<HTMLElement>('.lm[data-mode]')) {
      b.addEventListener('click', () => {
        mode = modeOf(b.dataset.mode);
        store.set('mode', mode.id);
        sfx.play('select');
        paint();
      });
    }
  };
  paint();
  const poll = setInterval(paint, 700);

  cleanupLobby = () => {
    clearInterval(poll);
    lobby.destroy();
  };
}

let cleanupLobby: (() => void) | null = null;

// ── the run ─────────────────────────────────────────────────────────────────

function startSolo(): void {
  teardownRoom();
  const seed = newSeed();
  startRound(seed, mode, [{ id: 'solo', name: myName }], true);
}

function startRound(
  seed: number,
  m: Mode,
  players: { id: string; name: string }[],
  isHost: boolean,
): void {
  cleanupLobby?.();
  cleanupLobby = null;
  countdown?.cancel();

  const heroes: HeroSpec[] = players.map((p) => ({ name: p.name, bot: false }));
  const sseats: SessionSeat[] = players.map((p) => ({ id: p.id, bot: false }));

  const me = net ? players.findIndex((p) => p.id === net!.selfId) : 0;
  mySeat = me >= 0 ? me : 0;
  game = new Game({ seed, mode: m, heroes });
  const g = game;
  // Only the authority spawns monsters; guests receive them in the first snapshot.
  if (isHost || !net) g.populate();

  session = createSession({
    game: g,
    me,
    seats: sseats,
    net: net ?? undefined,
    host: isHost,
    onEnd: () => showResults(),
    onHostChange: (h) => {
      if (h) flashHud("You're leading now");
    },
  });

  showGame(g, me, m);
}

function showGame(g: Game, me: number, m: Mode): void {
  shell(`
    <div class="play">
      <canvas id="cv" class="drag-surface"></canvas>
      <div class="hud">
        <div class="hud-l">
          <div class="floor" id="floor">Floor 1</div>
          <div class="modehint" id="modehint">${esc(m.name)}</div>
        </div>
        <div class="hud-r">
          <ul class="party" id="party"></ul>
          <button class="icon" id="pause" aria-label="Pause">II</button>
        </div>
      </div>
      <div class="banner" id="banner" hidden></div>
      <div class="flash" id="flash" role="status" aria-live="polite"></div>
      <div class="big" id="big" hidden></div>
      <div class="overlay" id="pausebox" hidden>
        <div class="modal-card">
          <h2>Paused</h2>
          <button class="btn primary" id="resume">Resume</button>
          <button class="btn" id="restart">Restart</button>
          <button class="btn ghost" id="quit">Menu</button>
        </div>
      </div>
    </div>`);

  const canvas = app.querySelector<HTMLCanvasElement>('#cv')!;
  const renderer = createRenderer(canvas);
  const fx = createFx();
  const input = createInput({
    target: canvas,
    keys: {
      KeyW: 'up',
      ArrowUp: 'up',
      KeyS: 'down',
      ArrowDown: 'down',
      KeyA: 'left',
      ArrowLeft: 'left',
      KeyD: 'right',
      ArrowRight: 'right',
      Space: 'dash',
      KeyP: 'pause',
      Escape: 'pause',
      KeyM: 'mute',
    },
    buttons: [{ action: 'dash', label: '⚡' }],
  });

  const floorEl = app.querySelector<HTMLElement>('#floor')!;
  const partyEl = app.querySelector<HTMLElement>('#party')!;
  const bannerEl = app.querySelector<HTMLElement>('#banner')!;
  const bigEl = app.querySelector<HTMLElement>('#big')!;
  const pauseBox = app.querySelector<HTMLElement>('#pausebox')!;
  let paused = false;
  let dashQueued = false;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') dashQueued = true;
  });

  app.querySelector('#pause')!.addEventListener('click', () => setPaused(true));
  app.querySelector('#resume')!.addEventListener('click', () => setPaused(false));
  app.querySelector('#restart')!.addEventListener('click', () => {
    if (net) {
      setPaused(false);
      return; // a shared run is not one player's to restart
    }
    loop.stop();
    input.destroy();
    startSolo();
  });
  app.querySelector('#quit')!.addEventListener('click', () => {
    loop.stop();
    input.destroy();
    showMenu();
  });

  function setPaused(p: boolean): void {
    // In a live room the world does not stop for you — pause is a menu, not a
    // freeze, or one player could hold the run hostage.
    paused = p && !net;
    pauseBox.hidden = !p;
  }

  const resize = (): void => {
    const r = canvas.parentElement!.getBoundingClientRect();
    renderer.resize(r.width, r.height, Math.min(2, window.devicePixelRatio || 1));
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement!);
  resize();

  let running = false;
  bigEl.hidden = false;
  countdown = startCountdown({
    onBeat: (n) => {
      bigEl.textContent = n > 0 ? String(n) : 'DELVE';
      bigEl.className = 'big pop';
      void bigEl.offsetWidth;
      bigEl.className = 'big pop go';
      sfx.play(n > 0 ? 'beat' : 'go');
    },
    onDone: () => {
      running = true;
      bigEl.hidden = true;
    },
  });

  let lastBanner = '';
  function hudTouch(): void {
    floorEl.textContent = `Floor ${g.floor}`;
    partyEl.innerHTML = g.heroes
      .filter((h) => !h.left)
      .map((h) => {
        const frac = Math.max(0, Math.min(1, h.hp / h.stats.maxHp));
        const cls = h.dead ? 'dead' : h.downed ? 'downed' : '';
        return `<li class="pchip ${cls}${h.i === me ? ' me' : ''}">
          <i style="background:${delverColor(h.i)}"></i>
          <span class="pbar"><b style="width:${frac * 100}%"></b></span>
        </li>`;
      })
      .join('');

    let banner = '';
    if (g.phase === 'clear' && !g.over) {
      const on = g.onRune();
      banner =
        g.orbs.length > 0
          ? 'Grab the orbs · reach the rune ⇩'
          : on > 0
            ? `Descending… ${Math.round(g.rune.charge * 100)}%`
            : 'Stand on the rune to descend ⇩';
    }
    if (banner !== lastBanner) {
      lastBanner = banner;
      bannerEl.hidden = banner === '';
      bannerEl.textContent = banner;
    }
  }

  // HUD + a background pump: rAF pauses in a hidden tab, so the run's progress
  // (and, as host, the snapshots that keep everyone else moving) must not depend
  // on it alone.
  const hudTimer = setInterval(() => {
    hudTouch();
    if (running && !paused) session?.pump(performance.now());
  }, 250);

  const loop = createLoop({
    update: () => {},
    render: () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;

      if (running && !paused) {
        const ax = input.state.axis.x;
        const ay = input.state.axis.y;
        const wantDash = dashQueued || input.state.pressed.has('dash');
        session?.intent(ax, ay, wantDash, false);
        dashQueued = false;
        if (fx.stopped() <= 0) session?.pump(now);
      }

      if (input.state.pressed.has('pause')) setPaused(pauseBox.hidden);
      if (input.state.pressed.has('mute')) {
        sfx.setMuted(!sfx.muted());
        store.set('muted', sfx.muted());
      }

      fx.step(dt);
      drainEvents(g, me, fx);
      renderer.draw(g, me, fx, dt);
      input.endFrame();
    },
  });

  let lastFrame = performance.now();
  loop.start();

  cleanupGame = () => {
    loop.stop();
    input.destroy();
    ro.disconnect();
    clearInterval(hudTimer);
    countdown?.cancel();
    countdown = null;
  };
  hudTouch();
}

let cleanupGame: (() => void) | null = null;

/** Turn sim events into noise and light. The sim stays pure; this is the theatre. */
function drainEvents(g: Game, me: number, fx: ReturnType<typeof createFx>): void {
  for (const e of g.events) {
    switch (e.k) {
      case 'fire':
        if (e.i === me) sfx.play('shot');
        break;
      case 'spark':
        fx.burst(e.x, e.y, 3, e.color, 90, 2);
        break;
      case 'kill': {
        const color = MONSTER_COLORS[e.kind] ?? '#aaa';
        const big = e.kind === 'brute' || e.kind === 'boss';
        fx.burst(e.x, e.y, big ? 20 : 8, color, big ? 220 : 130, big ? 4 : 3);
        fx.ring(e.x, e.y, color, big ? 40 : 20);
        if (big) {
          fx.shake(8);
          fx.stop(0.05);
          sfx.play('boom');
        } else {
          sfx.play('kill');
        }
        break;
      }
      case 'hurt':
        if (e.i === me) {
          fx.shake(e.heavy ? 10 : 5);
          fx.stop(0.04);
          sfx.play('hurt');
        }
        fx.burst(e.x, e.y, 5, '#e34b4b', 120, 3);
        break;
      case 'dash':
        fx.burst(e.x, e.y, 6, delverColor(e.i), 150, 2);
        if (e.i === me) sfx.play('dash');
        break;
      case 'orb': {
        fx.burst(e.x, e.y, 10, e.color, 130, 3);
        fx.ring(e.x, e.y, e.color, 22);
        const up = UPGRADE_BY_ID[e.up];
        if (e.i === me && up) {
          sfx.play('orb');
          fx.floatNum(e.x, e.y - 20, up.name, e.color);
          flashHud(`${up.name} — ${up.blurb}`);
        }
        break;
      }
      case 'downed':
        fx.burst(e.x, e.y, 14, '#e34b4b', 160, 3);
        fx.shake(e.i === me ? 14 : 6);
        sfx.play('downed');
        if (e.i === me) flashHud('You are down! A teammate can revive you.');
        break;
      case 'revive':
        fx.ring(e.x, e.y, '#f0e442', 30);
        fx.burst(e.x, e.y, 12, '#f0e442', 150, 3);
        sfx.play('revive');
        if (e.i === me) flashHud('Back up! Get moving.');
        break;
      case 'clear':
        sfx.play('clear');
        flashHud(`Floor ${e.floor} cleared!`);
        break;
      case 'descend':
        fx.shake(8);
        sfx.play('descend');
        flashHud(`Descending to Floor ${e.floor}…`);
        break;
      case 'boss':
        fx.shake(12);
        fx.ring(e.x, e.y, '#e34b4b', 60);
        sfx.play('boss');
        flashHud('A brute stirs in the dark…');
        break;
      case 'wipe':
        fx.shake(20);
        sfx.play('wipe');
        break;
    }
  }
  g.events.length = 0;
}

function flashHud(msg: string): void {
  const f = document.querySelector<HTMLElement>('#flash');
  if (!f) return;
  f.textContent = msg;
  f.classList.add('show');
  setTimeout(() => f.classList.remove('show'), 2200);
}

// ── results ─────────────────────────────────────────────────────────────────

function showResults(): void {
  cleanupGame?.();
  cleanupGame = null;
  const g = game;
  if (!g) return showMenu();

  sfx.play('wipe');
  const s = summarize(g, mySeat);
  const best = store.get<number>(`best:${g.mode.id}`, 0);
  if (!net && s.floor > best) store.set(`best:${g.mode.id}`, s.floor);
  tally = tallyRound(tally, s);

  shell(`
    <div class="results">
      <h2 class="rs-title">${esc(g.mode.name)} — run over</h2>
      <div id="rsbody">${renderSummary(s, tally, Math.max(best, s.floor))}</div>
      <div class="rs-wait" id="rswait" hidden></div>
      <div class="rs-actions">
        <button class="btn primary" id="again">Play again</button>
        <button class="btn" id="share">Share</button>
        ${net ? '<button class="btn ghost" id="tolobby">Back to lobby</button>' : ''}
        <button class="btn ghost" id="menu">Menu</button>
      </div>
    </div>`);

  app.querySelector('#share')!.addEventListener('click', () => void share(shareText(s)));
  app.querySelector('#menu')!.addEventListener('click', showMenu);
  app.querySelector('#tolobby')?.addEventListener('click', () => {
    rounds?.finish();
    showLobby();
  });

  const again = app.querySelector<HTMLElement>('#again')!;
  const wait = app.querySelector<HTMLElement>('#rswait')!;

  if (!net) {
    again.addEventListener('click', () => startSolo());
    return;
  }

  rounds?.finish();
  again.addEventListener('click', () => {
    rounds?.vote();
    again.setAttribute('disabled', '');
    again.textContent = 'Waiting…';
    paintWait();
  });

  function paintWait(): void {
    if (!rounds || !net) return;
    const st = rounds.state();
    if (st.phase === 'playing') return;
    const votes = st.votes.map((v) => esc(v.name)).join(', ');
    const missing = st.present.length - st.votes.length;
    wait.hidden = st.votes.length === 0;
    wait.innerHTML = `
      <span class="spinner sm" aria-hidden="true"></span>
      <span>${votes || 'Nobody'} ready${missing > 0 ? ` · waiting on ${missing}` : ''}${
        st.startsInMs != null
          ? ` · starting in ${Math.ceil(st.startsInMs / 1000)}s`
          : st.votes.length >= 2
            ? ''
            : ' · need 2 to delve'
      }</span>
      ${st.isHost && st.canStart ? '<button class="btn sm" id="force">Start now</button>' : ''}`;
    wait.querySelector('#force')?.addEventListener('click', () => rounds?.go());
  }
  const poll = setInterval(paintWait, 400);
  cleanupGame = () => clearInterval(poll);
  paintWait();
}

async function share(text: string): Promise<void> {
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Delvepack', text });
      return;
    }
  } catch {
    /* cancelled — fall through to copy */
  }
  try {
    await navigator.clipboard.writeText(text);
    flashHud('Copied!');
  } catch {
    flashHud('Copy failed — select and copy manually');
  }
}

// ── teardown ────────────────────────────────────────────────────────────────

function teardownRoom(): void {
  cleanupGame?.();
  cleanupGame = null;
  cleanupLobby?.();
  cleanupLobby = null;
  countdown?.cancel();
  countdown = null;
  session?.destroy();
  session = null;
  rounds?.destroy();
  rounds = null;
  if (net) {
    void net.leave();
    net = null;
  }
  game = null;
  tally = emptyTally();
}

window.addEventListener('beforeunload', () => {
  void net?.leave();
});

// ── boot ────────────────────────────────────────────────────────────────────

const url = new URL(location.href);
const deep = url.searchParams.get('room');
if (deep && !deepLinkUsed) {
  deepLinkUsed = true;
  const code = normalizeRoomCode(deep);
  if (code.length >= 3) void enterRoom(code, false);
  else showMenu();
} else {
  showMenu();
}
