// Measured seat capacity for hypothetical plan replays.
import { yamlFile } from './company.ts';
import type { Snapshot } from './eta.ts';

export function configuredPlans(): Record<string, 5 | 20> {
  const plans = yamlFile('company/seatplans.yaml');
  for (const [seat, plan] of Object.entries(plans))
    if (plan !== 5 && plan !== 20) throw new Error(`company/seatplans.yaml: ${seat} needs 5 or 20`);
  return plans;
}

export function extraClaude(snapshot: Snapshot, plan: 5 | 20) {
  const source = measuredSource(snapshot);
  if (!source)
    return {
      available: false as const,
      reason: 'No Claude subscription of known size has positive measured usage in both windows.',
    };
  // A Claude seat has no run cap of its own (the worker reports none): the added seat then shares the reported slots.
  const runs = snapshot.seatRuns?.claude ?? null;
  if (snapshot.slots.claude === undefined || snapshot.room === undefined)
    return { available: false as const, reason: 'The worker has no current room and Claude slot report.' };
  const sourcePlan = snapshot.seatPlans![source.id];
  const rates = snapshot.rates.claude;
  const factor = sourcePlan / plan;
  const five = rates.five[source.id]! * factor;
  const week = (typeof rates.week === 'object' ? rates.week![source.id]! : rates.week!) * factor;
  const capacity = {
    plan,
    source: source.id,
    source_plan: sourcePlan,
    measured: snapshot.seatMeasurements?.[source.id] ?? null,
    five_per_agent_hour: five,
    week_per_agent_hour: week,
    five_agent_hours: source.stop / five,
    week_agent_hours: source.stop / week,
    stop: source.stop,
    pacing: !!snapshot.pacing,
    seat_runs: runs,
    room: snapshot.room,
    confidence: 'low' as const,
    assumptions: [
      'A fresh subscription starts now, with five-hour and seven-day windows.',
      'Usage matches the measured seat. The reserve and pacing rules are copied from that seat.',
      ...(sourcePlan === plan
        ? []
        : ['Capacity scales by the plan labels. This ratio is an assumption, not a measured provider limit.']),
      'Work mix and provider limits can change. This estimate has not been calibrated against an added seat.',
      'An added subscription shares the same worker slots, memory budget and admission rules.',
      ...(snapshot.memory
        ? []
        : ['This retained input has no per-run memory. Fixed room is a sensitivity, not a release forecast.']),
    ],
  };
  const more = copiedSeat(snapshot, source, five, week, true);
  return { available: true as const, capacity, snapshot: more };
}

function measuredSource(snapshot: Snapshot) {
  const sources = snapshot.seats.filter(s => {
    const rates = snapshot.rates.claude;
    const week = typeof rates?.week === 'object' && rates.week !== null ? rates.week[s.id] : rates?.week;
    return (
      s.engine === 'claude' &&
      !s.credits &&
      snapshot.seatPlans?.[s.id] &&
      (rates?.five[s.id] ?? 0) > 0 &&
      (week ?? 0) > 0
    );
  });
  const support = (id: string) => {
    const m = snapshot.seatMeasurements?.[id];
    return m ? Math.min(m.fiveHours, m.weekHours) : 0;
  };
  sources.sort((a, b) => support(b.id) - support(a.id) || a.id.localeCompare(b.id));
  return sources[0];
}

// The queue as it is with one more seat of the engine: a copy of one of its seats as HQ reads it, its windows fresh,
// at that seat's measured fill rates in both windows, sharing the existing worker resources.
// Missing prices cannot establish a hypothetical allowance.
export function oneMoreSeat(snapshot: Snapshot, engine: string): Snapshot | null {
  const rate = snapshot.rates[engine];
  const runs = snapshot.seatRuns?.[engine];
  const slots = snapshot.slots[engine];
  if (!rate || runs === undefined || slots === undefined) return null;
  const perSeat = typeof rate.week === 'object' ? rate.week : null;
  const weekOf = (seat: string) => (perSeat ? perSeat[seat] : typeof rate.week === 'number' ? rate.week : null);
  const measured = (seat: string) => typeof rate.five[seat] === 'number' && typeof weekOf(seat) === 'number';
  const like = snapshot.seats.find(s => s.engine === engine && measured(s.id));
  if (!like) return null;
  return copiedSeat(snapshot, like, rate.five[like.id]!, weekOf(like.id)!, false);
}

function copiedSeat(
  snapshot: Snapshot,
  source: Snapshot['seats'][number],
  five: number,
  week: number,
  timed: boolean,
): Snapshot {
  let id = `${source.engine}-${timed ? 'hypothetical' : 'more'}`;
  while (snapshot.seats.some(s => s.id === id)) id += '-more';
  const rate = snapshot.rates[source.engine];
  const weeks = typeof rate.week === 'object' && rate.week !== null ? rate.week : null;
  const fresh = {
    state: 'ready',
    until: null,
    fiveHour: 0,
    week: 0,
    fiveHourObservedAt: null,
    weekObservedAt: null,
    latestReportedAt: null,
    fiveHourSource: undefined,
    weekSource: undefined,
    credits: timed ? false : source.credits,
    fiveHourResets: snapshot.now + 5 * 3_600_000,
    weekResets: snapshot.now + 7 * 24 * 3_600_000,
  };
  return {
    ...snapshot,
    seats: [...snapshot.seats, { ...source, ...fresh, id }],
    rates: {
      ...snapshot.rates,
      [source.engine]: {
        week: weeks ? { ...weeks, [id]: week } : week,
        five: { ...rate.five, [id]: five },
      },
    },
    slots: { ...snapshot.slots },
    seatMix: copiedMix(snapshot, source.id, id, five, week),
  };
}

function copiedMix(snapshot: Snapshot, source: string, id: string, five: number, week: number) {
  const mix = snapshot.seatMix?.[source];
  if (!mix) return snapshot.seatMix;
  const rates = snapshot.rates[snapshot.seats.find(s => s.id === source)!.engine];
  const sourceWeek = typeof rates.week === 'object' ? rates.week![source]! : rates.week!;
  return {
    ...snapshot.seatMix,
    [id]: Object.fromEntries(
      Object.entries(mix).map(([kind, rate]) => [
        kind,
        {
          ...rate,
          five: rate.five === null || !rates.five[source] ? null : (rate.five * five) / rates.five[source]!,
          week: rate.week === null || !sourceWeek ? null : (rate.week * week) / sourceWeek,
        },
      ]),
    ),
  };
}
