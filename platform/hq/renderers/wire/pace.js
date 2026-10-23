// The pace of a job's work, from its token readings ([ms, total], the worker's): BARS bars over the job so far, at least
// SPAN_MIN and at most SPAN_MAX back, so the row is full from the start; and what it wrote a minute on average over
// them. A time before the first reading counts as that reading. null: no reading yet.
export const BARS = 12;
const SPAN_MIN = 2 * 60_000,
  SPAN_MAX = 15 * 60_000;

export function pace(readings, since, now = Date.now()) {
  if (!readings?.length) return null;
  const span = Math.min(SPAN_MAX, Math.max(SPAN_MIN, now - (since ?? readings[0][0]))),
    step = span / BARS,
    from = now - span,
    at = t => readings.reduce((n, [when, total]) => (when <= t ? total : n), readings[0][1]);
  return {
    bars: Array.from({ length: BARS }, (_, i) => at(from + (i + 1) * step) - at(from + i * step)),
    perMinute: Math.round(((at(now) - at(from)) * 60_000) / span),
  };
}
