// Receipt ages and inspection-time freshness from one description of the original timestamps.
import { STALE_MS } from './roomretention.ts';

type Timestamps = number | { [key: string]: Timestamps } | Timestamps[];

export function timestampAges<T extends Timestamps>(timestamps: T, at: number): T {
  if (typeof timestamps === 'number') return (at - timestamps) as T;
  if (Array.isArray(timestamps)) return timestamps.map(time => timestampAges(time, at)) as T;
  return Object.fromEntries(Object.entries(timestamps).map(([key, time]) => [key, timestampAges(time, at)])) as T;
}

export function freshAges(ages: Timestamps): boolean {
  if (typeof ages === 'number') return Number.isFinite(ages) && ages >= 0 && ages <= STALE_MS;
  return Object.values(ages).every(freshAges);
}
