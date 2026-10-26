// Due meetings get first use of freed room for one bounded gathering attempt.
import { db } from './db.ts';
import type { Meeting, Seat } from './meetings.ts';
import { seatReadyFor } from './jobs.ts';

// The gathering budget and recovery interval are shared with meetingseats.ts.
export const HOLD_MS = 10 * 60_000;
export const REST_MS = 5 * 60_000;
export const restUntil = () =>
  (db.prepare('select coalesce(max(rests), 0) until from meetings').get() as { until: number }).until;
export const until = (m: Meeting) => Math.max(m.at, restUntil()) + HOLD_MS;

export function current(now = Date.now()) {
  const planned = db
    .prepare(
      `select * from meetings m where status = 'planned'
    and exists (select 1 from meeting_seats s join jobs j on j.id = s.job
      where s.meeting = m.id and j.status = 'queued') order by at, id`,
    )
    .all() as Meeting[];
  if (planned.some(m => now >= until(m))) letGo(now);
  const rests = restUntil();
  return planned.map(m => ({ ...m, rests, gathering: rests > now ? null : m.gathering }));
}

export function first<T extends { id: number; expedite?: number }>(
  sorted: T[],
  kind?: string,
  slot?: string,
  now = Date.now(),
) {
  const available = { jobs: sorted, gathering: false };
  if (!slot || kind === 'chat' || sorted.some(j => j.expedite)) return available;
  const planned = current(now);
  if (planned.some(m => m.rests > now)) {
    const resting = new Set(planned.flatMap(m => queuedSeats(m.id).map(s => s.job)));
    return { jobs: sorted.filter(j => !resting.has(j.id)), gathering: false };
  }
  const m = planned.find(
    m => m.at <= now && (m.rests ?? 0) <= now && queuedSeats(m.id).every(s => seatReadyFor(s.job, now)),
  );
  if (!m) return available;
  const jobs = new Set(queuedSeats(m.id).map(s => s.job));
  return { jobs: sorted.filter(j => jobs.has(j.id)), gathering: true };
}

// Every planned meeting shares the recovery interval, including one made during it.
export function letGo(now: number) {
  db.prepare(
    `update meeting_seats set slot = null, runner = null
    where meeting in (select id from meetings where status = 'planned')`,
  ).run();
  db.prepare("update meetings set gathering = null, rests = ? where status = 'planned'").run(now + REST_MS);
}

export const queuedSeats = (id: number) =>
  db
    .prepare(
      `select s.* from meeting_seats s
  join jobs j on j.id = s.job where s.meeting = ? and j.status = 'queued'`,
    )
    .all(id) as Seat[];
