// Shared estimate statistics, time conversions and prediction scores.

// Null for no values.
export const mean = (values: number[]) =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

// The middle value, the lower of the two middle ones for an even count. Null for no values.
export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// The value that share of the values fit in (0.8: four in five are that or less). Null for no values.
export function fitIn(values: number[], part: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * part))];
}

// (the record's times come through julianday, a few microseconds off)
export const wholeSeconds = (ms: number) => Math.round(ms / 1000) * 1000;

// (the minutes and shares: threadtime.ts, threadwaits.ts)
export const MINUTE_MS = 60_000;
// Times (ms) in whole minutes, in all and the median one (null for none)
export const minutes = (values: number[]) => ({
  total: Math.round(values.reduce((sum, v) => sum + v, 0) / MINUTE_MS),
  median: values.length ? Math.round(median(values)! / MINUTE_MS) : null,
});
export const share = (n: number) => Math.round(n * 100) / 100;

// Milliseconds in minutes to hundredths, including subminute carry checks.
export const fractionalMinutes = (ms: number) => Math.round(ms / (MINUTE_MS / 100)) / 100;

// Predictions [predicted, actual]: median factor, share within twice or half, and ratio of totals.
export function spread(pairs: [number, number][], floorMs = MINUTE_MS) {
  const by = pairs.map(([predicted, actual]) => Math.abs(factor(predicted, actual, floorMs)));
  const middle = median(by);
  const sum = (i: 0 | 1) => pairs.reduce((total, pair) => total + pair[i], 0);
  return {
    count: pairs.length,
    median_factor: middle === null ? null : share(Math.exp(middle)),
    within_twice: by.length ? share(by.filter(f => f <= Math.LN2).length / by.length) : null,
    sum_ratio: sum(1) ? share(sum(0) / sum(1)) : null,
  };
}

// Ordinary jobs floor durations at a minute. Carry checks pass zero to retain their measured ratios.
export const factor = (predicted: number, actual: number, floorMs = MINUTE_MS) =>
  Math.log(Math.max(actual, floorMs) / Math.max(predicted, floorMs));
