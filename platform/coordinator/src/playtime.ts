// Elapsed work, review and waiting time, with overlapping review runs counted once.
import type { PlayTime } from './eta.ts';

export type Span = { start: number; end: number };

export function elapsedTime(
  now: number,
  merged: number | null,
  deployMs: number,
  work: Span[],
  reviews: Span[],
): PlayTime | null {
  if (merged === null) return null;
  if (merged < now) return null;
  const workMs = covered(work, now, merged);
  const reviewMs = covered([...work, ...reviews], now, merged) - workMs;
  return {
    work_ms: workMs,
    review_ms: reviewMs,
    waiting_ms: merged - now - workMs - reviewMs,
    deploy_ms: deployMs,
    total_ms: merged - now + deployMs,
  };
}

// (also threadtime.ts: a thread's work and review time)
export function covered(spans: Span[], now: number, merged: number) {
  let end = now,
    elapsed = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const start = Math.max(end, span.start),
      stop = Math.min(merged, span.end);
    elapsed += Math.max(0, stop - start);
    end = Math.max(end, stop);
  }
  return elapsed;
}
