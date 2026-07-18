/**
 * sound.ts — procedural SFX. Zero asset files, works offline.
 *
 * Adapted from patterns/sound.ts with Delvepack's own patches. The countdown
 * beats, the descend swoosh and the wipe sting carry the run's edges because
 * players are watching the arena, not the HUD. A voice cap keeps a floor full of
 * dying grubs from stacking into a clipped roar.
 */

export type SfxName =
  | 'shot'
  | 'hit'
  | 'kill'
  | 'boom'
  | 'hurt'
  | 'dash'
  | 'orb'
  | 'clear'
  | 'descend'
  | 'downed'
  | 'revive'
  | 'boss'
  | 'beat'
  | 'go'
  | 'select'
  | 'win'
  | 'wipe';

interface Patch {
  type: OscillatorType;
  freq: [number, number];
  dur: number;
  gain?: number;
  noise?: boolean;
}

const PATCHES: Record<SfxName, Patch> = {
  shot: { type: 'square', freq: [640, 880], dur: 0.05, gain: 0.08 },
  hit: { type: 'square', freq: [360, 240], dur: 0.05, gain: 0.09, noise: true },
  kill: { type: 'triangle', freq: [420, 120], dur: 0.16, gain: 0.2, noise: true },
  boom: { type: 'sawtooth', freq: [200, 40], dur: 0.5, gain: 0.34, noise: true },
  hurt: { type: 'sawtooth', freq: [300, 90], dur: 0.18, gain: 0.26, noise: true },
  dash: { type: 'sawtooth', freq: [240, 660], dur: 0.16, gain: 0.15, noise: true },
  orb: { type: 'square', freq: [720, 1180], dur: 0.16, gain: 0.16 },
  clear: { type: 'triangle', freq: [520, 1040], dur: 0.4, gain: 0.22 },
  descend: { type: 'sine', freq: [640, 180], dur: 0.5, gain: 0.24 },
  downed: { type: 'sawtooth', freq: [260, 70], dur: 0.55, gain: 0.32, noise: true },
  revive: { type: 'sine', freq: [280, 780], dur: 0.4, gain: 0.24 },
  boss: { type: 'sawtooth', freq: [150, 70], dur: 0.6, gain: 0.34, noise: true },
  beat: { type: 'square', freq: [440, 440], dur: 0.1, gain: 0.2 },
  go: { type: 'square', freq: [880, 1240], dur: 0.28, gain: 0.26 },
  select: { type: 'triangle', freq: [520, 880], dur: 0.08, gain: 0.16 },
  win: { type: 'triangle', freq: [520, 1040], dur: 0.5, gain: 0.24 },
  wipe: { type: 'sawtooth', freq: [340, 60], dur: 0.8, gain: 0.34, noise: true },
};

export interface Sfx {
  unlock(): void;
  play(name: SfxName): void;
  muted(): boolean;
  setMuted(m: boolean): void;
}

export function createSfx(initialMuted = false): Sfx {
  let ctx: AudioContext | null = null;
  let muted = initialMuted;
  let voices = 0;

  const ensure = (): AudioContext | null => {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
      } catch {
        return null;
      }
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  };

  const noiseBuffer = (ac: AudioContext, dur: number): AudioBuffer => {
    const len = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  return {
    unlock() {
      ensure();
    },

    play(name) {
      if (muted) return;
      if (voices > 12) return;
      const ac = ensure();
      if (!ac) return;
      const p = PATCHES[name];
      if (!p) return;
      try {
        const t0 = ac.currentTime;
        voices++;
        const g = ac.createGain();
        g.gain.setValueAtTime(p.gain ?? 0.25, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
        g.connect(ac.destination);

        const osc = ac.createOscillator();
        osc.type = p.type;
        osc.frequency.setValueAtTime(Math.max(1, p.freq[0]), t0);
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.freq[1]), t0 + p.dur);
        osc.connect(g);
        osc.start(t0);
        osc.stop(t0 + p.dur);
        osc.onended = () => {
          voices--;
        };

        if (p.noise) {
          const n = ac.createBufferSource();
          n.buffer = noiseBuffer(ac, p.dur);
          const ng = ac.createGain();
          ng.gain.setValueAtTime((p.gain ?? 0.25) * 0.5, t0);
          ng.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
          n.connect(ng);
          ng.connect(ac.destination);
          n.start(t0);
          n.stop(t0 + p.dur);
        }
      } catch {
        voices = Math.max(0, voices - 1);
      }
    },

    muted: () => muted,
    setMuted(m) {
      muted = m;
    },
  };
}
