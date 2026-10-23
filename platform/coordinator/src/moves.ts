// What a change to the queue moves: each thread's ETA in the forecast before it and in the one played after it
// (forecast.ts), for hq job, hq cancel, hq estimate set and hq window to say which threads moved, by how much and to
// when; and for the first three, each agreed deadline's facts (deadlines.ts).
import { inOneStep } from './db.ts';
import { agreed, type Deadline } from './deadlines.ts';
import * as forecast from './forecast.ts';
import { findProject, findThread } from './projects.ts';
import type { Forecast, ThreadOutlook } from './forecast.ts';
import type { Snapshot } from './eta.ts';

// A thread's ETA: its last open job merged, no merge in sight ('stalled'), or no open work left ('none').
export type Eta = { at: number } | 'stalled' | 'none';
export type Move = { thread: string; project: string; name: string; from: Eta; to: Eta };

// The forecast before is the latest one, up to a minute old (forecast.current): an ETA that moved less than this is
// only the clock having moved on, not the change.
const MOVED_MS = 5 * 60_000;

// The forecast before a change, or none when the queue can't be played (the change goes ahead, and says nothing moved).
export function before(now = Date.now()) {
  try {
    return forecast.current(now);
  } catch (err) {
    console.error('Could not play the queue before a change:', err);
    return undefined;
  }
}

// The threads the change moved since `earlier`: the queue played again now, and where it leaves each agreed deadline.
// Nothing to say without a forecast before.
export function since(earlier: Forecast | undefined, now = Date.now()): { moves?: Move[]; deadlines?: Deadline[] } {
  if (!earlier) return {};
  try {
    const later = forecast.refresh(now);
    return {
      moves: diff(earlier, later),
      deadlines: agreed(later.threads, earlier.threads, later.snapshot.deployLagMs, later.now),
    };
  } catch (err) {
    console.error('Could not play the queue after a change:', err);
    return {};
  }
}

// A change and what it moves (hq window: windows.ts): `make` makes it, `changed` is the change as the queue read before
// it shows it, and `read` reads the play with it. The queue is read once and played at the usual pace twice, before the
// change and with it (forecast.trial): a thread's ETA and finish come from that pace, and the request plays nothing else.
// A change kept is played whole a moment later as for any other change (forecast.playSoon): the latest forecast and the
// prediction log follow it there, off the request. Only tried, nothing is kept: it's made in a savepoint and rolled back.
export function change<T, R extends object>(
  make: () => T,
  changed: (queue: Snapshot) => Snapshot,
  read: (later: Forecast) => R,
  tried: boolean,
) {
  const played = forecast.trial(Date.now());
  const earlier = played();
  const made = inOneStep(make, { keep: !tried });
  const later = played(changed);
  if (!tried) forecast.playSoon();
  return { made, moves: diff(earlier, later, 0), ...read(later) };
}

// Each thread whose ETA moved between two forecasts, by its id.
export function diff(earlier: Forecast, later: Forecast, toleranceMs = MOVED_MS) {
  const ids = [...new Set([...earlier.threads.keys(), ...later.threads.keys()])].sort();
  const moves: Move[] = [];
  for (const id of ids) {
    const [from, to] = [etaOf(earlier.threads.get(id)), etaOf(later.threads.get(id))];
    if (same(from, to, toleranceMs)) continue;
    const thread = findThread(id);
    const project = thread ? (findProject(thread.project)?.name ?? thread.project) : id.split('/')[0];
    moves.push({ thread: id, project, name: thread?.name ?? id, from, to });
  }
  return moves;
}

const etaOf = (t: ThreadOutlook | undefined): Eta => (!t ? 'none' : t.eta === null ? 'stalled' : { at: t.eta });
const same = (a: Eta, b: Eta, toleranceMs: number) =>
  typeof a === 'object' && typeof b === 'object' ? a.at === b.at || Math.abs(a.at - b.at) < toleranceMs : a === b;
