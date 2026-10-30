// The profiler's switch and readings (shared/profile/README.md): while it's on for a host, the board's pages there run
// shared/profile/profile.js after review.js and send their samples here, and hq profile reads each page's session back.
import { readFile } from 'node:fs/promises';
import { REPO_DIR } from './config.ts';
import { db, setting, remember } from './db.ts';

export const ALL = 'all';
// On for a day unless told, and for a week at most: as long as samples are kept, so a switch never outlives its read
export const HOURS = { given: 24, most: 7 * 24 };
const KEPT_MS = HOURS.most * 3600_000;
const SAMPLES_SENT = 30;
const SAMPLE_CHARACTERS = 4000;
const PAGE_CHARACTERS = 300;
const DEVICE_CHARACTERS = 2000;
const STATES = 6; // the views a session showed, first seen first
const LISTED_MS = 24 * 3600_000; // hq profile's sessions unless told: the last day
const LATEST_TIME = 8.64e15; // the furthest a Date reaches

db.exec(`create table if not exists profile_sessions (session text primary key, slug text not null, page text not null,
  device text not null, began integer not null, last integer not null)`);
db.exec(
  'create table if not exists profile_samples (session text not null, at integer not null, sample text not null)',
);
db.exec('create index if not exists profile_samples_session on profile_samples (session, at)');
db.exec('create index if not exists profile_sessions_last on profile_sessions (last)');

// ---- the switch: per host (hq, a product's slug) or all of them, until a time
const key = (where: string) => `profile:${where}`;
const until = (where: string) => Number(setting(key(where))) || 0;
export const isOn = (slug: string, now = Date.now()) => until(slug) > now || until(ALL) > now;

export function switchOn(where: string, hours: number, now = Date.now()) {
  if (!(hours > 0 && hours <= HOURS.most)) return `--hours is more than 0 and at most ${HOURS.most} (a week)`;
  remember(key(where), String(now + hours * 3600_000));
  return { where, until: new Date(now + hours * 3600_000).toISOString() };
}
export function switchOff(where: string | null) {
  if (where && where !== ALL) remember(key(where), null);
  else db.prepare("delete from settings where key like 'profile:%'").run();
  return { switched: switchedOn() };
}
export const switchedOn = (now = Date.now()) =>
  (db.prepare("select key, value from settings where key like 'profile:%'").all() as { key: string; value: string }[])
    .filter(s => Number(s.value) > now)
    .map(s => ({ where: s.key.slice('profile:'.length), until: new Date(Number(s.value)).toISOString() }));

// The script that goes after review.js for the board's page on a host the switch is on for, else nothing
export const scriptFor = async (slug: string) =>
  isOn(slug) ? `\n${await readFile(`${REPO_DIR}/shared/profile/profile.js`, 'utf8')}` : '';

// ---- the readings: a page's post (profile.js send), checked as outside input and refused whole when it's off shape,
// so every kept session reads back
const SESSION = /^[0-9a-f-]{36}$/;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export function record(slug: string, body: any, now = Date.now()) {
  const { session, page, device = {}, samples } = body ?? {};
  const sampleTexts = Array.isArray(samples) ? samples.map(s => JSON.stringify(s)) : [];
  const deviceText = JSON.stringify(device);
  const samplesFit =
    sampleTexts.length >= 1 &&
    sampleTexts.length <= SAMPLES_SENT &&
    samples.every((s: unknown) => isRecord(s) && Number.isFinite(s.at) && Math.abs(s.at as number) <= LATEST_TIME) &&
    sampleTexts.every(s => s.length <= SAMPLE_CHARACTERS);
  const deviceFits = isRecord(device) && deviceText.length <= DEVICE_CHARACTERS;
  const pageFits = typeof page === 'string' && page.length <= PAGE_CHARACTERS;
  if (!SESSION.test(String(session)) || !pageFits || !samplesFit || !deviceFits)
    return [
      400,
      `a session id, the page in at most ${PAGE_CHARACTERS} characters, a device of at most ${DEVICE_CHARACTERS} characters and 1 to ${SAMPLES_SENT} samples ` +
        `of at most ${SAMPLE_CHARACTERS} characters each, each with its time (at, ms since 1970)`,
    ] as const;
  db.prepare(
    `insert into profile_sessions (session, slug, page, device, began, last) values (?, ?, ?, ?, ?, ?)
     on conflict(session) do update set last = excluded.last`,
  ).run(session, slug, page, deviceText, now, now);
  const insert = db.prepare('insert into profile_samples (session, at, sample) values (?, ?, ?)');
  for (const s of sampleTexts) insert.run(session, now, s);
  prune(now);
  return { kept: sampleTexts.length };
}
let pruned = 0;
function prune(now: number) {
  if (now - pruned < 3600_000) return;
  pruned = now;
  db.prepare('delete from profile_samples where session in (select session from profile_sessions where last < ?)').run(
    now - KEPT_MS,
  );
  db.prepare('delete from profile_sessions where last < ?').run(now - KEPT_MS);
}

