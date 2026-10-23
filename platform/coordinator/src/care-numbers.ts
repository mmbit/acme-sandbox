// Care › Numbers (HQ's own drafts' spend: job #4184): the support chat's own numbers, per app, for the
// board's Care app and for the agents (hq numbers). Counts only: the care service sends a day's integers and sums per app,
// and HQ adds what only it knows: reply times (a person card's arrival to the board's Send, in working days), the busy
// notice and why, open questions and their jobs, and the knowledge base's entries. Nothing here links a number to a
// conversation, a customer or an order.
//
// The care service's side (care's token, as for its cards):
//   POST /api/care/numbers { app: '<slug>' | '<slug>@preview', day: 'YYYY-MM-DD' (the company's day), counts, partial? } → { ok }
//        Stored by (app, day), replacing: a finished day may come again. `partial: true` is today so far: it never
//        replaces a finished day's numbers. Only the counts named below are kept; anything else in the body is dropped.
//        `app: 'hq'` (exactly that) is care's own model calls for HQ: the hello@ email drafts, in no
//        product. Only its spend is kept (model_calls, cost_eur, model): it counts in the month, as care's month cap
//        counts it, shown apart, and is never an app here.
//   GET  /api/care/state's `numbers: ['YYYY-MM-DD', …]`: the days HQ asks care to send again (today, while the board
//        looks at Care › Numbers), each until numbers for it come or an hour goes by
// The board's side (its session):
//   GET  /api/care/numbers                        the apps the chat has numbers or cards for
//   GET  /api/care/numbers?app=<slug>&mode=live|preview   one app's last 28 finished days, today so far, and HQ's own numbers
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync } from 'node:fs';
import { db } from './db.ts';
import { brand, companyDay } from './company.ts';
import { manifest } from './manifests.ts';
import { busy, workingDaysBetween, serviceAuthed, appName, stateHooks, replyDays, PLUGIN_DIR } from './care.ts';

db.exec(`create table if not exists care_numbers (app text not null, day text not null, counts text not null, partial integer not null default 0,
  at text not null, primary key (app, day))`);
db.exec('create table if not exists care_numbers_asks (day text primary key, at integer not null)');

export const DAYS = 28, ASK_MS = 3600e3, FRESH_MS = 15 * 60e3, HQ = 'hq';
const APP = /^[a-z0-9][a-z0-9-]{0,40}(@preview)?$/, DAY = /^\d{4}-\d{2}-\d{2}$/, MODEL = /^[A-Za-z0-9._:@/-]{1,100}$/;
const MAX_N = 10_000_000, MAX_EUR = 100_000, MAX_MS = 3_600_000, OLDEST = 400;
// the counts, as the measures note names them: whole numbers, and first words per kind of reply
// (emails)
const INTS = ['conversations', 'resolved_helped', 'resolved_remedy', 'person_cases', 'question_cases', 'helped_asked', 'helped_yes',
  'helped_no', 'replies_plain', 'replies_lookup', 'outage_minutes', 'cap_minutes', 'model_calls', 'emails'] as const;
const BANDS = ['to_1500', 'to_3000', 'to_5000', 'over_5000'] as const, EDGES = [1500, 3000, 5000];
const KINDS = ['plain', 'lookup'] as const;
type Words = { p50: number | null; p95: number | null; bands: number[] };
type Counts = Partial<Record<(typeof INTS)[number], number>> & { first_words?: Partial<Record<(typeof KINDS)[number], Words>>;
  cost_eur?: number; cost_eur_p95?: number | null; model?: string | null; timing?: Record<string, Record<string, number>> };
// Turn timing (care's numbers.ts took()): a day's histograms, `<provider>.<chat|phone>.<turn|model|tool>.<done|cut|failed>`
// keyed by milliseconds and `<provider>.<channel>.rounds.<done|out>` by rounds;
const SERIES = /^[a-z0-9-]{1,20}\.(chat|phone)\.((turn|model|tool)\.(done|cut|failed)|rounds\.(done|out))$/, SERIES_MAX = 64, STEPS_MAX = 400;

