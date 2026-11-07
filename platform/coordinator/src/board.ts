// The board's profile: the one person who runs the company, its day, its work, its time and how it wants to hear from us
// (company/board.yaml; the foundation's recommended structure is template/company/board.yaml). HQ reads it before anything
// reaches the board: a push in its quiet hours waits until it's up (push.ts), a card filed then says so to its author
// (jobs.ts createRequest), the time to tell the board that falls while it sleeps is "by the time it's up" (outlooks.ts,
// when.ts, estimates.ts), and calls, the intercom and the card reader have it in their briefing (call.ts, chat.ts,
// cardread.ts).
// No profile: no quiet hours, and nothing changes. board.ts imports nothing of HQ's but the readers of its files: push.ts
// imports it, and much of HQ (company.ts, jobs.ts) imports push.ts, so any more would close a cycle through it.
import { optional, parsed } from './companyfiles.ts';
import { momentIn, namedZone, zoneOf } from './clock.ts';

const FILE = 'company/board.yaml';
const DAY_MS = 24 * 3600_000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
// A part of the week: its mornings, and the nights before them (Friday's and Saturday's nights are the weekend's)
type Part = { up: number; quiet: number | null; work: number | null };
export type Profile = {
  zone: string;
  weekdays: Part;
  weekends: Part;
  askedMinutes: number; // minutes past the start of quiet in which something the board asked for still reaches it
  who: string;
  work: string;
  time: string;
  preferences: string[];
};

// The profile as HQ reads it, or null without one (a missing or empty file). Its zone is the company's (org.yaml) unless
// it names its own. A file that doesn't parse, a key it doesn't know, or a value that isn't one HQ reads throws: the
// profile decides what rings the board at night, so a typo in it is fixed there, never read as no quiet hours. HQ reads
// it as it starts (server.ts), so a bad file fails startup.
export function profile(): Profile | null {
  const { value: p, error, empty } = parsed(FILE);
  if (empty) return null;
  if (error) throw error;
  if (!Object.keys(p).length) return null;
  keysOf('', p, ['zone', 'rhythm', 'who', 'work', 'time', 'preferences']);
  const rhythm = keysOf('rhythm', p.rhythm, ['weekdays', 'weekends', 'asked']);
  const zone = p.zone == null ? zoneOf(optional('company/org.yaml')) : namedZone(p.zone, `${FILE}: zone`);
  const askedMinutes = rhythm.asked ?? 0;
  if (typeof askedMinutes !== 'number' || !Number.isFinite(askedMinutes) || askedMinutes < 0)
    throw misread('rhythm.asked', askedMinutes, 'a number of minutes (0 or more)');
  if (p.preferences != null && !Array.isArray(p.preferences))
    throw misread('preferences', p.preferences, 'a list, one line each');
  const weekdays = part('rhythm.weekdays', rhythm.weekdays, { up: 8 * 60, quiet: null, work: null });
  return {
    zone,
    weekdays,
    weekends: part('rhythm.weekends', rhythm.weekends, { ...weekdays, work: null }), // (a weekday's up and quiet, never its work)
    askedMinutes,
    who: words(p.who),
    work: words(p.work),
    time: words(p.time),
    preferences: (p.preferences ?? []).map(words).filter(Boolean),
  };
}

// A mapping in the file (name: its key, '' for the whole file), {} when it's left out, checked to hold only the keys known
function keysOf(name: string, v: unknown, known: string[]): Record<string, any> {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw misread(name, v, 'a mapping of keys to values');
  const unknown = Object.keys(v).filter(key => !known.includes(key));
  if (unknown.length)
    throw new Error(`${FILE}: ${name || 'the file'} has no key ${unknown.join(', ')} (its keys: ${known.join(', ')})`);
  return v;
}
// One part of the week (name: its key), each time it leaves out taken from defaults
function part(name: string, v: unknown, defaults: Part): Part {
  const given = keysOf(name, v, ['up', 'quiet', 'work']);
  const time = (key: keyof Part) => (given[key] == null ? defaults[key] : minutes(`${name}.${key}`, given[key]));
  return { up: time('up')!, quiet: time('quiet'), work: time('work') };
}
// '08:00' as minutes past midnight
function minutes(key: string, v: unknown) {
  const m = TIME.exec(typeof v === 'string' ? v.trim() : '');
  if (!m) throw misread(key, v, 'a time (HH:MM)');
  return Number(m[1]) * 60 + Number(m[2]);
}
const words = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
// The error for a value of the file's that HQ can't read as what it should be
const misread = (key: string, v: unknown, what: string) =>
  new Error(`${FILE}: ${key} ${JSON.stringify(v)} isn't ${what}`);

