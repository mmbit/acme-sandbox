// Stage burn prices identified from the shared meter's overlapping run hours.
export type MixInterval = {
  mix: Record<string, number>;
  five: number;
  fiveHours: number;
  week: number;
  weekHours: number;
};
export type MixFit = { residualPerHour: number; pivotRatio: number; observations: number; parameters: number };
export type MixRate = {
  five: number | null;
  week: number | null;
  fiveHours: number;
  weekHours: number;
  fiveIntervals: number;
  weekIntervals: number;
  fiveFit?: MixFit | null;
  weekFit?: MixFit | null;
};

// (a seat's fit is kept for the same intervals: compared one by one, the kept ones the same objects each read.
const cached = new Map<string, { intervals: MixInterval[]; rates: Record<string, MixRate> }>();
export function mixRates(intervals: MixInterval[], seat?: string): Record<string, MixRate> {
  const before = seat === undefined ? undefined : cached.get(seat);
  if (before && sameIntervals(before.intervals, intervals)) return before.rates;

  const five = fit(intervals, 'five'),
    week = fit(intervals, 'week');
  const kinds = new Set([...five.keys(), ...week.keys()]);
  const rates = Object.fromEntries(
    [...kinds].map(kind => [
      kind,
      {
        five: five.get(kind)?.rate ?? null,
        week: week.get(kind)?.rate ?? null,
        fiveHours: five.get(kind)?.hours ?? 0,
        weekHours: week.get(kind)?.hours ?? 0,
        fiveIntervals: five.get(kind)?.intervals ?? 0,
        weekIntervals: week.get(kind)?.intervals ?? 0,
        fiveFit: five.get(kind)?.fit ?? null,
        weekFit: week.get(kind)?.fit ?? null,
      },
    ]),
  );
  if (seat !== undefined) cached.set(seat, { intervals, rates });
  return rates;
}

const sameIntervals = (a: MixInterval[], b: MixInterval[]) =>
  a.length === b.length && a.every((interval, i) => interval === b[i] || sameInterval(interval, b[i]));
const sameInterval = (a: MixInterval, b: MixInterval) =>
  a.five === b.five &&
  a.fiveHours === b.fiveHours &&
  a.week === b.week &&
  a.weekHours === b.weekHours &&
  Object.keys(a.mix).length === Object.keys(b.mix).length &&
  Object.entries(a.mix).every(([kind, hours]) => b.mix[kind] === hours);

// Each interval's kinds that ran in it (as numbers: kindIds) with their hours: most run one or two of all the kinds, so
// the fit's sums skip the rest's zeros. Kept per interval (the kept ones are the same objects each read: headroom.ts).
const kindIds = new Map<string, number>(),
  kindNames: string[] = [];
const ran = new WeakMap<MixInterval, { kinds: number[]; hours: number[] }>();
function ranIn(interval: MixInterval) {
  let kinds = ran.get(interval);
  if (!kinds) {
    kinds = { kinds: [], hours: [] };
    for (const [kind, hours] of Object.entries(interval.mix)) {
      if (hours === 0) continue;
      if (!kindIds.has(kind)) kindIds.set(kind, kindNames.push(kind) - 1);
      kinds.kinds.push(kindIds.get(kind)!);
      kinds.hours.push(hours);
    }
    ran.set(interval, kinds);
  }
  return kinds;
}

type Observed = { interval: MixInterval; kinds: number[]; hours: number[] };
function fit(intervals: MixInterval[], window: 'five' | 'week') {
  const spentIn = window === 'five' ? 'fiveHours' : 'weekHours';
  const observed = intervals
    .filter(interval => interval[spentIn] > 0)
    .map(interval => ({ interval, ...ranIn(interval) }));
  // (each kind's place among those that ran, -1 for the rest)
  const index: number[] = kindNames.map(() => -1),
    kinds: string[] = [];
  for (const { kinds: ids, hours } of observed)
    for (let a = 0; a < ids.length; a++)
      if (hours[a] > 0 && index[ids[a]] < 0) index[ids[a]] = kinds.push(kindNames[ids[a]]) - 1;
  const { equations, gains, hours, counted } = sums(observed, index, kinds.length, window);
  // A fixed overlap ratio cannot identify separate prices. Negative fitted burn is unsupported too.
  const solution = solve(equations, gains);
  let residual = 0,
    observedHours = 0;
  if (solution)
    for (const { interval, kinds: ids, hours: own } of observed) {
      let predicted = 0;
      for (let a = 0; a < ids.length; a++) if (index[ids[a]] >= 0) predicted += own[a] * solution.prices[index[ids[a]]];
      residual += (interval[window] - predicted) ** 2 / interval[spentIn];
      observedHours += interval[spentIn];
    }
  const fit = solution
    ? {
        residualPerHour: Math.sqrt(residual / observedHours),
        pivotRatio: solution.pivotRatio,
        observations: observed.length,
        parameters: kinds.length,
      }
    : null;
  return new Map(
    kinds.map((kind, i) => [kind, { rate: solution?.prices[i] ?? null, fit, hours: hours[i], intervals: counted[i] }]),
  );
}

// The fit's normal equations and each kind's hours and intervals: each sum gets the same terms in the same order as
// over every kind, but zeros.
function sums(observed: Observed[], index: number[], count: number, window: 'five' | 'week') {
  const spentIn = window === 'five' ? 'fiveHours' : 'weekHours';
  const zeros = () => Array.from({ length: count }, () => 0);
  const equations = zeros().map(zeros),
    gains = zeros(),
    hours = zeros(),
    counted = zeros();
  for (const { interval, kinds: ids, hours: own } of observed) {
    const spent = interval[spentIn];
    for (let a = 0; a < ids.length; a++) {
      const i = index[ids[a]];
      if (i < 0) continue;
      gains[i] += (own[a] * interval[window]) / spent;
      for (let b = 0; b < ids.length; b++) {
        const j = index[ids[b]];
        if (j >= 0) equations[i][j] += (own[a] * own[b]) / spent;
      }
      hours[i] += own[a];
      if (own[a] > 0) counted[i]++;
    }
  }
  return { equations, gains, hours, counted };
}

function solve(equations: number[][], gains: number[]) {
  const rows = equations.map((row, i) => [...row, gains[i]]);
  const scale = Math.max(0, ...equations.flat().map(Math.abs));
  const pivots: number[] = [];
  for (let column = 0; column < rows.length; column++) {
    let pivot = column;
    for (let i = column + 1; i < rows.length; i++)
      if (Math.abs(rows[i][column]) > Math.abs(rows[pivot][column])) pivot = i;
    if (Math.abs(rows[pivot][column]) <= Number.EPSILON * scale * rows.length) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    pivots.push(Math.abs(divisor));
    for (let j = column; j <= rows.length; j++) rows[column][j] /= divisor;
    for (let i = 0; i < rows.length; i++) {
      if (i === column) continue;
      const factor = rows[i][column];
      for (let j = column; j <= rows.length; j++) rows[i][j] -= factor * rows[column][j];
    }
  }
  const prices = rows.map(row => row.at(-1)!);
  return prices.every(price => Number.isFinite(price) && price >= 0)
    ? { prices, pivotRatio: Math.max(...pivots) / Math.min(...pivots) }
    : null;
}