// ---- days, on the company's clock (the care service counts in the same one): companyDay
const isDay = (s: unknown): s is string => typeof s === 'string' && DAY.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const everyDay = (from: string, to: string) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

class Refusal { status: number; why: string; constructor(status: number, why: string) { this.status = status; this.why = why; } }

// ---- what care sends: checked whole; a count of the wrong type refuses the day (care retries, and its log says why)
const whole = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_N;
const euros = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_EUR;
function countsOf(v: any): Counts | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'counts: an object';
  const out: Counts = {};
  // a count care doesn't send yet (a feature not built) stays out, so HQ shows "not counted yet", never a 0
  for (const k of INTS) if (v[k] != null) { if (!whole(v[k])) return `counts.${k}: a whole number`; out[k] = v[k]; }
  if (v.first_words_ms != null) {
    if (typeof v.first_words_ms !== 'object') return 'counts.first_words_ms: { plain, lookup }';
    out.first_words = {};
    for (const kind of KINDS) {
      const w = v.first_words_ms[kind];
      if (w == null) continue;
      if (typeof w !== 'object') return `counts.first_words_ms.${kind}: { p50, p95, ${BANDS.join(', ')} }`;
      for (const p of ['p50', 'p95']) if (w[p] != null && !(Number.isInteger(w[p]) && w[p] >= 0 && w[p] <= MAX_MS)) return `counts.first_words_ms.${kind}.${p}: milliseconds`;
      for (const b of BANDS) if (!whole(w[b] ?? 0)) return `counts.first_words_ms.${kind}.${b}: a whole number`;
      // (care sends 0 for a day without replies: no reply, no percentile)
      const bands = BANDS.map(b => w[b] ?? 0), none = bands.every(x => x === 0);
      out.first_words[kind] = { p50: none ? null : w.p50 ?? null, p95: none ? null : w.p95 ?? null, bands };
    }
  }
  if (v.cost_eur != null) { if (!euros(v.cost_eur)) return 'counts.cost_eur: euros'; out.cost_eur = v.cost_eur; }
  if (v.cost_eur_p95 != null) { if (!euros(v.cost_eur_p95)) return 'counts.cost_eur_p95: euros'; out.cost_eur_p95 = v.cost_eur_p95; }
  if (v.model != null) { if (typeof v.model !== 'string' || !MODEL.test(v.model)) return 'counts.model: a model id'; out.model = v.model; }
  if (v.timing != null) {
    const why = 'counts.timing: { <provider>.<channel>.<what>.<outcome>: { <ms or rounds>: n } }';
    if (typeof v.timing !== 'object' || Array.isArray(v.timing) || Object.keys(v.timing).length > SERIES_MAX) return why;
    out.timing = {};
    for (const [k, steps] of Object.entries<any>(v.timing)) {
      if (!SERIES.test(k) || !steps || typeof steps !== 'object' || Array.isArray(steps) || Object.keys(steps).length > STEPS_MAX) return why;
      for (const [at, n] of Object.entries(steps)) if (!/^\d{1,7}$/.test(at) || +at > MAX_MS || !whole(n)) return why;
      out.timing[k] = steps;
    }
  }
  return out;
}

function take(b: any) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Refusal(400, 'body: a JSON object');
  const today = companyDay(Date.now());
  // (the next day too: care's clock may pass midnight a moment before ours)
  if (!isDay(b.day) || b.day > addDays(today, 1)) throw new Refusal(400, 'day: YYYY-MM-DD, up to today');
  // Care sends its days oldest first and waits on each refusal, so a day HQ has no use for is taken, not kept: an app
  // that isn't one of ours (a test app, one retired), or a day older than Numbers reads
  const hq = b.app === HQ;
  if (typeof b.app !== 'string' || !APP.test(b.app) || !hq && !manifest(b.app.replace(/@preview$/, '')) || b.day < addDays(today, -OLDEST))
    return { ok: true, kept: false };
  if (b.partial != null && typeof b.partial !== 'boolean') throw new Refusal(400, 'partial: true or false');
  // HQ's own drafts: their spend only (a day closed before care sent only that still carries the chat's zeros)
  const counts = countsOf(hq && b.counts && typeof b.counts === 'object' ? { model_calls: b.counts.model_calls, cost_eur: b.counts.cost_eur, model: b.counts.model } : b.counts);
  if (typeof counts === 'string') throw new Refusal(400, counts);
  const partial = b.partial ? 1 : 0, now = new Date().toISOString();
  db.prepare(`insert into care_numbers (app, day, counts, partial, at) values (?, ?, ?, ?, ?) on conflict (app, day) do update
    set counts = excluded.counts, partial = excluded.partial, at = excluded.at where excluded.partial = 0 or care_numbers.partial = 1`)
    .run(b.app, b.day, JSON.stringify(counts), partial, now);
  db.prepare('delete from care_numbers_asks where day = ?').run(b.day);   // asked and had
  return { ok: true };
}

