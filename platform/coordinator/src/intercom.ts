// The intercom's whole record, to look back on: a day, days or a day's hours read in full (hq intercom, a call's intercom
// tool), each day a document for search (memory.ts), and the board's lines today for a call's briefing (call.ts). Every
// line shows as it does outside the CEO's session (chat.ts SHOWN), with its time on the company's clock and who said it
import { db } from './db.ts';
import * as chat from './chat.ts';
import * as pictures from './pictures.ts';
import { findAgent } from './jobs.ts';
import { companyFormats, timeZone } from './company.ts';

type Line = { id: number; ts: string; who: string; text: string };
// (made when used: chat.ts is still loading when this module is, through jobs.ts and memory.ts)
const shownLines = () => `select id, ts, who, ${chat.SHOWN} text from chat`;

// hq intercom <day>, <day>..<day> or <day> <hh:mm>-<hh:mm>: every line in it, by day. Both ends of the hours count.
const SPAN = /^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2})| (\d{1,2}:\d{2})-(\d{1,2}:\d{2}))?$/;
const MAX_DAYS = 14;
const SPAN_REFUSED = "give a day (2026-10-16), days (2026-10-14..2026-10-16) or a day's hours (2026-10-16 09:00-12:00)";
export const isSpan = (span: unknown) => SPAN.test(String(span ?? '').trim());
export function read(span: unknown) {
  const m = SPAN.exec(String(span ?? '').trim());
  if (!m || !isDay(m[1]) || (m[2] && !isDay(m[2])) || (m[3] && !isClock(m[3])) || (m[4] && !isClock(m[4])))
    return [400, SPAN_REFUSED] as const;
  const [, from, to = from] = m;
  const start = clockOf(m[3] ?? '00:00');
  const end = clockOf(m[4] ?? '23:59');
  if (to < from || end < start) return [400, `the end comes before the start: ${SPAN_REFUSED}`] as const;
  if ((Date.parse(to) - Date.parse(from)) / 86400e3 >= MAX_DAYS)
    return [400, `at most ${MAX_DAYS} days at a time`] as const;
  // (a day on the company's clock is within a day either side of the same UTC day)
  const rows = db
    .prepare(`${shownLines()} where ts >= ?4 and ts < ?5 order by id`)
    .all(...chat.shownAs(), shiftDay(from, -1), shiftDay(to, 2)) as Line[];
  const days = byDay(rows, (day, time) => day >= from && day <= to && time >= start && time <= end);
  return { timeZone: timeZone(), days: [...days].map(([day, lines]) => ({ day, lines })) };
}

// Every day the intercom has, each its lines (search's documents, memory.ts)
export function everyDay() {
  const rows = db.prepare(`${shownLines()} order by id`).all(...chat.shownAs()) as Line[];
  return byDay(rows);
}

function byDay(rows: Line[], keep = (_day: string, _time: string) => true) {
  const stamp = stamper();
  const days = new Map<string, string[]>();
  const names = new Map<string, string>();
  const shown = pictures.ofLines(); // (one read for all the lines)
  for (const line of rows) {
    const { day, time } = stamp(line.ts);
    if (!keep(day, time)) continue;
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(lineAsShown(line, time, names, shown.get(line.id) ?? []));
  }
  return days;
}

// The board's lines today (the company's day) before the intercom's latest `latest`, by their first words, at most `most`
// of them (the newest): a call's briefing has the latest lines whole, and these show what else the board asked today.
export function boardToday(latest: number, most = 30) {
  const { first: firstLatestId } = db
    .prepare('select min(id) first from (select id from chat order by id desc limit ?)')
    .get(latest) as { first: number | null };
  const stamp = stamper();
  const today = stamp(new Date().toISOString()).day;
  const rows = (
    db
      .prepare(`${shownLines()} where who = 'board' and id < ?4 and ts >= ?5 order by id`)
      .all(...chat.shownAs(), firstLatestId ?? 0, shiftDay(today, -1)) as Line[]
  ).filter(line => stamp(line.ts).day === today);
  return {
    lines: rows.slice(-most).map(line => lineAsShown({ ...line, text: firstWords(line.text) }, stamp(line.ts).time)),
    more: Math.max(0, rows.length - most),
  };
}

function lineAsShown(line: Line, time: string, names = new Map<string, string>(), shown = pictures.ofLine(line.id)) {
  if (line.who === 'call') return `${time} (${line.text})`;
  if (!names.has(line.who))
    names.set(line.who, line.who === 'board' ? 'Board' : String(findAgent(line.who)?.name ?? line.who));
  const speaker = names.get(line.who)!;
  return `${time} ${speaker}: ${chat.withPictures(line.text, shown)}`;
}
const FIRST_WORDS = 14;
const FIRST_CHARS = 100;
function firstWords(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const words = flat.split(' ').slice(0, FIRST_WORDS).join(' ').slice(0, FIRST_CHARS);
  return words.length < flat.length ? `${words}…` : flat;
}

// A line's day (YYYY-MM-DD) and time (HH:MM) on the company's clock
function stamper() {
  const { dayAt, time } = companyFormats();
  return (ts: string) => {
    const ms = Date.parse(ts);
    return { day: dayAt(ms), time: time(ms, 'en') };
  };
}
const isDay = (day: string) => !isNaN(Date.parse(day)) && new Date(day).toISOString().startsWith(day);
const shiftDay = (day: string, by: number) => new Date(Date.parse(day) + by * 86400e3).toISOString().slice(0, 10);
const isClock = (hhmm: string) => /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(hhmm);
const clockOf = (hhmm: string) => hhmm.padStart(5, '0');
