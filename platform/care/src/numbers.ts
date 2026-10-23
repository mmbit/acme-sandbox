// The helper's measures: what care counts for HQ's Care › Numbers, and the daily send. Counts only: a tally
// names an app and a day, never a conversation, customer, order or visit, and the day's counts are
// sums. The rest is read from what care keeps anyway (messages, cases, the ledger, and the company's own tools' tables
// through its plug-in's `resolved`) when a day is closed, and only the counts leave. Days are the company's (its time
// zone, company.ts).
import { db, now } from './db.ts';
import { APPS, HQ_APP, PROVIDER } from './config.ts';
import { settings } from './company.ts';

const DAY_MS = 864e5;

// ---- days in the company's time: 'YYYY-MM-DD', and where one starts and ends (23 or 25 hours around a clock change)
const formats = new Map<string, Intl.DateTimeFormat>();
const format = () => {
  const zone = settings.timeZone;
  if (!formats.has(zone)) formats.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  return formats.get(zone)!;
};
const wall = (t: number) => { const p = Object.fromEntries(format().formatToParts(t).map(x => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second); };
export const dayOf = (t: number) => new Date(wall(t)).toISOString().slice(0, 10);
// a day's own midnight: the offset at midnight UTC first, then the offset at that instant (east of UTC the clocks may
// change between the two, as in Pacific/Auckland: one step more finds the offset that holds at local midnight)
const offset = (t: number) => wall(t) - t;
const midnight = (u: number) => u - offset(u - offset(u));
export function bounds(day: string): [number, number] { const u = Date.parse(`${day}T00:00:00Z`); return [midnight(u), midnight(u + DAY_MS)]; }
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ---- tallies: one more of `name` for this app today
export function count(app: string, name: string, t = now()) {
  db.prepare('insert into tallies (app, day, name, n) values (?, ?, ?, 1) on conflict (app, day, name) do update set n = n + 1').run(app, dayOf(t), name);
}

// First words: from the customer's last message of a burst, or the end of their typing, to the helper's
// first bubble. Kept as a day's histogram in 100 ms steps (each step counts the replies up to it), so the day's p50 and
// p95 come out to 100 ms and nothing is kept per reply. Past a minute is one step.
const STEP_MS = 100, TOP_MS = 60_000;
export type Kind = 'plain' | 'lookup';
export function firstWords(app: string, kind: Kind, ms: number, t = now()) {
  count(app, `fw_${kind}:${Math.min(Math.ceil(Math.max(ms, 1) / STEP_MS) * STEP_MS, TOP_MS + STEP_MS)}`, t);
}

// Turn timing: how long the helper's turns take (a chat answer, a phone turn), the model calls and tools in them, and how
// many rounds a finished turn used, what model.ts TURN_ROUNDS is judged by. A day's histograms, nothing per turn: a
// series is `<provider>.<chat|phone>.<turn|model|tool>.<done|cut|failed>` (cut: stopped by the customer or by us, a
// follow-up, no first words in time, a cap; failed: the provider's error or ours), its keys the milliseconds rounded up
// (100 ms steps to 10 s, then seconds to 2 minutes, past that one step), and `<provider>.<channel>.rounds.<done|out>` the
// rounds a finished turn used (out: it reached TURN_ROUNDS with results unread). The provider is the service the calls
// went to (config.ts PROVIDER), so a fake provider's times never read as the real one's; live and preview are apart
// already (the app).
export type Channel = 'chat' | 'phone';
export type Outcome = 'done' | 'cut' | 'failed';
const TIMING_TOP_MS = 120_000;
const timeStep = (ms: number) => { const x = Math.max(ms, 1); return x <= 10_000 ? Math.ceil(x / 100) * 100 : x <= TIMING_TOP_MS ? Math.ceil(x / 1000) * 1000 : TIMING_TOP_MS + 1000; };
export function took(app: string, channel: Channel, what: 'turn' | 'model' | 'tool', outcome: Outcome, ms: number, t = now()) {
  count(app, `tm:${PROVIDER}.${channel}.${what}.${outcome}:${timeStep(ms)}`, t);
}
export function rounds(app: string, channel: Channel, n: number, out: boolean, t = now()) {
  count(app, `tm:${PROVIDER}.${channel}.rounds.${out ? 'out' : 'done'}:${n}`, t);
}
// a turn, model call or tool that threw: stopped (its signal fired, or a cap between rounds) or failed
export const outcomeOf = (signal: AbortSignal, capped = false): Outcome => signal.aborted || capped ? 'cut' : 'failed';
const timing = (tally: Record<string, number>) => {
  const out: Record<string, Record<string, number>> = {};
  for (const [k, n] of Object.entries(tally)) {
    if (!k.startsWith('tm:')) continue;
    const at = k.lastIndexOf(':'), series = k.slice(3, at);
    (out[series] ??= {})[k.slice(at + 1)] = n;
  }
  return out;
};

// The breaker only learns the provider is back when someone asks: past 2 minutes after its last failed try, nobody met
// the outage, so it isn't counted (a quiet night would otherwise count as hours down)
const SEEN_MS = 2 * 60_000;

// ---- when the helper couldn't answer: the breaker (the provider, every app) and the caps (ours; the month's is every app's).
// A period opens at the first sign and closes at the first sign it's over. A cap lifts by itself when its day or month
// ends (`until`), whether or not anyone asks again. A breaker failure more than SEEN_MS after the last one ends the
// period SEEN_MS after that last one, as a call that worked would have, and opens a new one: nobody met the gap.
export function down(kind: 'breaker' | 'cap', app: string, t = now(), until: number | null = null) {
  const open = db.prepare('select id, last from downtime where kind = ? and app = ? and end is null and (until is null or until > ?)').get(kind, app, t) as any;
  if (open && kind === 'breaker' && t - open.last > SEEN_MS) db.prepare('update downtime set end = last + ? where id = ?').run(SEEN_MS, open.id);
  else if (open) { db.prepare('update downtime set last = ? where id = ?').run(t, open.id); return; }
  db.prepare('insert into downtime (kind, app, start, last, until) values (?, ?, ?, ?, ?)').run(kind, app, t, t, until);
}
export function up(kind: 'breaker' | 'cap', app: string, t = now()) {
  db.prepare('update downtime set end = ? where kind = ? and app = ? and end is null and (until is null or until > ?)').run(t, kind, app, t);
}
// The breaker lives in memory: after a restart it's up, and an outage left open ends where its last failed try was
db.prepare("update downtime set end = last where kind = 'breaker' and end is null").run();

function minutes(kind: 'breaker' | 'cap', apps: string[], s: number, e: number) {
  const rows = db.prepare(`select start, last, until, end from downtime where kind = ? and app in (${apps.map(() => '?').join(', ')}) and start < ?
    and coalesce(end, until, ?) > ? order by start`).all(kind, ...apps, e, e, s) as any[];
  let total = 0, reach = s; // the union of the periods, inside the day
  for (const r of rows) {
    const to = Math.min(r.end ?? e, r.until ?? Infinity, kind === 'breaker' ? r.last + SEEN_MS : Infinity, e);
    const from = Math.max(r.start, reach);
    if (to > from) { total += to - from; reach = to; }
  }
  return Math.round(total / 60_000);
}

// ---- one day's counts for one app, exactly as the note lists them (up to t, for a day not over yet)
const one = (sql: string, ...args: any[]) => Number((db.prepare(sql).get(...args) as any)?.n ?? 0);
const rank = (sorted: number[], p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : 0;
const money = (eur: number) => Math.round(eur * 1e4) / 1e4;
const BANDS: [string, number][] = [['to_1500', 1500], ['to_3000', 3000], ['to_5000', 5000], ['over_5000', Infinity]];

export function counts(app: string, day: string, t = now()) {
  const [s, end] = bounds(day), e = Math.min(end, t);
  const tally = Object.fromEntries((db.prepare('select name, n from tallies where app = ? and day = ?').all(app, day) as any[]).map(r => [r.name, r.n]));
  const words = (kind: Kind) => {
    const steps = Object.entries(tally).filter(([k]) => k.startsWith(`fw_${kind}:`)).map(([k, n]) => [Number(k.split(':')[1]), n as number]).sort((a, b) => a[0] - b[0]);
    const n = steps.reduce((x, [, c]) => x + c, 0);
    const at = (p: number) => { const want = Math.ceil(p * n); let seen = 0; for (const [ms, c] of steps) if ((seen += c) >= want) return ms; return 0; };
    const bands = Object.fromEntries(BANDS.map(([k]) => [k, 0]));
    for (const [ms, c] of steps) bands[BANDS.find(([, top]) => ms <= top)![0]] += c;
    return { n, ms: { p50: n ? at(0.5) : 0, p95: n ? at(0.95) : 0, ...bands } };
  };
  const plain = words('plain'), lookup = words('lookup');
  const perConversation = (db.prepare('select sum(eur) as eur from ledger where app = ? and at >= ? and at < ? and conversation is not null group by conversation')
    .all(app, s, e) as any[]).map(r => r.eur).sort((a, b) => a - b);
  return {
    // a customer's own words that day (a tap is words too), in this app's stall (a shop's conversation counts in each
    // stall it was in that day; one from before kept no stall: its shop's); the
    // greeting alone isn't a conversation
    conversations: one(`select count(distinct m.conversation) as n from messages m join conversations c on c.id = m.conversation
      where coalesce(m.app, c.shop) = ? and m.who = 'me' and m.text != '' and m.at >= ? and m.at < ?`, app, s, e),
    resolved_helped: tally.helped_yes ?? 0,
    // a conversation the company's own tools resolved that day without a person (a remedy done, say; its plug-in's
    // `resolved`), and not one whose "Did this help?" was answered: that answer counts above
    resolved_remedy: settings.resolved(app, s, e),
    person_cases: one("select count(*) as n from cases where app = ? and kind = 'person' and created >= ? and created < ?", app, s, e),
    question_cases: one("select count(*) as n from cases where app = ? and kind = 'question' and created >= ? and created < ?", app, s, e),
    helped_asked: tally.helped_asked ?? 0, helped_yes: tally.helped_yes ?? 0, helped_no: tally.helped_no ?? 0,
    // the emails the email service took for this app (email.ts), against its plan's monthly limit.
    emails: tally.emails ?? 0,
    replies_plain: plain.n, replies_lookup: lookup.n,
    first_words_ms: { plain: plain.ms, lookup: lookup.ms },
    outage_minutes: minutes('breaker', [''], s, e),
    cap_minutes: minutes('cap', [app, ''], s, e),
    ...spend(app, s, e),
    cost_eur_p95: money(rank(perConversation, 0.95)),
    timing: timing(tally),
  };
}
// What an app's model calls cost from s to e.
function spend(app: string, s: number, e: number) {
  const total = db.prepare('select coalesce(sum(eur), 0) as eur from ledger where app = ? and at >= ? and at < ?').get(app, s, e) as { eur: number };
  // the model it called most (none, when it called none)
  const top = db.prepare('select model, count(*) as n from ledger where app = ? and at >= ? and at < ? group by model order by n desc, model limit 1')
    .get(app, s, e) as { model: string } | undefined;
  return {
    model_calls: one('select count(*) as n from ledger where app = ? and at >= ? and at < ?', app, s, e),
    cost_eur: money(total.eur),
    model: top?.model ?? null,
  };
}
// One day's numbers for HQ: an app's counts. HQ's own drafts have no chat: only what they cost, for the month (a 0 would
// read as counted).
function dayNumbers(app: string, day: string, t: number) {
  if (app !== HQ_APP) return counts(app, day, t);
  const [s, end] = bounds(day);
  return spend(app, s, Math.min(end, t));
}

// ---- closing days: each finished day's counts, per app (every app care serves, and any other that had something that
// day), stored once, so what HQ gets doesn't change when a chat is deleted later. From the day after the last one
// closed; the first time, from the earliest day care still has anything for (a month at most).
export function close(t = now()) {
  const today = dayOf(t);
  const last = (db.prepare('select max(day) as d from numbers').get() as any)?.d as string | null;
  let day = last ? nextDay(last) : dayOf(Math.max(t - 31 * DAY_MS, earliest(t)));
  const put = db.prepare('insert or ignore into numbers (app, day, counts, made) values (?, ?, ?, ?)');
  for (; day < today; day = nextDay(day)) {
    const [s, e] = bounds(day);
    const busy = (db.prepare(`select coalesce(m.app, c.shop) as app from messages m join conversations c on c.id = m.conversation where m.who = 'me' and m.at >= ? and m.at < ?
      union select app from ledger where at >= ? and at < ? union select app from tallies where day = ? union select app from cases where created >= ? and created < ?`)
      .all(s, e, s, e, day, s, e) as any[]).map(r => r.app);
    for (const app of new Set([...Object.keys(APPS), ...busy])) put.run(app, day, JSON.stringify(dayNumbers(app, day, t)), t);
  }
}

function earliest(t: number) {
  const ts = ['select min(at) as t from messages', 'select min(at) as t from ledger', 'select min(created) as t from cases', 'select min(start) as t from downtime']
    .map(q => (db.prepare(q).get() as any)?.t).filter((x): x is number => x != null);
  const d = (db.prepare('select min(day) as d from tallies').get() as any)?.d;
  if (d) ts.push(bounds(d)[0]);
  return Math.min(t, ...ts);
}

// What goes to HQ next: the closed days it hasn't had yet, oldest first
export const unsent = (n = 20) => (db.prepare('select app, day, counts from numbers where sent is null order by day, app limit ?').all(n) as any[])
  .map(r => ({ app: r.app as string, day: r.day as string, counts: JSON.parse(r.counts) }));
export const sent = (app: string, day: string, t = now()) => { db.prepare('update numbers set sent = ? where app = ? and day = ?').run(t, app, day); };

// HQ asks again (its state's `numbers`: the days it wants): a closed day goes again as it was closed; today goes as it
// stands so far (partial), never stored. Returns today's, to send now.
export function again(days: unknown, t = now()) {
  if (!Array.isArray(days)) return [];
  const today = dayOf(t), out: { app: string; day: string; counts: any; partial: true }[] = [];
  for (const d of days.slice(0, 62)) {
    const day = String(d);
    if (!DAY.test(day) || day > today) continue;
    if (day < today) { db.prepare('update numbers set sent = null where day = ?').run(day); continue; }
    const [s] = bounds(day);
    const busy = (db.prepare(`select coalesce(m.app, c.shop) as app from messages m join conversations c on c.id = m.conversation where m.who = 'me' and m.at >= ?
      union select app from ledger where at >= ? union select app from tallies where day = ?`).all(s, s, day) as any[]).map(r => r.app);
    for (const app of new Set([...Object.keys(APPS), ...busy])) out.push({ app, day, counts: dayNumbers(app, day, t), partial: true });
  }
  return out;
}
