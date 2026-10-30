// HQ's clock and calendar: the hour and the day it shows (the real ones, ?hour=, ?date= or a time-lapse's), the
// season, the holidays it decorates for and how dark it is, all on the company's clock, and the money, days and times
// HQ writes.
import { clamp } from '../util.js';
import { HOLIDAYS, holidaysOn } from '../../../shared/holidays/holidays.js';
import { formats } from '../../../shared/format/format.js';
import { clock, fromNow as fromNowAt, lasted } from '../../../shared/signs/signs.js';

let fixedHour = NaN, fixedDate = null, lapsing = null, day; // day: the date and holidays checkDay last saw
let founded, celebrated; // the brand's calendar: its founding 'MM-DD' and the holidays it keeps

// q: the page's query. ?hour=22 previews the night, ?date=2026-10-30 another day (keeping the time of day).
// calendar: the brand's; without one, no birthday and every holiday below
export function init(q, calendar = {}) {
  fixedHour = parseFloat(q.get('hour')); fixedDate = q.get('date');
  ({ founded, holidays: celebrated = Object.keys(HOLIDAYS) } = calendar);
  checkDay();
}
export function hour() {
  if (lapsing) return lapsing.h;
  if (!isNaN(fixedHour)) return fixedHour;
  return companyFormats().hourAt(Date.now());
}
// hour() is the time now, not a preview or a time-lapse
export const real = () => !lapsing && isNaN(fixedHour);
// a time-lapse from now, a whole day in twenty seconds, for this many seconds
export function lapse(seconds) { lapsing = { h: hour(), left: seconds }; }
// dev: the clock held at h
export function setHour(h) { lapsing = { h, left: 1e9, rate: 0 }; }
export function tick(dt) {
  if (!lapsing) return;
  lapsing.h = (lapsing.h + dt * (lapsing.rate ?? 24 / 20)) % 24;
  if ((lapsing.left -= dt) <= 0) lapsing = null;
}
export const darkness = h => clamp(Math.max((6.8 - h) / 1.6, (h - 18.8) / 1.6), 0, 1);

// ---- the calendar ----
// today's calendar date, or the faked one from ?date=: a Date whose fields (getDate(), getHours()) read the company's
// clock.
export function today() {
  const f = companyFormats(), now = Date.now(), h = f.hourAt(now);
  const on = isoDay => { const [y, m, d] = isoDay.split('-').map(Number); return new Date(y, m - 1, d, h | 0, Math.round((h % 1) * 60)); };
  const faked = fixedDate && on(fixedDate);
  return faked && !isNaN(faked) ? faked : on(f.dayAt(now));
}
export function season(d = today()) { const m = d.getMonth(); return m < 2 || m === 11 ? 'winter' : m < 5 ? 'spring' : m < 8 ? 'summer' : 'autumn'; }
// The holidays HQ can decorate for: the table every app reads (shared/holidays/holidays.js). The names of those the
// company keeps that are on at date d and hour h, with 'birthday' on the day it was founded (bunting on the roof terrace)
export function holidays(d = today(), h = hour()) {
  const pad = n => String(n).padStart(2, '0'), date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const kept = holidaysOn(date, h, celebrated);
  return new Set(date === founded ? ['birthday', ...kept] : kept);
}
// A new day, or a holiday starting or ending (the decorations go up and come down by themselves, and the gifts under
// the tree pile up day by day): the holidays on now, else null
export function checkDay() {
  const on = holidays(), was = day;
  day = `${today().toDateString()} ${[...on]}`;
  return day === was ? null : on;
}

// ---- the company's clock: org.yaml's company.timeZone (world.setOrg sets it), UTC until the org is read.
let zone = 'UTC';
const bindings = new Map();
export function setTimeZone(timeZone) { zone = timeZone; }
// Money, days and times as HQ writes them (shared/format), in British English on the company's clock. currency: the
// amounts' own, as the data names it (Care's numbers and the testers' vouchers count euros)
export function companyFormats(currency) {
  const key = `${zone} ${currency ?? ''}`;
  if (!bindings.has(key)) bindings.set(key, formats({ locales: { en: 'en-GB' }, currency, timeZone: zone }));
  return bindings.get(key);
}
// A moment's time of day, "16:40". ms: a time in ms or a date string.
export const timeOf = ms => companyFormats().time(new Date(ms), 'en');
// A moment's day and time, "Thu 16 Oct, 16:40". timeZoneName labels a company clock different from the device's.
export function dayTime(ms, { weekday = true, separator = ', ', timeZoneName = false } = {}) {
  const f = companyFormats(), at = new Date(ms);
  const labelZone = timeZoneName && Intl.DateTimeFormat().resolvedOptions().timeZone !== zone;
  const time = f.time(at, 'en', labelZone ? { timeZoneName: 'short' } : {});
  return `${f.day(f.dayAt(at), 'en', { weekday, short: true })}${separator}${time}`;
}
// The design system's time words (shared/signs) on the company's clock: "16:40" today, "Thu 09:00" on another day, and
// when something's due, "25 min", "1½ h", "Thu", "Thu 29 Oct"
export const clockWhen = ms => clock(ms, { timeZone: zone });
export const fromNow = ms => fromNowAt(ms, { timeZone: zone });

// how long ago a timestamp was, in the design system's time words (the one policy desk.js and care.js share)
export const ago = ts => { const ms = Date.now() - new Date(ts); return !ts || isNaN(ms) ? '' : ms < 30000 ? 'just now' : `${lasted(ms)} ago`; };
