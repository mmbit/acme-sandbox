// A thread whose work waits on the board: all its open work queued behind an open card or a pause, its own or that of
// the work it waits for (noteholds.ts holdOf reads the play's chain), with nothing running and nothing in review. A
// pause that a decision of the board's holds with its card is named by that card. Work chained after such a thread
// waits with it, however soon the card's answer is expected. So a needs edge onto one is said where it's drawn
// (newthread.ts, plan.ts need), and the default chain passes one with a card over (newthread.ts chainedAfter). Where
// idle work is read, hq deliverable (outlooks.ts detail) and the CEO's summary (threats.ts), a thread held only through
// such an edge names the edge rather than the card, which would read as its own hold. The held thread may lie further
// down, through needs with no task drawn.
// (its messages say deliverable, the board's word for a thread)
import { db } from './db.ts';
import * as forecast from './forecast.ts';
import type { Forecast } from './forecast.ts';
import { holdOf, holdWords, type Hold } from './noteholds.ts';
import { openCards, pauseHolds, pausedOn } from './jobs.ts';
import { needsOf } from './projects.ts';
import * as pauses from './pauses.ts';
import * as redraws from './redraws.ts';
import { age } from '../../worker/hq/waits.ts';

// The hold, with when it began: its card asked, or its pause put on. A pause a decision holds with an open card is that
// card (pauses.ts holding).
export type BoardHold = Hold & { since: number | null };

// What holds the thread's work, null while any of it can go on (or has no open work)
export function boardHold(thread: string, f: Forecast = forecast.current()): BoardHold | null {
  const o = f.threads.get(thread);
  if (!o?.jobs.length || o.runs.length) return null;
  const holds = [];
  for (const job of o.jobs) {
    const hold = holdOf(job, f);
    if (!hold) return null;
    const card = 'pause' in hold && pauses.holding(hold.pause).find(p => p.target === hold.pause)?.card;
    holds.push(card ? { card } : hold);
  }
  const hold = holds.find(h => 'card' in h) ?? holds[0];
  return { ...hold, since: sinceOf(hold) };
}

// The threads held by a card of the board's, every project's: the default chain passes them over (a pause it judges
// on its own, newthread.ts). Only those whose play waits on a card are read.
export function cardHeld(f: Forecast = forecast.current()) {
  return [...f.threads.values()]
    .filter(o => o.waits.some(w => w.on === 'board' && w.request))
    .flatMap(o => {
      const hold = boardHold(o.thread, f);
      return hold && 'card' in hold ? [o.thread] : [];
    });
}

// The needs edge a thread is held only through: none of its own work waits on a card or a pause of its own, and a
// thread it needs is held (`held`: that one, or one further down through needs with no task drawn, which the play
// passes through). Null otherwise.
export type Through = { needs: string; held: string; hold: BoardHold };
export function heldThrough(thread: string, f: Forecast = forecast.current()): Through | null {
  if (!boardHold(thread, f)) return null;
  const ownCard = db.prepare(`select 1 from (${openCards('?')}) limit 1`);
  if (f.threads.get(thread)!.jobs.some(job => pausedOn(job) || ownCard.get(job))) return null;
  const seen = new Set<string>();
  const heldFrom = (t: string): Omit<Through, 'needs'> | null => {
    const hold = boardHold(t, f);
    if (hold) return { held: t, hold };
    const o = f.threads.get(t);
    // (one with no task drawn plays as its placeholder, an id below 0: threadorder.ts placeholders)
    if (seen.has(t) || !o?.jobs.every(job => job < 0) || o.runs.length) return null;
    seen.add(t);
    for (const n of needsOf(t)) {
      const below = heldFrom(n);
      if (below) return below;
    }
    return null;
  };
  for (const needs of needsOf(thread)) {
    const below = heldFrom(needs);
    if (below) return { needs, ...below };
  }
  return null;
}

// The hold (noteholds.ts holdWords) with how long: its card open, or paused
export function holdAndAge(hold: BoardHold, now = Date.now()) {
  const since = hold.since === null ? '' : `${'card' in hold ? ', open' : ' for'} ${age(now - hold.since)}`;
  return `${holdWords(hold)}${since}`;
}

// Said where a needs edge onto a held thread is drawn: the edge stays, for the drawer to judge
export function drawnWords(thread: string, needs: string, hold: BoardHold, now = Date.now()) {
  const too = 'card' in hold ? 'on the board' : 'for the pause';
  return (
    `${needs} is held (${holdAndAge(hold, now)}), and everything chained after it waits ${too} too: keep this edge ` +
    `only if the work really can't start without it (else hq plan unneed ${thread} ${needs} "why").`
  );
}

// The edge a thread is held only through, for hq deliverable and the summary
export const throughWords = (thread: string, t: Through, now = Date.now()) =>
  `its needs edge on ${t.needs}, which ${t.held === t.needs ? 'is held' : `waits for ${t.held}, held`} ` +
  `(${holdAndAge(t.hold, now)}): if its work can start without it, hq plan unneed ${thread} ${t.needs} "why"`;

function sinceOf(hold: Hold) {
  const row =
    'card' in hold
      ? db.prepare('select created at from requests where id = ?').get(hold.card)
      : db
          .prepare(
            redraws.query(
              `select min(at) at from pauses p where coalesce(p.thread, p.project) = ? and ${pauseHolds('p')}`,
            ),
          )
          .get(hold.pause);
  const at = (row as { at: string | null } | undefined)?.at;
  return at ? Date.parse(at) : null;
}