// ---- asking care again: the days in its state's `numbers`
export function asked(t = Date.now()) {
  db.prepare('delete from care_numbers_asks where at < ?').run(t - ASK_MS);
  return (db.prepare('select day from care_numbers_asks order by day').all() as { day: string }[]).map(r => r.day);
}
stateHooks.push(() => { const days = asked(); return days.length ? { numbers: days } : {}; });
// Today so far, while the board looks at Care › Numbers: asked once its numbers are older than a quarter of an hour
function askToday(app: string, t = Date.now()) {
  const day = companyDay(t), row = db.prepare('select at from care_numbers where app = ? and day = ?').get(app, day) as { at: string } | undefined;
  if (row && Date.parse(row.at) > t - FRESH_MS) return;
  db.prepare('insert into care_numbers_asks (day, at) values (?, ?) on conflict (day) do nothing').run(day, t);
}

export async function service(req: IncomingMessage, res: ServerResponse) {
  const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (!serviceAuthed(req.headers.authorization)) { req.resume(); return json(401, { error: 'care token' }); }
  if (req.method !== 'POST') { req.resume(); return json(404, { error: 'not found' }); }
  const parts: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { if ((bytes += chunk.length) > 100_000) return json(413, { error: 'too large' }); parts.push(chunk); }
  let b: unknown;
  try { b = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return json(400, { error: 'json body' }); }
  try { return json(200, take(b)); } catch (e) { if (e instanceof Refusal) return json(e.status, { error: e.why }); throw e; }
}

// ---- reading them back
type Row = { day: string; partial: boolean; at: string; c: Counts };
const rowsOf = (app: string, from: string, to: string) => (db.prepare('select day, counts, partial, at from care_numbers where app = ? and day >= ? and day <= ? order by day')
  .all(app, from, to) as { day: string; counts: string; partial: number; at: string }[]).map(r => ({ day: r.day, partial: !!r.partial, at: r.at, c: JSON.parse(r.counts) as Counts }));
// a sum over the days that have the count; null when none has it (not counted yet, never a 0)
const total = (rows: Row[], f: (c: Counts) => number | null | undefined) => rows.reduce<number | null>((s, r) => { const v = f(r.c); return v == null ? s : (s ?? 0) + v; }, null);
const per100 = (n: number | null, of: number | null) => n == null || !of ? null : Math.round(n / of * 1000) / 10;
const cents = (v: number | null) => v == null ? null : Math.round(v * 100) / 100;
const slugOf = (app: string) => app.replace(/@preview$/, '');

