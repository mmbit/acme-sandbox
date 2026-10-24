// When and where a call out may go (callouts.ts): the calling hours, a time on the company's clock, and a number as Twilio
// dials it.
import { brand, timeZone } from './company.ts';
import { companyMoment } from './later.ts';
import { international } from './phonelines.ts';
import { secret } from './secrets.ts';

const AHEAD_MS = 60 * 86_400_000;

// ---- the calling hours: brand.yaml's callsOut.hours ({ days: [mon, tue, ...], from: '09:00', until: '17:00' }), on the
// company's clock; Monday to Friday 09:00 to 17:00 without them
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function hours() {
  const own = brand().callsOut?.hours ?? {},
    time = (v: unknown, d: string) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : d);
  const days = Array.isArray(own.days)
    ? own.days.map((d: unknown) => String(d).slice(0, 3).toLowerCase()).filter((d: string) => DAYS.includes(d))
    : [];
  return {
    days: days.length ? (days as string[]) : DAYS.slice(1, 6),
    from: time(own.from, '09:00'),
    until: time(own.until, '17:00'),
  };
}
export function inHours(at: number) {
  const h = hours(),
    clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone(),
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  const parts = Object.fromEntries(clock.formatToParts(at).map(p => [p.type, p.value]));
  const time = `${parts.hour}:${parts.minute}`;
  return h.days.includes(parts.weekday.toLowerCase()) && time >= h.from && time < h.until;
}
export function hoursText() {
  // (Monday first: 1 to 7)
  const h = hours(),
    at = h.days.map(d => DAYS.indexOf(d) || 7).sort((a, b) => a - b),
    cap = (d: number) => DAYS[d % 7][0].toUpperCase() + DAYS[d % 7].slice(1);
  const run = at.every((d, i) => i === 0 || d === at[i - 1] + 1);
  return `${run && at.length > 2 ? `${cap(at[0])}-${cap(at.at(-1)!)}` : at.map(cap).join(', ')} ${h.from}-${h.until}`;
}

// --at: '2026-10-20 14:30' (or with a T) on the company's clock, or a UTC time ('2026-10-20T12:30Z'); within 60 days
export function atTime(given: unknown): string | null | { why: string } {
  if (given == null || given === '') return null;
  const text = String(given).trim(),
    local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text);
  const at = local
    ? companyMoment(...(local.slice(1).map(Number) as [number, number, number, number, number]))
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(text)
      ? Date.parse(text)
      : NaN;
  if (Number.isNaN(at))
    return {
      why: `can't read "${text.slice(0, 40)}": give a time on the company's clock (2026-10-20 14:30) or a UTC time (2026-10-20T12:30Z)`,
    };
  if (at <= Date.now()) return { why: `${text} has passed: leave --at out to call as soon as the board approves` };
  if (at > Date.now() + AHEAD_MS) return { why: `${text} is more than 60 days ahead` };
  return new Date(at).toISOString();
}

// A number as Twilio dials it (E.164: +31201234567), from one in international form (+31 20 ..., 0031 20 ...) or a
// national one (020 ...) in our line's country; null if it isn't one
export function dialable(given: unknown) {
  if (typeof given !== 'string' || !/^[+\d\s()./-]{6,30}$/.test(given.trim())) return null;
  let digits = international(given.trim());
  if (/^0[1-9]/.test(digits)) {
    const ours = international(secret('TWILIO_PHONE_NUMBER'));
    if (!/^[1-9]/.test(ours)) return null;
    digits = countryCode(ours) + digits.slice(1);
  }
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}
// E.164's country codes are a prefix code: 1 and 7 one digit, these two, every other three (ITU-T's list of assigned codes)
const TWO_DIGITS = new Set([
  '20',
  '27',
  '30',
  '31',
  '32',
  '33',
  '34',
  '36',
  '39',
  '40',
  '41',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '57',
  '58',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '81',
  '82',
  '84',
  '86',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
  '98',
]);
const countryCode = (digits: string) =>
  /^[17]/.test(digits) ? digits[0] : TWO_DIGITS.has(digits.slice(0, 2)) ? digits.slice(0, 2) : digits.slice(0, 3);
