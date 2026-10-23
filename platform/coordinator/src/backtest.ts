// The backtest: the play (eta.ts, the version loaded, or another one handed in) replayed on the kept snapshots
// (snapshots.ts) and scored against what happened (landings.ts). For each work job that landed and each lead (an hour,
// six hours, a day), the snapshot kept that long before its landing: its predicted merge against the landing, and
// whether the time a promise holds to (the slow play's, predictions.heldTo) held. hq estimate --backtest runs it on the
// server's play; hq estimate --backtest --save hands the snapshots and landings to scripts/backtest.ts, which scores a
// branch's play beside main's before it lands.
import { PLAY_VERSION, play, type Outlook, type Size, type Snapshot } from './eta.ts';
import { heldTo } from './predictions.ts';
import { landings } from './landings.ts';
import * as snapshots from './snapshots.ts';
import { median } from './arithmetic.ts';
import { scoreRounds } from './roundscore.ts';

const MINUTE_MS = 60_000,
  HOUR_MS = 60 * MINUTE_MS,
  DAY_MS = 24 * HOUR_MS;

// The prediction standing `ms` before the landing. A snapshot counts for a lead when it was kept at most SPAN_MS
// earlier than that (snapshots are kept hourly): an older one stands for a longer lead.
export const LEADS = [
  { lead: 'an hour', ms: HOUR_MS },
  { lead: 'six hours', ms: 6 * HOUR_MS },
  { lead: 'a day', ms: DAY_MS },
];
const SPAN_MS = HOUR_MS;

export type Play = (
  snapshot: Snapshot,
  sizes: ReadonlyMap<number, Size>,
  options?: { pace?: 'usual' | 'slow' },
) => Map<number, Outlook>;
// What hq estimate --backtest --save writes: the kept snapshots and each of their work jobs that landed since.
export type Saved = { days: number; version: number; snapshots: snapshots.Kept[]; landed: [number, number][] };

// hq estimate --backtest [--days n]: the server's play on the snapshots of the last n days (7).
export async function report(ask: { days?: unknown }, now = Date.now()) {
  const kept = keptOver(ask, now);
  if (typeof kept === 'number') return kept;
  const landed = landings(workIn(kept.snapshots));
  const leads = await score(kept.snapshots, landed, play);
  const rounds = await scoreRounds(kept.snapshots, play);
  const coverage = {
    planner_snapshots: rounds.snapshots,
    legacy_snapshots: kept.snapshots.length - rounds.snapshots,
  };
  return { days: kept.days, version: PLAY_VERSION, snapshots: kept.snapshots.length, leads, rounds, coverage };
}

// hq estimate --backtest --save <file>: the snapshots and the landings, for a play on a branch (scripts/backtest.ts).
export function saved(ask: { days?: unknown }, now = Date.now()): Saved | number {
  const kept = keptOver(ask, now);
  if (typeof kept === 'number') return kept;
  const landed = landings(workIn(kept.snapshots));
  return { days: kept.days, version: PLAY_VERSION, snapshots: kept.snapshots, landed: [...landed] };
}

function keptOver(ask: { days?: unknown }, now: number) {
  const days = ask.days === undefined ? 7 : Number(ask.days);
  if (!Number.isInteger(days) || days < 1 || days > snapshots.KEEP_DAYS) return 400;
  return { days, snapshots: snapshots.since(now - days * DAY_MS) };
}

const workIn = (kept: snapshots.Kept[]) => [
  ...new Set(kept.flatMap(k => k.snapshot.jobs.filter(j => j.kind === 'work').map(j => j.id))),
];

// One job's prediction at one lead, and its landing.
export type Sample = { lead: string; merged: number | null; held: number | null; landed: number };

// The play on each snapshot a job's lead falls on (each snapshot played once, both paces), by lead. A play of a day's
// queue takes tens of milliseconds, so the server answers other requests between two.
export async function score(kept: snapshots.Kept[], landed: Map<number, number>, playIt: Play) {
  const ordered = kept.filter(k => k.snapshot.planner === 3).sort((a, b) => a.at - b.at);
  const work = ordered.map(k => new Set(k.snapshot.jobs.filter(j => j.kind === 'work').map(j => j.id)));
  const picks = LEADS.flatMap(({ lead, ms }) =>
    [...landed].flatMap(([job, at]) => {
      const i = ordered.findLastIndex((k, n) => k.at <= at - ms && k.at > at - ms - SPAN_MS && work[n].has(job));
      return i < 0 ? [] : [{ lead, job, at, i }];
    }),
  );
  const plays = new Map<number, { usual: Map<number, Outlook>; slow: Map<number, Outlook> }>();
  for (const i of new Set(picks.map(p => p.i))) {
    const { snapshot, sizes } = ordered[i];
    plays.set(i, {
      usual: playIt(snapshot, new Map(sizes.usual), { pace: 'usual' }),
      slow: playIt(snapshot, new Map(sizes.slow), { pace: 'slow' }),
    });
    await new Promise(setImmediate);
  }
  const samples = picks.flatMap(({ lead, job, at, i }): Sample[] => {
    const u = plays.get(i)!.usual.get(job),
      s = plays.get(i)!.slow.get(job);
    return u ? [{ lead, merged: u.merged, held: s ? heldTo(u, s) : u.merged, landed: at }] : [];
  });
  return byLead(samples);
}

// Each lead's samples: how many, how many the play didn't merge at all, the median miss either way, and the shares that
// landed later than said and within the time a promise holds to.
export function byLead(samples: Sample[]) {
  return LEADS.map(({ lead }) => {
    const all = samples.filter(s => s.lead === lead);
    const merged = all.filter(s => s.merged !== null);
    const middle = median(merged.map(s => Math.abs(s.landed - s.merged!)));
    const share = (n: number) => (merged.length ? Math.round((n / merged.length) * 100) / 100 : null);
    return {
      lead,
      count: all.length,
      no_merge: all.length - merged.length,
      median_miss_minutes: middle === null ? null : Math.round(middle / MINUTE_MS),
      late_share: share(merged.filter(s => s.landed > s.merged!).length),
      held_share: all.length
        ? Math.round((all.filter(s => s.held !== null && s.landed <= s.held).length / all.length) * 100) / 100
        : null,
    };
  });
}
