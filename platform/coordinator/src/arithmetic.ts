// The arithmetic the estimates share: a mean, a median, the value a share of them fit in, a time to whole seconds, and
// times in whole minutes and shares to hundredths (hq estimate --calibration's threads).

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