// A day on the zone's clock, as UTC midnight of its date (for counting days and reading its weekday). One formatter per
// zone: every deliverable's time to tell the board reads it (outlooks.ts), and making one takes ~0.2 ms.
const dayFormats = new Map<string, Intl.DateTimeFormat>();
function dayOf(zone: string, at: number) {
  if (!dayFormats.has(zone))
    dayFormats.set(
      zone,
      new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }),
    );
  const parts = Object.fromEntries(
    dayFormats
      .get(zone)!
      .formatToParts(at)
      .map(p => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}
const isWeekend = (day: number) => [0, 6].includes(new Date(day).getUTCDay());
const partOf = (p: Profile, day: number) => (isWeekend(day) ? p.weekends : p.weekdays);
const at = (zone: string, day: number, mins: number) => {
  const d = new Date(day);
  return momentIn(zone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(mins / 60), mins % 60);
};

// The night before a day: from its quiet time (the evening before it, or that morning for a time before up, 00:30 say)
// until the board is up that day. None for a part of the week without quiet.
function night(p: Profile, day: number) {
  const { up, quiet } = partOf(p, day);
  if (quiet === null) return null;
  return { from: at(p.zone, quiet > up ? day - DAY_MS : day, quiet), until: at(p.zone, day, up) };
}

// Whether `when` falls in the board's quiet hours, and when it's up again; null when it doesn't (or there's no profile).
// askedFor: it's something the board asked for, which still reaches it in the first minutes of quiet (askedMinutes).
export function quiet(when = Date.now(), askedFor = false, p = profile()): { until: number } | null {
  if (!p) return null;
  const today = dayOf(p.zone, when);
  for (const day of [today, today + DAY_MS]) {
    const n = night(p, day);
    if (n && when >= n.from + (askedFor ? p.askedMinutes * 60_000 : 0) && when < n.until) return { until: n.until };
  }
  return null;
}

// The time to tell the board for a finish: when it falls in the board's quiet hours, the board is told "by the time you're
// up", and this is that time; otherwise null
export const upAfter = (finish: number | null, p = profile()) =>
  finish === null ? null : (quiet(finish, false, p)?.until ?? null);

// The board's profile as a briefing reads it (a call's, the intercom's), or '' without one. now: where its day stands then,
// for a briefing read at once (a call's); the intercom's session lives for hours, and the board is there when it talks.
export function briefing(now?: number) {
  const p = profile();
  if (!p) return '';
  const clock = (mins: number | null) =>
    mins === null ? null : `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  const day = (name: string, q: Part) =>
    `- ${name}: up at ${clock(q.up)}${q.work !== null ? `, at work from ${clock(q.work)}` : ''}${q.quiet !== null ? `, quiet at night from ${clock(q.quiet)}` : ''}`;
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: p.zone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
  const still = now === undefined ? null : quiet(now, false, p);
  const nowLine =
    now === undefined
      ? []
      : still
        ? [`Now it's ${local.format(now)} on its clock, in its quiet hours until ${local.format(still.until)}.`]
        : [`Now it's ${local.format(now)} on its clock, outside its quiet hours.`];
  const lines = [
    ...(p.who ? [`Who: ${p.who}`] : []),
    ...(p.work ? [`Work: ${p.work}`] : []),
    ...(p.time ? [`Time for the company: ${p.time}`] : []),
    `Its day (${p.zone}; the weekend's nights are Friday's and Saturday's):`,
    day('Weekdays', p.weekdays),
    day('Weekends', p.weekends),
    ...(p.preferences.length ? ['How it wants to hear from us:', ...p.preferences.map(l => `- ${l}`)] : []),
    `In its quiet hours nothing HQ sends rings its devices (cards, posts, warnings): they wait until it's up${p.askedMinutes ? `, but what it asked for still does in the first ${p.askedMinutes} minutes` : ''}. A time to tell it that lands while it sleeps is "by the time you're up".`,
    ...nowLine,
  ];
  return `## The board\n${lines.join('\n')}\n\n`;
}
