// A moment of a watch-along an agent asks for in words, made a time on the page's clock (the screen tool, hq call's
// views).
import { timeZone } from './company.ts';
import type { Moments } from '../../../shared/watchalong/moments.ts';

export const WHEN_WORDS =
  "a time is 'now', some seconds or minutes ago ('-20s', '-2m'), a time of day ('17:03:12') or a moment ('#12')";

// A time asked for, on the page's clock: some seconds or minutes ago, a time of day today on the company's clock, or a
// moment's. undefined: none of those
export function when(spec: string, watch: { moments: Pick<Moments, 'list'>; clockMs: number }, now = Date.now()) {
  const ago = /^-(\d+)\s*(s|m)$/.exec(spec);
  if (ago) return now - Number(ago[1]) * (ago[2] === 'm' ? 60_000 : 1000) - watch.clockMs;
  const moment = /^#(\d+)$/.exec(spec);
  if (moment) return watch.moments.list.find(m => m.n === Number(moment[1]))?.at;
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(spec);
  if (!time) return undefined;
  const [hours, minutes, seconds] = [time[1], time[2], time[3] ?? '0'].map(Number);
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
  // (today's date on the company's clock, and how far that clock is from UTC now)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone(),
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(now)
      .map(part => [part.type, Number(part.value)]),
  );
  const offset =
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    Math.floor(now / 1000) * 1000;
  let at = Date.UTC(parts.year, parts.month - 1, parts.day, hours, minutes, seconds) - offset;
  if (at > now + 60_000) at -= 86_400_000; // (a time later than now: yesterday's, a call past midnight)
  return at - watch.clockMs;
}