// ---- reading them back (hq profile): every session since a time, newest first, or one session's samples
type Session = { session: string; slug: string; page: string; device: string; began: number; last: number };
export function listSessions(where: string | null, since = Date.now() - LISTED_MS) {
  const rows = db
    .prepare('select * from profile_sessions where last >= ? and (? is null or slug = ?) order by began desc')
    .all(since, where, where) as Session[];
  const ended = new Map(
    rows
      .map(r => JSON.parse(r.device).previous)
      .filter(Boolean)
      .map(p => [p.session, p]),
  );
  return rows.map(r => ({ ...summaryOf(r, samplesOf(r.session)), ended: ended.get(r.session) ?? null }));
}
export const samplesOf = (session: string) =>
  (
    db.prepare('select sample from profile_samples where session = ? order by at, rowid').all(session) as {
      sample: string;
    }[]
  ).map(s => JSON.parse(s.sample));

// What one session says: each count's first, last and highest value and its change per hour, the regions and
// listener types that grew most, the slow frames in its first and last quarter (lag that builds up), and the frames
// while a pointer was held down. Those show a drag's lag, which the counts of all a sample's frames dilute
const COUNTS = [
  'heap',
  'nodes',
  'canvases',
  'canvasMb',
  'webgl',
  'audio',
  'resize',
  'mutation',
  'intersection',
  'intervals',
  'timeouts',
  'animationFrames',
];
function summaryOf(row: Session, samples: any[]) {
  const device = JSON.parse(row.device);
  const counts: Record<string, Trend> = Object.fromEntries(
    COUNTS.filter(name => samples.some(s => typeof s[name] === 'number')).map(name => [
      name,
      trend(samples, s => s[name]),
    ]),
  );
  counts.listeners = trend(samples, s => total(s.listeners));
  const quarter = Math.max(1, Math.floor(samples.length / 4));
  return {
    session: row.session,
    slug: row.slug,
    page: row.page,
    agent: device.agent,
    screen: device.screen,
    deviceMemory: device.memory,
    after: device.previous ?? null,
    began: new Date(samples[0]?.at ?? row.began).toISOString(),
    minutes: samples.length ? Math.round((samples.at(-1).at - samples[0].at) / 60_000) : 0,
    samples: samples.length,
    counts,
    grewMost: { regions: grown(samples, s => s.regions), listeners: grown(samples, s => s.listeners) },
    slowFrames: {
      first: slowShare(samples.slice(0, quarter), allFrames),
      last: slowShare(samples.slice(-quarter), allFrames),
    },
    longTasks: { count: sum(samples, s => s.longTasks?.count), worst: worst(samples, s => s.longTasks) },
    worstFrame: worst(samples, allFrames),
    held: {
      shown: sum(samples, s => s.held?.shown),
      slow: slowShare(samples, heldFrames),
      worst: worst(samples, heldFrames),
    },
    states: [...new Set(samples.map(s => s.state))].slice(0, STATES),
  };
}

type Trend = { first: number; last: number; most: number; perHour: number } | null;
// A count's first, last and highest value, and its change per hour (least squares)
function trend(samples: any[], valueOf: (s: any) => unknown): Trend {
  const points = samples.map(s => [s.at, valueOf(s)]).filter((p): p is [number, number] => typeof p[1] === 'number');
  if (!points.length) return null;
  const values = points.map(p => p[1]);
  return {
    first: values[0],
    last: values.at(-1)!,
    most: Math.max(...values),
    perHour: round(slope(points) * 3600_000),
  };
}
function slope(points: [number, number][]) {
  if (points.length < 2) return 0;
  const mean = (f: (p: [number, number]) => number) => points.reduce((s, p) => s + f(p), 0) / points.length;
  const [mx, my] = [mean(p => p[0]), mean(p => p[1])];
  const spread = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  return spread ? points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / spread : 0;
}
// The names (regions, listener types) whose counts grew most from the first sample to the last
function grown(samples: any[], countsOf: (s: any) => Record<string, number> | undefined) {
  const [first, last] = [countsOf(samples[0]) ?? {}, countsOf(samples.at(-1)) ?? {}];
  return Object.entries(last)
    .map(([name, n]) => [name, n - (first[name] ?? 0)] as const)
    .filter(([, change]) => change > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, change]) => ({ name, from: first[name] ?? 0, to: last[name], change }));
}
// A sample's frame counts (shown, slow, worst), of every frame or of those while a pointer was held
type Frames = { shown: number; slow: number; worst: number } | undefined;
const allFrames = (s: any): Frames => s.frames;
const heldFrames = (s: any): Frames => s.held;
const slowShare = (samples: any[], framesOf: (s: any) => Frames) => {
  const shown = sum(samples, s => framesOf(s)?.shown);
  return shown ? round((100 * sum(samples, s => framesOf(s)?.slow)) / shown) : null;
};
const worst = (samples: any[], measureOf: (s: any) => { worst: number } | undefined) =>
  Math.max(0, ...samples.map(s => measureOf(s)?.worst ?? 0));
const total = (counts: Record<string, number> | undefined) =>
  counts ? Object.values(counts).reduce((s, n) => s + n, 0) : undefined;
const sum = (samples: any[], f: (s: any) => number | undefined) => samples.reduce((s, x) => s + (f(x) ?? 0), 0);
const round = (n: number) => Math.round(n * 10) / 10;