// The targets for first words (brand.yaml's care.numbers.first_words: { plain: [p50, p95], lookup: [p50, p95] },
// in ms). p50/p95 are per day only, so a period is read two ways: from its bands added up (exact where a target sits on a
// band's edge, else a bound), and as the days whose own figure met it.
function targets(rows: Row[]) {
  const t = brand().care?.numbers?.first_words ?? {};
  return KINDS.flatMap(kind => {
    const pair = Array.isArray(t[kind]) ? t[kind] : [];
    const bands = [0, 1, 2, 3].map(i => total(rows, c => c.first_words?.[kind]?.bands[i]) ?? 0), n = bands.reduce((s, x) => s + x, 0);
    // the replies surely at or under ms (bands that end by it), and those that may be (bands that start below it)
    const within = (ms: number) => bands.reduce((s, x, i) => i < EDGES.length && EDGES[i] <= ms ? s + x : s, 0);
    const upTo = (ms: number) => bands.reduce((s, x, i) => i === 0 || EDGES[i - 1] < ms ? s + x : s, 0);
    return (['p50', 'p95'] as const).flatMap((p, i) => {
      const ms = Number(pair[i]);
      if (!Number.isFinite(ms) || ms <= 0) return [];
      const q = p === 'p50' ? 0.5 : 0.95, days = rows.filter(r => r.c.first_words?.[kind]?.[p] != null);
      // met for sure when the replies at or under a band edge below the target are already enough; missed for sure when
      // even counting the whole band the target falls in isn't; in between, the bands can't say
      const met = !n ? null : within(ms) >= q * n ? true : upTo(ms) < q * n ? false : null;
      return [{ kind, p, ms, met, replies: n, daysMet: days.filter(r => r.c.first_words![kind]![p]! <= ms).length, days: days.length }];
    });
  });
}

// HQ's own reply times: each person card that arrived in the period (its finished days, from..to, like the chat's counts), from its arrival to the board's first Send (when the
// email went), in working days on the company's calendar. Within 3 counts against those answered plus those still waiting
// past 3; one still inside its 3 days hasn't been decided yet. A card closed without a reply is counted apart. Waiting now
// is every person card waiting today, whenever it came (or came back with a customer's follow-up), as is the oldest.
function replies(app: string, from: string, to: string, t = Date.now()) {
  const cards = (db.prepare(`select c.created, c.status, (select min(at) from care_lines l where l.card = c.id and l.who = 'board') sent
    from care_cards c where c.kind = 'person' and c.app = ? and c.created >= ?`).all(app, addDays(from, -1)) as { created: string; status: string; sent: string | null }[])
    .filter(c => companyDay(Date.parse(c.created)) >= from && companyDay(Date.parse(c.created)) <= to);
  const answered = cards.filter(c => c.sent).map(c => workingDaysBetween(Date.parse(c.created), Date.parse(c.sent!))).sort((a, b) => a - b);
  const open = cards.filter(c => !c.sent && ['waiting', 'unsure', 'sending', 'mailing'].includes(c.status));
  const late = open.filter(c => workingDaysBetween(Date.parse(c.created), t) > replyDays()).length;
  const within = answered.filter(d => d <= replyDays()).length, decided = answered.length + late;
  const now = db.prepare(`select count(*) n, min(since) since from care_cards where kind = 'person' and app = ? and status in ('waiting', 'unsure')`).get(app) as { n: number; since: string | null };
  return { arrived: cards.length, answered: answered.length, within, late, share: decided ? Math.round(within / decided * 1000) / 10 : null,
    median: answered.length ? answered[Math.floor((answered.length - 1) / 2)] : null, longest: answered.at(-1) ?? null,
    waiting: now.n, closed: cards.filter(c => !c.sent && !open.includes(c)).length,
    oldest: now.since ? { since: now.since, days: workingDaysBetween(Date.parse(now.since), t) } : null, aim: replyDays() };
}

// The knowledge base's entries the app's chat answers from: the shared layer and the app's own (the care plug-in's kb/)
function kb(slug: string) {
  const n = (dir: string) => { try { return readdirSync(`${PLUGIN_DIR}/kb/${dir}`).filter(f => f.endsWith('.md') && f !== 'README.md').length; } catch { return 0; } };
  const shared = n('shared'), own = /^[a-z0-9][a-z0-9-]*$/.test(slug) && slug !== 'shared' ? n(slug) : 0;
  return { entries: shared + own, shared, own };
}

// The month's cost against care's cap (every app and purpose together, HQ's own drafts too, as the cap counts them;
// brand.yaml's care.numbers.cap: the code's cap and the provider console's), today so far in it, with this app's part
// and HQ's drafts' part
function month(app: string, today: string) {
  const m = today.slice(0, 7), rows = (db.prepare("select app, counts from care_numbers where day like ? || '-%'").all(m) as { app: string; counts: string }[])
    .map(r => ({ app: r.app, cost: (JSON.parse(r.counts) as Counts).cost_eur }));
  const sum = (rs: typeof rows) => cents(rs.reduce<number | null>((s, r) => r.cost == null ? s : (s ?? 0) + r.cost, null));
  const cap = brand().care?.numbers?.cap ?? {}, eur = (v: unknown) => typeof v === 'number' && v > 0 ? v : null;
  return { month: m, eur: sum(rows), app: sum(rows.filter(r => r.app === app)), hq: sum(rows.filter(r => r.app === HQ)), cap: eur(cap.month), console: eur(cap.console) };
}

