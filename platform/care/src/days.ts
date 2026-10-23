// Days in the company's time zone, and its working days: Monday to Friday, less its public holidays (company.ts:
// `timeZone`, `holiday`). A parcel shipped at 00:30 local time left that day, not
// the UTC day before, so every date is the company's calendar day. Days are UTC midnights of that date, and a UTC midnight
// is taken as a day already (one from here, or a date-only 'YYYY-MM-DD'), never converted again: west of UTC that would read
// the date before. Only a moment at exactly 00:00:00.000 UTC there reads as that date rather than the evening before.
import { settings } from './company.ts';

const DAY_MS = 864e5;
const formats = new Map<string, Intl.DateTimeFormat>();
const format = () => {
  const zone = settings.timeZone;
  if (!formats.has(zone)) formats.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }));
  return formats.get(zone)!;
};
const parts = (t: number) => Object.fromEntries(format().formatToParts(t).map(p => [p.type, p.value]));
export const day = (t: number) => { if (t % DAY_MS === 0) return t; const p = parts(t); return Date.UTC(+p.year, +p.month - 1, +p.day); };
export const hour = (t: number) => +parts(t).hour;
const dateOf = (d: number) => new Date(d).toISOString().slice(0, 10); // a day's own date, as it is
export const iso = (t: number) => dateOf(day(t));

// the loops step through days, which are tested as the dates they are
const workday = (d: number) => ![0, 6].includes(new Date(d).getUTCDay()) && !settings.holiday(dateOf(d));
export const working = (t: number) => workday(day(t));
export function addWorkingDays(t: number, n: number) { let d = day(t); for (let k = n; k > 0;) { d += DAY_MS; if (workday(d)) k--; } return d; }
export const workingDaysBetween = (from: number, to: number) => { let n = 0; for (let d = day(from), end = day(to); d < end;) { d += DAY_MS; if (workday(d)) n++; } return n; };
