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

const cached = new Map<string, { signature: string; rates: Record<string, MixRate> }>();
export function mixRates(intervals: MixInterval[], seat?: string): Record<string, MixRate> {
  const signature = seat === undefined ? '' : JSON.stringify(intervals);
  if (seat !== undefined && cached.get(seat)?.signature === signature) return cached.get(seat)!.rates;

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
  if (seat !== undefined) cached.set(seat, { signature, rates });
  return rates;
}

function fit(intervals: MixInterval[], window: 'five' | 'week') {
  const observed = intervals.filter(interval => interval[`${window}Hours`] > 0);
  const kinds = [
    ...new Set(observed.flatMap(interval => Object.keys(interval.mix).filter(kind => interval.mix[kind] > 0))),
  ];
  const equations = kinds.map(() => kinds.map(() => 0));
  const gains = kinds.map(() => 0);
  for (const interval of observed) {
    const hours = interval[`${window}Hours`];
    for (let i = 0; i < kinds.length; i++) {
      const own = interval.mix[kinds[i]] ?? 0;
      gains[i] += (own * interval[window]) / hours;
      for (let j = 0; j < kinds.length; j++) equations[i][j] += (own * (interval.mix[kinds[j]] ?? 0)) / hours;
    }
  }
  // A fixed overlap ratio cannot identify separate prices. Negative fitted burn is unsupported too.
  const solution = solve(equations, gains);
  const fit = solution
    ? {
        residualPerHour: Math.sqrt(
          observed.reduce((sum, interval) => {
            const predicted = kinds.reduce((gain, kind, i) => gain + (interval.mix[kind] ?? 0) * solution.prices[i], 0);
            return sum + (interval[window] - predicted) ** 2 / interval[`${window}Hours`];
          }, 0) / observed.reduce((sum, interval) => sum + interval[`${window}Hours`], 0),
        ),
        pivotRatio: solution.pivotRatio,
        observations: observed.length,
        parameters: kinds.length,
      }
    : null;
  return new Map(
    kinds.map((kind, i) => [
      kind,
      {
        rate: solution?.prices[i] ?? null,
        fit,
        hours: observed.reduce((sum, interval) => sum + (interval.mix[kind] ?? 0), 0),
        intervals: observed.filter(interval => interval.mix[kind] > 0).length,
      },
    ]),
  );
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
