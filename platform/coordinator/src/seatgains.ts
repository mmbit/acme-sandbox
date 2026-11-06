// A seat's usage gained between two of its readings, and the run time it worked up to each (headroom.ts prices its
// intervals with them).
import type { MixInterval } from './workmix.ts';

export type Reading = {
  seat: string;
  at: number;
  reported: number;
  util: number | null;
  resets: number | null;
  week: number | null;
  week_resets: number | null;
};

export type Interval = MixInterval & {
  from: number;
  known: number; // (when the later of its readings was reported)
  hours: number;
  five: number;
  fiveHours: number;
  week: number;
  weekHours: number;
};
export type Run = { started: number; ended: number | null; kind: string };

// The run time a seat has worked up to each time asked, in ms, the times asked in order: one sweep over its runs' starts
// and ends, an open run's end `at`.
export function runMilliseconds(runs: Run[], at: number) {
  const events = runs
    .flatMap(run => [
      { at: run.started, kind: run.kind, change: 1 },
      { at: Math.min(run.ended ?? at, at), kind: run.kind, change: -1 },
    ])
    .sort((a, b) => a.at - b.at);
  let index = 0,
    previous = events[0]?.at ?? 0;
  const active: Record<string, number> = {},
    total: Record<string, number> = {};
  const advance = (to: number) => {
    for (const [kind, count] of Object.entries(active)) total[kind] = (total[kind] ?? 0) + count * (to - previous);
    previous = to;
  };
  return (to: number) => {
    while (index < events.length && events[index].at <= to) {
      const event = events[index++];
      advance(event.at);
      active[event.kind] = (active[event.kind] ?? 0) + event.change;
    }
    advance(to);
    return { ...total };
  };
}

// The usage gained between two readings, per window, counted only where both readings have it and no reset falls between.
export function pricedInterval(before: Reading, reading: Reading, mix: Record<string, number>): Interval {
  const hours = Object.values(mix).reduce((sum, elapsed) => sum + elapsed, 0);
  const gained = (used: 'util' | 'week', reset: 'resets' | 'week_resets') => {
    const gain = reading[used] !== null && before[used] !== null ? reading[used] - before[used] : null;
    const counted =
      gain !== null &&
      gain >= 0 &&
      reading[reset] === before[reset] &&
      !(before[reset] !== null && before[reset] <= reading.at);
    return counted ? [gain, hours] : [0, 0];
  };
  const [five, fiveHours] = gained('util', 'resets'),
    [week, weekHours] = gained('week', 'week_resets');
  return {
    from: before.at,
    known: Math.max(before.reported, reading.reported),
    hours,
    five,
    fiveHours,
    week,
    weekHours,
    mix,
  };
}
