// Configurable seat warnings, checked as worker readings arrive and remembered across coordinator restarts.
import { db, remember, setting } from './db.ts';
import { createHash } from 'node:crypto';
import { companyTime, yamlFile } from './company.ts';
import { seatReading, seatProjection } from './headroom.ts';
import { sendToBoard } from './push.ts';

type Threshold = { percent?: number; hours?: number };
type Warning = { week?: Threshold; five_hour?: Threshold } | null;
type Crossings = Record<string, number | null>;
const KEY = 'seats.warning';
const HOUR_MS = 3_600_000;
db.exec('create table if not exists seat_warnings (seat text primary key, crossings text not null)');

export function getSeatWarning(): Warning {
  const stored = setting(KEY);
  const warning = stored === undefined ? (yamlFile('company/seats.yaml').warning ?? null) : JSON.parse(stored);
  return warning;
}

export function setSeatWarning(warning: unknown) {
  const problem = warningProblem(warning);
  if (problem) return problem;
  remember(KEY, JSON.stringify(warning));
  if (warning === null) db.prepare('delete from seat_warnings').run();
  return { warning };
}

export function checkSeatWarning(id: string) {
  const warning = getSeatWarning();
  if (!warning) return;
  const at = Date.now();
  const seat = seatReading(id);
  if (['closed', 'login', 'paused'].includes(seat.state)) return;
  const row = db.prepare('select crossings from seat_warnings where seat = ?').get(id) as
    { crossings: string } | undefined;
  const before: Crossings = row ? JSON.parse(row.crossings) : {};
  const crossings = { ...before };
  let projection: ReturnType<typeof seatProjection>;
  const exhaustionAt = (window: 'week' | 'five_hour') => (projection ??= seatProjection(id, at))[window];
  const lines: string[] = [];
  for (const window of ['week', 'five_hour'] as const) {
    const threshold = warning[window];
    const used = seat[window],
      reset = seat[`${window}_resets`];
    if (!threshold || used === null) continue;
    const windowOpen = reset === null || reset > at;
    const exhaustion = windowOpen && threshold.hours !== undefined ? exhaustionAt(window) : null;
    const usageReached = windowOpen && threshold.percent !== undefined && used >= threshold.percent / 100;
    const runOutSoon =
      !windowOpen || threshold.hours === undefined
        ? false
        : exhaustion === null || reset === null
          ? null
          : exhaustion < reset && (threshold.hours === 0 || exhaustion - at <= threshold.hours * HOUR_MS);
    const crossed = updateCrossings(crossings, before, window, reset, { percent: usageReached, hours: runOutSoon });
    if (crossed) lines.push(warningLine(window, used, exhaustionAt(window), reset));
  }
  db.prepare(
    `insert into seat_warnings (seat, crossings) values (?, ?)
    on conflict(seat) do update set crossings = excluded.crossings`,
  ).run(id, JSON.stringify(crossings));
  // The push Topic header allows at most 32 URL-safe characters.
  const tag = `seat-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
  if (lines.length)
    void sendToBoard({ title: 'Seat warning', body: `${id}: ${lines.join(' ')}`, tag, url: '/?open=settings' });
}

function warningProblem(warning: unknown): string | null {
  if (warning === null) return null;
  if (!warning || typeof warning !== 'object' || Array.isArray(warning))
    return 'Use null for off, or window thresholds.';
  const windows = Object.entries(warning);
  if (!windows.length || windows.some(([window]) => !['week', 'five_hour'].includes(window)))
    return 'Choose week or five_hour thresholds.';
  for (const [, threshold] of windows) {
    if (!threshold || typeof threshold !== 'object' || Array.isArray(threshold)) return 'Give window thresholds.';
    const entries = Object.entries(threshold);
    if (!entries.length) return 'Give a percent or hours threshold.';
    for (const [name, value] of entries) {
      if (!['percent', 'hours'].includes(name)) return 'Choose percent or hours.';
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        (name === 'percent' && (value <= 0 || value > 100))
      )
        return 'Percent must be above 0 and at most 100. Hours must be 0 or more.';
    }
  }
  return null;
}

function updateCrossings(
  crossings: Crossings,
  before: Crossings,
  window: string,
  reset: number | null,
  conditions: Record<string, boolean | null>,
) {
  let crossed = false;
  for (const [condition, on] of Object.entries(conditions)) {
    const key = `${window}.${condition}`;
    if (on === null) continue;
    if (!on) delete crossings[key];
    else {
      // A crossing seen before its reset was known belongs to that same window.
      if (!Object.hasOwn(before, key) || (before[key] !== null && before[key] !== reset)) crossed = true;
      crossings[key] = reset;
    }
  }
  return crossed;
}

function warningLine(window: string, used: number, exhaustion: number | null, reset: number | null) {
  const name = window === 'week' ? 'week' : '5-hour window';
  const expected =
    exhaustion === null
      ? 'run-out time unknown'
      : reset !== null && exhaustion >= reset
        ? 'not expected to run out before reset'
        : `expected to run out ${companyTime(exhaustion)} at the current workload`;
  const resets = reset === null ? 'reset unknown' : `resets ${companyTime(reset)}`;
  return `${name} ${Math.round((1 - used) * 100)}% left, ${expected}, ${resets}.`;
}