// The emails the email service took for the chat in a month (YYYY-MM): every app's, live and preview. A day is one row,
// so today so far counts once, and its finished numbers replace it. The watch adds them up (mailplan.ts).
export const emailsIn = (month: string) => (db.prepare("select coalesce(sum(json_extract(counts, '$.emails')), 0) n from care_numbers where day like ? || '-%'")
  .get(month) as { n: number }).n;

// One app's chat numbers over finished days (from..to): the totals the screen and the agents' line read
function totals(rows: Row[]) {
  const c = (k: (typeof INTS)[number]) => total(rows, x => x[k]);
  const conversations = c('conversations'), helped = c('resolved_helped'), remedy = c('resolved_remedy');
  const resolved = helped == null && remedy == null ? null : (helped ?? 0) + (remedy ?? 0), person = c('person_cases'), questions = c('question_cases');
  const cost = cents(total(rows, x => x.cost_eur));
  return { conversations, resolved, resolvedHelped: helped, resolvedRemedy: remedy, resolvedRate: per100(resolved, conversations),
    person, personRate: per100(person, conversations), questions, questionRate: per100(questions, conversations),
    helped: { asked: c('helped_asked'), yes: c('helped_yes'), no: c('helped_no') },
    replies: { plain: c('replies_plain'), lookup: c('replies_lookup') },
    bands: Object.fromEntries(KINDS.map(k => [k, [0, 1, 2, 3].map(i => total(rows, x => x.first_words?.[k]?.bands[i]))])),
    outage: c('outage_minutes'), cap: c('cap_minutes'), calls: c('model_calls'), cost,
    perConversation: cost == null || !conversations ? null : Math.round(cost / conversations * 1000) / 1000,
    costP95: rows.reduce<number | null>((m, r) => r.c.cost_eur_p95 == null ? m : Math.max(m ?? 0, r.c.cost_eur_p95), null),
    days: rows.length };
}
const dayView = (r: Row | undefined, day: string) => !r ? { day, none: true } : { day, partial: r.partial, at: r.at,
  ...totals([r]), words: Object.fromEntries(KINDS.map(k => [k, r.c.first_words?.[k] ? { p50: r.c.first_words[k]!.p50, p95: r.c.first_words[k]!.p95 } : null])),
  model: r.c.model ?? null, costP95: r.c.cost_eur_p95 ?? null };

export function detail(slug: string, mode: string, days = DAYS, t = Date.now()) {
  const app = mode === 'preview' ? `${slug}@preview` : slug, today = companyDay(t), to = addDays(today, -1), from = addDays(to, -(days - 1));
  const rows = rowsOf(app, from, to), now = rowsOf(app, today, today)[0], byDay = new Map(rows.map(r => [r.day, r]));
  const latest = [...rows].reverse().find(r => r.c.model);
  const updated = (db.prepare('select max(at) at from care_numbers where app = ?').get(app) as { at: string | null }).at;
  // a question with the team is one whose card says so now (one the team handed back, or past its time, is the board's again)
  // (job_code: its job's code, as HQ names it.)
  const qs = db.prepare(`select c.status card, c.job, j.code job_code, j.status from care_cards c left join jobs j on j.id = c.job where c.kind = 'question' and c.app = ?
    and c.status in ('waiting', 'team', 'sending', 'mailing', 'unsure') order by c.id`).all(app) as { card: string; job: number | null; job_code: string | null; status: string | null }[];
  return { slug, app, name: appName(slug), mode, days, from, to, today, updated,
    totals: totals(rows), daily: everyDay(from, to).map(d => dayView(byDay.get(d), d)), now: now ? dayView(now, today) : null,
    targets: targets(rows), model: latest?.c.model ?? null,
    reply: replies(app, from, to, t), busy: busy(t),
    questions: { open: qs.length, team: qs.filter(q => q.card === 'team').map(q => ({ job: q.job, job_code: q.job_code, status: q.status })), board: qs.filter(q => q.card !== 'team').length },
    kb: kb(slug), month: month(app, today) };
}

