// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * results.ts — the end-of-run summary.
 *
 * This is a CO-OP game, so principle #9 inverts: lead with the SHARED outcome
 * (how deep the party got, and what ended the run), and use the per-delver
 * breakdown to show what each one CONTRIBUTED — kills, damage, revives given —
 * never to rank them. A co-op summary that quietly turns teammates into a
 * leaderboard rewards hogging the thing that scores, so there is no winner here,
 * only the party's depth and everyone's part in reaching it.
 *
 * Every peer reaches this screen: a delver who died early, who was downed at the
 * end, or who is a spectator all get the same summary, never a frozen arena.
 */

import { Game } from './game';
import { delverColor } from './fx';

export interface Row {
  i: number;
  name: string;
  isSelf: boolean;
  kills: number;
  dmg: number;
  revives: number;
  deepest: number;
  status: 'stood' | 'downed' | 'dead' | 'left';
}

export interface Summary {
  floor: number;
  mode: string;
  solo: boolean;
  rows: Row[];
  totalKills: number;
  cause: string;
}

export interface MatchTally {
  rounds: number;
  bestFloor: number;
}

export function emptyTally(): MatchTally {
  return { rounds: 0, bestFloor: 0 };
}

export function tallyRound(t: MatchTally, s: Summary): MatchTally {
  return { rounds: t.rounds + 1, bestFloor: Math.max(t.bestFloor, s.floor) };
}

export function summarize(g: Game, mySeat: number): Summary {
  const rows: Row[] = g.heroes.map((h) => ({
    i: h.i,
    name: h.name,
    isSelf: h.i === mySeat,
    kills: h.st.kills,
    dmg: Math.round(h.st.dmg),
    revives: h.st.revives,
    deepest: h.st.deepest,
    status: h.left ? 'left' : h.dead ? 'dead' : h.downed ? 'downed' : 'stood',
  }));
  const totalKills = rows.reduce((a, r) => a + r.kills, 0);
  const solo = g.heroes.length === 1;
  return { floor: g.floor, mode: g.mode.name, solo, rows, totalKills, cause: causeOf(g, solo) };
}

function causeOf(g: Game, solo: boolean): string {
  const f = g.wipedFloor || g.floor;
  if (solo) return `You fell on Floor ${f}.`;
  return `The party was overwhelmed on Floor ${f}.`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

const STATUS_LABEL: Record<Row['status'], string> = {
  stood: 'standing',
  downed: 'downed',
  dead: 'fell',
  left: 'left',
};

export function renderSummary(s: Summary, tally: MatchTally, best: number): string {
  const headline = s.solo
    ? `You delved to <b>Floor ${s.floor}</b>`
    : `The party delved to <b>Floor ${s.floor}</b>`;

  const rowsHtml = s.rows
    .map((r) => {
      const stat = STATUS_LABEL[r.status];
      const reached =
        r.status === 'dead' || r.status === 'left' ? ` · fell on floor ${r.deepest}` : '';
      return `<tr class="${r.isSelf ? 'me' : ''}">
        <td class="rs-who"><i style="background:${delverColor(r.i)}"></i>${esc(r.name)}${r.isSelf ? ' (you)' : ''}</td>
        <td>${r.kills}</td>
        <td>${r.dmg}</td>
        ${s.solo ? '' : `<td>${r.revives}</td>`}
        <td class="rs-status s-${r.status}">${stat}${reached}</td>
      </tr>`;
    })
    .join('');

  const bestLine = s.solo && best > 0 ? `<p class="rs-best">Your best ${esc(s.mode)}: Floor ${best}</p>` : '';
  const sessionLine =
    !s.solo && tally.rounds > 0
      ? `<p class="rs-best">Deepest this session: Floor ${tally.bestFloor}</p>`
      : '';

  return `
    <div class="rs-shared">
      <p class="rs-head">${headline}</p>
      <p class="rs-cause">${esc(s.cause)}</p>
      <p class="rs-total">${s.totalKills} monster${s.totalKills === 1 ? '' : 's'} slain together</p>
    </div>
    <table class="rs-table">
      <thead><tr><th>Delver</th><th>Kills</th><th>Dmg</th>${s.solo ? '' : '<th>Revives</th>'}<th>Ended</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${bestLine}${sessionLine}`;
}

export function shareText(s: Summary): string {
  const who = s.solo ? 'I' : 'My party';
  return `Delvepack — ${who} delved to Floor ${s.floor} in ${s.mode} (${s.totalKills} monsters slain). Play: https://delvepack.benrichardson.dev`;
}