// The apps the chat serves: every app with numbers or a card, live and preview apart (one with a manifest: never HQ's own)
export function apps() {
  const seen = (db.prepare('select app from care_numbers union select app from care_cards').all() as { app: string }[]).map(r => r.app);
  const slugs = [...new Set(seen.map(slugOf))].filter(s => manifest(s)).sort();
  return { apps: slugs.map(s => ({ slug: s, name: appName(s), live: seen.includes(s), preview: seen.includes(`${s}@preview`),
    status: manifest(s)?.status === 'live' ? 'live' : 'preview' })) };
}

// Turn timing over the days: each series' histograms added up, as a count, its median, 95th percentile and longest (ms,
// or rounds); null when no day had it counted (before care sent it)
function timing(rows: Row[]) {
  const merged: Record<string, Map<number, number>> = {};
  if (!rows.some(r => r.c.timing)) return null;
  for (const r of rows) for (const [k, steps] of Object.entries(r.c.timing ?? {})) for (const [at, n] of Object.entries(steps))
    (merged[k] ??= new Map()).set(+at, (merged[k].get(+at) ?? 0) + n);
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)).map(([k, m]) => {
    const steps = [...m].sort((a, b) => a[0] - b[0]), n = steps.reduce((s, [, c]) => s + c, 0);
    const at = (p: number) => { let seen = 0; for (const [v, c] of steps) if ((seen += c) >= Math.ceil(p * n)) return v; return null; };
    // Care's 121000 ms step holds every duration above 120000 ms. Its upper bound is unknown.
    const duration = (v: number | null) => !k.includes('.rounds.') && v === 121_000 ? { over: 120_000 } : v;
    return [k, { n, p50: duration(at(0.5)), p95: duration(at(0.95)), max: duration(steps.at(-1)?.[0] ?? null) }];
  }));
}

// The chat's line on an app's dashboard in Numbers, and hq numbers': the same period and mode as the dashboard; null
// when the chat has never counted anything for that app (and for HQ's own drafts, which are no app)
export function line(slug: string, mode: string, days: number, t = Date.now()) {
  const app = mode === 'preview' ? `${slug}@preview` : slug;
  if (slug === HQ || !db.prepare('select 1 from care_numbers where app = ? limit 1').get(app)) return null;
  const to = addDays(companyDay(t), -1), from = addDays(to, -(days - 1)), rows = rowsOf(app, from, to), s = totals(rows), r = replies(app, from, to, t);
  return { app, from, to, conversations: s.conversations, resolved: s.resolved, resolvedRate: s.resolvedRate, person: s.person, personRate: s.personRate,
    questions: s.questions, questionRate: s.questionRate, helped: s.helped, outage: s.outage, cap: s.cap, cost: s.cost, perConversation: s.perConversation,
    reply: { share: r.share, aim: r.aim, answered: r.answered, waiting: r.waiting, oldest: r.oldest?.days ?? null }, kb: kb(slug).entries, timing: timing(rows),
    updated: (db.prepare('select max(at) at from care_numbers where app = ?').get(app) as { at: string | null }).at };
}

// GET /api/care/numbers[?app=&mode=], the board's
export function board(q: Record<string, string>) {
  if (!q.app) return apps();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(q.app) || !manifest(q.app)) return new Refusal(404, 'no such app');
  if (q.mode && q.mode !== 'live' && q.mode !== 'preview') return new Refusal(400, 'mode: live or preview');
  const mode = q.mode || (manifest(q.app)?.status === 'live' ? 'live' : 'preview');
  askToday(mode === 'preview' ? `${q.app}@preview` : q.app);
  return detail(q.app, mode);
}
export const refused = (r: unknown): r is Refusal => r instanceof Refusal;
