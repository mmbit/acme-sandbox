// The back office for counting: product apps push their daily tallies and order summaries here (the kit in
// shared/metrics/), and HQ's Numbers app and the agents (hq numbers) read them back, with each A/B test's standing.
//
// Numbers per day only (charter rule 7): never a row per visitor, no IP is read, nothing personal is kept, and request
// bodies are never logged. Each app describes itself in products/<slug>/app/metrics.json (its steps, dashboard sections,
// margins, targets and tests).
//
//   POST /api/metrics/push  {batch, counts: [{day, step, variant, campaign, country, what, n}],
//                            orders?: {from, to, made, objected?, rows: [{day, variant, campaign, country, what, orders, paid,
//                                                                         refunded, kept, eur, net, netUnknown?}]}}
//     Headers: authorization: Bearer <METRICS_TOKEN>, x-product: <slug>, x-mode: live|preview.
//     Counts add up, a batch's once. Order rows replace the app's rows (that mode) for the days from..to, a batch sent
//     again included, unless HQ has taken a summary made later (made: the app's time in ms).
//     The answer is {ok, duplicate?, ordersDue?}: ordersDue asks for an order summary at the next push. A campaign stays
//     only on page loads, visitors and visits, and order rows (see "sources").
//     visitor and visit are steps every app may send without listing them (the kit's page() counts them, with
//     METRICS_VISITORS on): new visitors and new visits, each with its page load's source. So is load: every load of a
//     page, a person's or a crawler's, a fetcher's or a prefetch, with where it came from in its campaign (the kit's
//     loadSource and fetchedBy). (load)
//     basket and checkout are steps HQ counts itself, once an order, for every app whose orders go in the shop's
//     basket (lineSteps, below): an app lists them in metrics.json to show them.
//     (visitor and visit)
//     objected (a day from..to, or null): the last day with an order whose buyer objected to its source. Every app's
//     page loads in that mode lose their source through that day (see "sources").
//     net adds up the kept orders whose net the app knows; netUnknown (0 if left out) counts the kept orders whose net
//     it doesn't. A dashboard's net is null while any is unknown.
//     orders.to is the app's day when it made the summary (shared/metrics summarize), so the days before it had
//     ended: their orders are all in, however late a retried push brings them.
//   GET /api/numbers                              every app's line, and the shop's baskets (the board's login)
//   GET /api/numbers/<slug>?days=28&mode=live     one app's dashboard (days 1..400)
//   GET /api/agent/numbers?app=&days=&mode=       the same for jobs and calls (hq numbers)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { REPO_DIR, RUN_DIR } from './config.ts';
import { db } from './db.ts';
import { basketsByDay, lineSteps, signed, testerOrders } from './payments.ts';
import { manifest } from './manifests.ts';
import { FRONT } from './approvals.ts';
import { companyDay } from './company.ts';
import { parseJson, readBody } from '../../../shared/routes/routes.ts';

// metric_order_days: the day the last order summary that covered each day was made
db.exec(`
  create table if not exists metric_counts (product text not null, mode text not null, day text not null, step text not null,
    variant text not null, campaign text not null, country text not null, what text not null, n integer not null,
    primary key (product, mode, day, step, variant, campaign, country, what));
  create table if not exists metric_orders (product text not null, mode text not null, day text not null, variant text not null,
    campaign text not null, country text not null, what text not null, orders integer not null, paid integer not null,
    refunded integer not null, kept integer not null, cents integer not null, net_cents integer not null,
    net_unknown integer not null default 0, primary key (product, mode, day, variant, campaign, country, what));
  create table if not exists metric_batches (product text not null, mode text not null, batch text not null, at integer not null,
    primary key (product, mode, batch));
  create table if not exists metric_pushes (product text not null, mode text not null, at text not null, primary key (product, mode));
  create table if not exists metric_order_days (product text not null, mode text not null, day text not null, summary_day text not null,
    primary key (product, mode, day));
  create table if not exists metric_summaries (product text not null, mode text not null, made integer not null, objected text,
    primary key (product, mode));
  create table if not exists metric_objection (token text not null);
  create table if not exists metric_page_cutoff (through text not null);
  drop table if exists metric_stops;
`);

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/,
  STEP = /^[a-z][a-z0-9-]{0,23}$/,
  WORD = /^[a-z0-9-]{1,40}$/,
  COUNTRY = /^[A-Z]{2}$/;
const BATCH = /^[a-f0-9]{32}$/,
  LETTER = /^[A-Z]$/,
  DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 1_000_000,
  MAX_ROWS = 5_000,
  MAX_N = 1_000_000,
  MAX_EUR = 10_000_000;
// The steps the kit counts on every page load (shared/metrics LANDING), a source kept on each: visitor, visit and load
// needn't be in metrics.json. (load)
const LANDING = ['page', 'visitor', 'visit', 'load'];
const PER_HOUR = 120; // pushes per product, mode and hour: the kit sends 12, plus its retries
const BATCH_DAYS = 7,
  ORDER_DAYS = 120,
  FRESH_MS = 5_000;
const HOME_DAYS = 28,
  MAX_DAYS = 400;
// A test is called only after its finish line and two full weeks; without a winner after six weeks, A stays.
const MIN_DAYS = 14,
  MAX_TEST_DAYS = 42,
  CONFIDENCE = 0.05,
  DRIFT = 0.001;
// A product's slug (exported for the ad spend)
export const isSlug = (s: string) => SLUG.test(s);

// ---- days: the apps count in the company's days (its clock, company.ts, which infra/products.py gives them); the push's
// window is checked in UTC (a day either side covers the offset).
const companyToday = () => companyDay(Date.now());
// (isDay, addDays and daysFrom exported for the ad spend and the watch)
const utcToday = () => new Date().toISOString().slice(0, 10);
export const isDay = (s: unknown): s is string =>
  typeof s === 'string' &&
  DAY.test(s) &&
  !isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const daysFrom = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const everyDay = (from: string, to: string) =>
  Array.from({ length: daysFrom(from, to) + 1 }, (_, i) => addDays(from, i));

// ---- sources: a campaign on an order row, or on the count of any step but the
// page load (and its visitor and visit), can point to one buyer (a day with one order). HQ keeps one only as the app's latest summary has it, and
// for at most SOURCE_DAYS: a day's sources go once its first moment is that old, on the minute and as a push arrives.
// A start folds every source into the day's rows without one (a restored copy can hold a source the app has cleared
// since) and asks each app for a summary, which brings back what it still has. Totals stay whole.
// A page load's source can point to the same buyer (one visit and one order that day, on the app or on a site that
// links to it), and no app can send it again. It goes after SOURCE_DAYS too, and through the day of an order whose
// buyer objected, on every app of that mode, as each push arrives. A start keeps page sources only when its database
// holds every objection HQ took on this host (see "objections" below), however HQ stopped. Any other start (a restored
// copy taken before an objection, another host, a reboot) folds them all, and every page load through its day
// that arrives later (a batch the copy never had) loses its source too (metric_page_cutoff), since the copy may lack an
// objection the original had taken.
const SOURCE_DAYS = 60; // shared/metrics's SOURCE_DAYS
const SOURCE_CHECK_MS = 60_000;
const TOKEN_FILE = RUN_DIR && `${RUN_DIR}/metrics-objection`;
const EVERY_DAY = '9999-12-31';
// apps whose summary HQ has taken since this start
const summarized = new Set<string>();

// The last day whose sources go by the next check: its first moment is SOURCE_DAYS old by then
const expiredDay = (now: number) => companyDay(now + SOURCE_CHECK_MS - SOURCE_DAYS * 864e5);

const ORDER_SUMS = ['orders', 'paid', 'refunded', 'kept', 'cents', 'net_cents', 'net_unknown'];
function sweepSources(through = expiredDay(Date.now()), pagesThrough = through) {
  db.exec('begin');
  try {
    foldSources(through, pagesThrough);
    db.exec('commit');
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
}

// Every source into the same row without one: on an order row through that day, on a count of any step but the page
// load and its visitor and visit, and on those through pagesThrough, its mode's objected day or the last start's cutoff
const FOLDED_COUNTS = `campaign != '' and (step not in (${LANDING.map(l => `'${l}'`).join(', ')}) or day <= max(:pagesThrough, coalesce((select max(objected) from metric_summaries s
  where s.mode = metric_counts.mode), ''), coalesce((select max(through) from metric_page_cutoff), '')))`;
function foldSources(through: string, pagesThrough = through) {
  const sums = ORDER_SUMS.map(c => `sum(${c})`).join(', '),
    added = ORDER_SUMS.map(c => `${c} = ${c} + excluded.${c}`).join(', ');
  db.prepare(
    `insert into metric_orders (product, mode, day, variant, campaign, country, what, ${ORDER_SUMS.join(', ')})
    select product, mode, day, variant, '', country, what, ${sums} from metric_orders where campaign != '' and day <= ?
    group by product, mode, day, variant, country, what
    on conflict (product, mode, day, variant, campaign, country, what) do update set ${added}`,
  ).run(through);
  db.prepare("delete from metric_orders where campaign != '' and day <= ?").run(through);
  db.prepare(
    `insert into metric_counts (product, mode, day, step, variant, campaign, country, what, n)
    select product, mode, day, step, variant, '', country, what, sum(n) from metric_counts where ${FOLDED_COUNTS}
    group by product, mode, day, step, variant, country, what
    on conflict (product, mode, day, step, variant, campaign, country, what) do update set n = n + excluded.n`,
  ).run({ pagesThrough });
  db.prepare(`delete from metric_counts where ${FOLDED_COUNTS}`).run({ pagesThrough });
}

// ---- objections: the database holds a token, replaced whenever an objection moves an app's objected day, and the
// token goes again into RUN_DIR before that commit, in the host's memory, where no volume, disk snapshot or backup
// holds it. A start whose database has RUN_DIR's token holds every objection HQ took on this host, whether HQ stopped
// for a deploy, crashed or took long to start again.
// A copy taken before an objection has an older token; once a start folds, it takes a new one, so no other copy of the
// same data passes either. Without RUN_DIR no start keeps page sources.
const objectionToken = () =>
  (db.prepare('select token from metric_objection').get() as { token: string } | undefined)?.token;
function newObjectionToken() {
  const token = randomBytes(16).toString('hex');
  db.exec('delete from metric_objection');
  db.prepare('insert into metric_objection (token) values (?)').run(token);
  return token;
}
function keepToken(token: string) {
  if (TOKEN_FILE) writeFileSync(TOKEN_FILE, token);
}
let kept = '';
if (TOKEN_FILE)
  try {
    kept = readFileSync(TOKEN_FILE, 'utf8');
  } catch {
    /* no start of HQ's since the host's boot */
  }
const restarted = !!kept && kept === objectionToken();
if (!restarted) {
  db.exec('delete from metric_page_cutoff');
  db.prepare('insert into metric_page_cutoff (through) values (?)').run(companyToday());
}
sweepSources(EVERY_DAY, restarted ? expiredDay(Date.now()) : EVERY_DAY);
keepToken(restarted ? kept : newObjectionToken());
setInterval(() => {
  try {
    sweepSources();
  } catch (err) {
    console.error('metrics: the source sweep failed:', err);
  }
}, SOURCE_CHECK_MS).unref();

// ---- the steps HQ counts for every stall (payments.ts lineSteps): an order put in the shop's basket (basket), a checkout
// opened with it (checkout), in its product's day, and taken back from that day when its basket turns a test. Never with
// a source, country or what: on a day with one buyer, any of them on a step past the page load points to them (see
// "sources"). A test line counts in preview.
lineSteps.push((line, step, at, n) => {
  db.prepare(
    `insert into metric_counts (product, mode, day, step, variant, campaign, country, what, n) values (?, ?, ?, ?, '', '', '', '', ?)
    on conflict (product, mode, day, step, variant, campaign, country, what) do update set n = n + excluded.n`,
  ).run(line.product, line.mode === 'live' ? 'live' : 'preview', companyDay(Date.parse(at)), step, n);
});

// ---- the app's own file, read fresh (a merged change applies within seconds, no restart)
type Pair = [string, string];
type Test = {
  id: string;
  question?: string;
  variants: string[];
  metric: Pair;
  guardrail?: Pair | null;
  finish: number;
  start: string;
  end?: string | null;
};
type AppFile = {
  steps: { id: string; label?: string }[];
  sections?: any[];
  margin?: Record<string, number>;
  targets?: any[];
  tests: Test[];
  [k: string]: unknown;
};
const cache = new Map<string, { at: number; file: AppFile | string | null }>();

// The file as the back office needs it, or why it can't be used (a string), or null when there is none.
function appFile(slug: string): AppFile | string | null {
  const hit = cache.get(slug);
  if (hit && hit.at > Date.now() - FRESH_MS) return hit.file;
  let file: AppFile | string | null = null;
  try {
    // the repo decides what's there, so a link must not lead out of the products folder (the file is shown as it is)
    const path = realpathSync(`${REPO_DIR}/products/${slug}/app/metrics.json`);
    file = path.startsWith(realpathSync(`${REPO_DIR}/products`) + '/')
      ? checkFile(JSON.parse(readFileSync(path, 'utf8')))
      : 'a link out of the products folder';
  } catch (err: any) {
    file = err?.code === 'ENOENT' ? null : 'not valid JSON';
  }
  cache.set(slug, { at: Date.now(), file });
  return file;
}

function checkFile(f: any): AppFile | string {
  if (!f || typeof f !== 'object' || !Array.isArray(f.steps) || !f.steps.length) return 'steps: a list of {id}';
  const ids = f.steps.map((s: any) => s?.id);
  if (!ids.every((id: unknown) => typeof id === 'string' && STEP.test(id)) || new Set(ids).size !== ids.length)
    return 'steps: each a different id, lowercase words';
  if (!ids.includes('page')) return "steps: 'page' (the page load) is always one"; // the kit always counts it
  const tests = f.tests ?? [];
  if (!Array.isArray(tests)) return 'tests: a list';
  const isPair = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every(s => ids.includes(s));
  for (const t of tests) {
    if (!t || typeof t.id !== 'string' || !WORD.test(t.id)) return 'tests: each needs an id (lowercase words)';
    if (
      !Array.isArray(t.variants) ||
      t.variants.length < 2 ||
      !t.variants.every((v: unknown) => typeof v === 'string' && LETTER.test(v)) ||
      new Set(t.variants).size !== t.variants.length
    )
      return `test ${t.id}: variants are two or more different capital letters`;
    if (!isPair(t.metric) || (t.guardrail != null && !isPair(t.guardrail)))
      return `test ${t.id}: metric and guardrail are [from step, to step]`;
    if (!(Number.isFinite(t.finish) && t.finish > 0)) return `test ${t.id}: finish is page loads per version`;
    if (!isDay(t.start) || (t.end != null && (!isDay(t.end) || t.end < t.start)))
      return `test ${t.id}: start (and end) are YYYY-MM-DD`;
  }
  if (new Set(tests.map((t: Test) => t.id)).size !== tests.length) return 'tests: each needs a different id';
  return { ...f, tests };
}

// ---- who is calling: the app's token is an HMAC of its slug and mode under payments' signing key (infra/products.py
// writes it into the app's env file), so an app can only ever count for itself, and a preview never as live.
export const tokenFor = (slug: string, mode: string) => signed(`metrics:${slug}:${mode}`);
// HQ's watch marks its requests to a live app with this in x-hq-watch, and the kit counts none of them: an HMAC of the
// app's live token, which no visitor has, and which says nothing of the token
export const watchMark = (slug: string) =>
  createHmac('sha256', tokenFor(slug, 'live')).update('hq-watch').digest('hex');
type Caller = { slug: string; mode: 'live' | 'preview' };
function caller(req: IncomingMessage): Caller | [number, string] {
  const slug = String(req.headers['x-product'] ?? ''),
    mode = String(req.headers['x-mode'] ?? '');
  const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!SLUG.test(slug) || (mode !== 'live' && mode !== 'preview') || !/^[a-f0-9]{64}$/.test(token))
    return [401, 'metrics token'];
  if (!timingSafeEqual(Buffer.from(tokenFor(slug, mode)), Buffer.from(token))) return [401, 'metrics token'];
  return { slug, mode };
}

// ---- the push, checked whole: anything odd refuses all of it (the kit then drops that batch and says so in its log)
type Dims = { variant: string; campaign: string; country: string; what: string };
const whole = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_N;
const cents = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_EUR ? Math.round(v * 100) : null;

function dims(file: AppFile, r: any): Dims | string {
  const [variant, campaign, country, what] = ['variant', 'campaign', 'country', 'what'].map(k => r[k] ?? '');
  const [id, letter, ...rest] = typeof variant === 'string' ? variant.split(':') : [];
  if (
    typeof variant !== 'string' ||
    (variant && (rest.length || !file.tests.some(t => t.id === id && t.variants.includes(letter))))
  )
    return "variant: '' or <test id>:<letter> of a test in app/metrics.json";
  if (typeof campaign !== 'string' || (campaign && !WORD.test(campaign)))
    return "campaign: '' or lowercase words (40 at most)";
  if (typeof country !== 'string' || (country && !COUNTRY.test(country))) return "country: '' or two capital letters";
  if (typeof what !== 'string' || (what && !WORD.test(what))) return "what: '' or lowercase words (40 at most)";
  return { variant, campaign, country, what };
}

type Count = Dims & { day: string; step: string; n: number };
type OrderRow = Dims & {
  day: string;
  orders: number;
  paid: number;
  refunded: number;
  kept: number;
  cents: number;
  net: number;
  netUnknown: number;
};
type Summary = { from: string; to: string; made: number; objected: string | null; rows: OrderRow[] };
function parsePush(file: AppFile, b: any): { counts: Count[]; orders: Summary | null } | string {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body: a JSON object';
  if (typeof b.batch !== 'string' || !BATCH.test(b.batch)) return 'batch: 32 lowercase hex characters';
  if (!Array.isArray(b.counts)) return 'counts: a list';
  if (b.counts.length > MAX_ROWS) return `counts: at most ${MAX_ROWS} rows`;
  const today = utcToday(),
    first = addDays(today, -2),
    last = addDays(today, 1),
    steps = new Set(file.steps.map(s => s.id));
  const counts: Count[] = [];
  for (const [i, c] of b.counts.entries()) {
    if (!c || typeof c !== 'object') return `counts[${i}]: an object`;
    if (!isDay(c.day) || c.day < first || c.day > last) return `counts[${i}].day: YYYY-MM-DD from ${first} to ${last}`;
    if (!steps.has(c.step) && !LANDING.includes(c.step))
      return `counts[${i}].step: one of the steps in app/metrics.json`;
    const d = dims(file, c);
    if (typeof d === 'string') return `counts[${i}].${d}`;
    if (!whole(c.n)) return `counts[${i}].n: a whole number from 0 to ${MAX_N}`;
    counts.push({ day: c.day, step: c.step, ...d, campaign: LANDING.includes(c.step) ? d.campaign : '', n: c.n });
  }
  if (b.orders === undefined) return { counts, orders: null };
  const o = b.orders;
  if (!o || typeof o !== 'object' || !Array.isArray(o.rows)) return 'orders: {from, to, made, rows}';
  const oldest = addDays(today, -ORDER_DAYS);
  if (!isDay(o.from) || !isDay(o.to) || o.from > o.to || o.from < oldest || o.to > last)
    return `orders.from and .to: days from ${oldest} to ${last}, from first`;
  const now = Date.now();
  if (!Number.isInteger(o.made) || o.made < now - ORDER_DAYS * 864e5 || o.made > now + 60_000)
    return 'orders.made: the time in ms the summary was made';
  const objected = o.objected ?? null;
  if (objected !== null && (!isDay(objected) || objected < o.from || objected > o.to))
    return 'orders.objected: null or a day from orders.from to orders.to';
  if (o.rows.length > MAX_ROWS) return `orders.rows: at most ${MAX_ROWS} rows`;
  const rows: OrderRow[] = [],
    seen = new Set<string>();
  for (const [i, r] of o.rows.entries()) {
    if (!r || typeof r !== 'object') return `orders.rows[${i}]: an object`;
    if (!isDay(r.day) || r.day < o.from || r.day > o.to) return `orders.rows[${i}].day: from orders.from to orders.to`;
    const d = dims(file, r);
    if (typeof d === 'string') return `orders.rows[${i}].${d}`;
    for (const k of ['orders', 'paid', 'refunded', 'kept'])
      if (!whole(r[k])) return `orders.rows[${i}].${k}: a whole number from 0 to ${MAX_N}`;
    const eur = cents(r.eur),
      net = cents(r.net);
    if (eur === null || net === null) return `orders.rows[${i}].eur and .net: euros from 0 to ${MAX_EUR}`;
    const netUnknown = r.netUnknown === undefined ? 0 : r.netUnknown;
    if (!whole(netUnknown) || netUnknown > r.kept)
      return `orders.rows[${i}].netUnknown: a whole number from 0 to its kept orders`;
    const key = JSON.stringify([r.day, d.variant, d.campaign, d.country, d.what]);
    if (seen.has(key)) return `orders.rows[${i}]: the same day and dimensions as an earlier row`;
    seen.add(key);
    rows.push({
      day: r.day,
      ...d,
      orders: r.orders,
      paid: r.paid,
      refunded: r.refunded,
      kept: r.kept,
      cents: eur,
      net,
      netUnknown,
    });
  }
  return { counts, orders: { from: o.from, to: o.to, made: o.made, objected, rows } };
}

// A batch's counts are added once. Its order summary is taken, the batch sent again included, unless HQ has taken one
// made later.
function store(c: Caller, batch: string, p: Exclude<ReturnType<typeof parsePush>, string>) {
  const now = Date.now();
  db.exec('begin');
  try {
    db.prepare('delete from metric_batches where at < ?').run(now - BATCH_DAYS * 864e5);
    const fresh = !db
      .prepare('select 1 from metric_batches where product = ? and mode = ? and batch = ?')
      .get(c.slug, c.mode, batch);
    if (!fresh && !p.orders) {
      db.exec('rollback');
      return { fresh, summary: false };
    }
    if (fresh) {
      db.prepare('insert into metric_batches (product, mode, batch, at) values (?, ?, ?, ?)').run(
        c.slug,
        c.mode,
        batch,
        now,
      );
      const add =
        db.prepare(`insert into metric_counts (product, mode, day, step, variant, campaign, country, what, n) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (product, mode, day, step, variant, campaign, country, what) do update set n = n + excluded.n`);
      for (const x of p.counts) add.run(c.slug, c.mode, x.day, x.step, x.variant, x.campaign, x.country, x.what, x.n);
    }
    const summary = p.orders ? storeSummary(c, p.orders, now) : false;
    foldSources(expiredDay(now));
    db.prepare('insert or replace into metric_pushes (product, mode, at) values (?, ?, ?)').run(
      c.slug,
      c.mode,
      new Date(now).toISOString(),
    );
    if (summary && summary.objection) keepToken(summary.objection);
    db.exec('commit');
    return { fresh, summary: !!summary };
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
}

// Whether HQ took the summary (never one made before the one it has), and the new objection token when its objected
// day moved
function storeSummary(c: Caller, orders: Summary, now: number) {
  const taken = db
    .prepare('select made, objected from metric_summaries where product = ? and mode = ?')
    .get(c.slug, c.mode) as { made: number; objected: string | null } | undefined;
  if (taken && taken.made > orders.made) return false;
  db.prepare('delete from metric_orders where product = ? and mode = ? and day >= ? and day <= ?').run(
    c.slug,
    c.mode,
    orders.from,
    orders.to,
  );
  const put =
    db.prepare(`insert into metric_orders (product, mode, day, variant, campaign, country, what, orders, paid, refunded, kept, cents, net_cents, net_unknown)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of orders.rows)
    put.run(
      c.slug,
      c.mode,
      r.day,
      r.variant,
      r.campaign,
      r.country,
      r.what,
      r.orders,
      r.paid,
      r.refunded,
      r.kept,
      r.cents,
      r.net,
      r.netUnknown,
    );
  // the day the summary was made, never later than today here
  const made = [orders.to, companyDay(now)].sort()[0];
  const covered = db.prepare(
    'insert or replace into metric_order_days (product, mode, day, summary_day) values (?, ?, ?, ?)',
  );
  for (const day of everyDay(orders.from, orders.to)) covered.run(c.slug, c.mode, day, made);
  db.prepare('insert or replace into metric_summaries (product, mode, made, objected) values (?, ?, ?, ?)').run(
    c.slug,
    c.mode,
    orders.made,
    orders.objected,
  );
  return { objection: orders.objected !== null && orders.objected !== taken?.objected ? newObjectionToken() : null };
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const pushed = new Map<string, number[]>();
export async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://x').pathname !== '/api/metrics/push') {
    req.resume();
    return json(res, 404, { error: 'not found' });
  }
  const c = caller(req);
  if (Array.isArray(c)) {
    req.resume();
    return json(res, c[0], { error: c[1] });
  }
  const file = appFile(c.slug);
  if (file === null) {
    req.resume();
    return json(res, 404, { error: 'this product has no app/metrics.json' });
  }
  if (typeof file === 'string') {
    req.resume();
    return json(res, 409, { error: `app/metrics.json: ${file}` });
  }
  const app = `${c.slug}:${c.mode}`,
    times = (pushed.get(app) ?? []).filter(t => t > Date.now() - 36e5);
  if (times.length >= PER_HOUR) {
    req.resume();
    return json(res, 429, { error: 'too many pushes this hour' });
  }
  pushed.set(app, [...times, Date.now()]);
  const raw = await readBody(req, MAX_BODY);
  if (!raw) return json(res, 413, { error: 'body: 1 MB at most' });
  const b = raw.length ? parseJson(raw) : null; // an empty body: refused as no JSON object
  const p = parsePush(file, b);
  if (typeof p === 'string') return json(res, 400, { error: p });
  const stored = store(c, b.batch, p);
  if (stored.summary) summarized.add(app);
  return json(res, 200, {
    ok: true,
    ...(stored.fresh ? {} : { duplicate: true }),
    ...(summarized.has(app) ? {} : { ordersDue: true }),
  });
}

// ---- statistics, written out (no dependency): the normal distribution through erfc, a two-proportion z-test and a
// chi-square goodness of fit for the split.
// erfc with a fractional error below 1.2e-7 everywhere (Numerical Recipes' erfcc, a Chebyshev fit), so small tail
// probabilities stay accurate too.
function erfc(x: number) {
  const z = Math.abs(x),
    t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}
const normalCdf = (z: number) => 0.5 * erfc(-z / Math.SQRT2);
type Rate = { n: number; of: number; rate: number | null };
// z for b's rate minus a's, pooled; null without data on either side
function zScore(a: Rate, b: Rate) {
  if (!a.of || !b.of) return null;
  const pool = (a.n + b.n) / (a.of + b.of),
    se = Math.sqrt(pool * (1 - pool) * (1 / a.of + 1 / b.of));
  return se ? (b.n / b.of - a.n / a.of) / se : 0;
}
const twoSided = (a: Rate, b: Rate) => {
  const z = zScore(a, b);
  return z === null ? null : erfc(Math.abs(z) / Math.SQRT2);
};
const lowerP = (a: Rate, b: Rate) => {
  const z = zScore(a, b);
  return z === null ? null : normalCdf(z);
}; // b lower than a, one-sided
// The chance of a chi-square statistic at least x with k degrees of freedom (k whole): closed forms for even and odd k.
function chiSquareP(x: number, k: number) {
  if (x <= 0) return 1;
  if (k % 2 === 0) {
    let term = Math.exp(-x / 2),
      sum = term;
    for (let i = 1; i < k / 2; i++) sum += term *= x / 2 / i;
    return Math.min(1, sum);
  }
  let term = Math.sqrt(x),
    sum = 0;
  for (let r = 1; r <= (k - 1) / 2; r++) {
    sum += term;
    term *= x / (2 * r + 1);
  }
  return Math.min(1, erfc(Math.sqrt(x / 2)) + Math.sqrt(2 / Math.PI) * Math.exp(-x / 2) * sum);
}
// How far the counts are from an even split (p of the chi-square test), null with nothing counted
function splitP(counts: number[]) {
  const total = counts.reduce((s, x) => s + x, 0),
    e = total / counts.length;
  return total
    ? chiSquareP(
        counts.reduce((s, x) => s + (x - e) ** 2 / e, 0),
        counts.length - 1,
      )
    : null;
}

// ---- a test's standing, from the counts since its start (to its end, if it has one)
const round = (x: number | null, d = 4) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
function standing(slug: string, mode: string, t: Test, today = companyToday()) {
  const last = t.end && t.end < today ? t.end : today;
  const rows = db
    .prepare(
      `select variant, step, sum(n) n from metric_counts where product = ? and mode = ? and day >= ? and day <= ?
    and variant in (${t.variants.map(() => '?').join(', ')}) group by variant, step`,
    )
    .all(slug, mode, t.start, last, ...t.variants.map(v => `${t.id}:${v}`)) as {
    variant: string;
    step: string;
    n: number;
  }[];
  const n = (letter: string, step: string) =>
    rows.find(r => r.variant === `${t.id}:${letter}` && r.step === step)?.n ?? 0;
  const rate = (letter: string, [from, to]: Pair): Rate => {
    const of = n(letter, from),
      k = n(letter, to);
    return { n: k, of, rate: of ? round(k / of, 6) : null };
  };
  const g = t.guardrail ?? null;
  const arms = t.variants.map(letter => ({
    letter,
    metric: rate(letter, t.metric),
    guardrail: g ? rate(letter, g) : null,
    p: null as number | null,
    guardrailP: null as number | null,
  }));
  const [a, ...others] = arms;
  for (const x of others) {
    x.p = round(twoSided(a.metric, x.metric), 6);
    x.guardrailP = g ? round(lowerP(a.guardrail!, x.guardrail!), 6) : null;
  }
  const started = t.start <= today;
  const days = !started ? 0 : t.end && t.end < today ? daysFrom(t.start, t.end) + 1 : daysFrom(t.start, today);
  const progress = round(Math.min(...arms.map(x => x.metric.of)) / t.finish, 4)!;
  const split = round(splitP(arms.map(x => x.metric.of)), 6);
  const up = (x: typeof a) => (x.metric.rate ?? 0) > (a.metric.rate ?? 0);
  const significant = (x: typeof a) => x.p !== null && x.p < CONFIDENCE;
  const guardrailWorse = (x: typeof a) => x.guardrailP !== null && x.guardrailP < CONFIDENCE;
  let state: string,
    winner: string | null = null,
    reason: string;
  if (!started) [state, reason] = ['not-started', `It starts on ${t.start}.`];
  else if (split !== null && split < DRIFT)
    [state, reason] = [
      'split-drifted',
      'The split between the versions drifted away from even: something is broken. Stop the test and fix it.',
    ];
  else if (progress >= 1 && days >= MIN_DAYS) {
    const wins = others.filter(x => significant(x) && up(x) && !guardrailWorse(x)).sort((x, y) => x.p! - y.p!);
    if (wins.length) {
      winner = wins[0].letter;
      [state, reason] = ['won', `${winner} did better at 95% confidence${g ? ', and its guardrail held' : ''}.`];
    } else if (others.every(x => significant(x) && (!up(x) || guardrailWorse(x))))
      [state, reason] = [
        'lost',
        others.some(up)
          ? `${a.letter} stays: the other version raised the number, but its guardrail got worse.`
          : `${a.letter} stays: the other version did worse at 95% confidence.`,
      ];
    else [state, reason] = ['no-difference', 'No difference we can trust: keep the simpler version.'];
  } else if (days >= MAX_TEST_DAYS) [state, reason] = ['six-weeks', `Six weeks without a winner: keep ${a.letter}.`];
  else if (t.end && t.end < today)
    [state, reason] = ['not-called', `It ended on ${t.end} before it could be called: keep ${a.letter}.`];
  else
    [state, reason] = ['not-called', `It needs ${t.finish} per version and ${MIN_DAYS} days before it can be called.`];
  return {
    id: t.id,
    question: t.question ?? null,
    variants: t.variants,
    metric: t.metric,
    guardrail: g,
    finish: t.finish,
    start: t.start,
    end: t.end ?? null,
    days,
    progress,
    split: { p: split },
    state,
    winner,
    reason,
    arms,
  };
}
const runningTest = (file: AppFile, today = companyToday()) =>
  file.tests.find(t => t.start <= today && !(t.end && t.end < today)) ?? null;

// ---- the numbers HQ and the agents read
const euros = (c: number) => Math.round(c) / 100;
function about(slug: string) {
  const p = manifest(slug),
    live = p?.status === 'live';
  return {
    name: typeof p?.name === 'string' ? p.name : slug,
    status: live ? 'live' : 'preview',
    mode: live ? 'live' : 'preview',
  };
}
const lastPush = (slug: string, mode: string) =>
  (db.prepare('select at from metric_pushes where product = ? and mode = ?').get(slug, mode) as any)?.at ?? null;
const products = () => {
  try {
    return readdirSync(`${REPO_DIR}/products`)
      .filter(s => SLUG.test(s))
      .sort();
  } catch {
    return [];
  }
};

// An app's orders per day, from..to (both included), as it pushed them: only the days with orders. kept counts the
// orders kept (paid, not refunded), kept_cents is what they brought in. For the watch's money check, with reportedDays
// and refundedTotal: the orders refunded in all the days the app pushed.
export const ordersByDay = (slug: string, mode: string, from: string, to: string) =>
  db
    .prepare(
      `select day, sum(orders) orders,
  sum(paid) paid, sum(refunded) refunded, sum(kept) kept, sum(cents) kept_cents from metric_orders where product = ? and mode = ?
  and day between ? and ? group by day order by day`,
    )
    .all(slug, mode, from, to) as {
    day: string;
    orders: number;
    paid: number;
    refunded: number;
    kept: number;
    kept_cents: number;
  }[];
// The days from..to whose orders are all in: an order summary made after the day ended covered it. A day without one
// is unknown, never a day without orders.
export function reportedDays(slug: string, mode: string, from: string, to: string) {
  const covered = db
    .prepare(
      `select day from metric_order_days where product = ? and mode = ? and day between ? and ?
    and summary_day > day`,
    )
    .all(slug, mode, from, to) as { day: string }[];
  return new Set(covered.map(r => r.day));
}
export const refundedTotal = (slug: string, mode: string) =>
  (
    db
      .prepare('select coalesce(sum(refunded), 0) n from metric_orders where product = ? and mode = ?')
      .get(slug, mode) as { n: number }
  ).n;

export function home(days = HOME_DAYS) {
  const to = companyToday(),
    from = addDays(to, -(days - 1)),
    apps = [],
    broken = [];
  for (const slug of products()) {
    const file = appFile(slug);
    if (file === null) continue;
    if (typeof file === 'string') {
      broken.push({ slug, error: `app/metrics.json: ${file}` });
      continue;
    }
    const { name, status, mode } = about(slug);
    const byDay = new Map(
      (
        db
          .prepare(
            `select day, sum(paid) paid, sum(cents) cents from metric_orders where product = ? and mode = ? and day >= ? and day <= ?
      group by day`,
          )
          .all(slug, mode, from, to) as any[]
      ).map(r => [r.day, r]),
    );
    const page = (
      db
        .prepare(
          `select coalesce(sum(n), 0) n from metric_counts where product = ? and mode = ? and step = 'page' and day >= ? and day <= ?`,
        )
        .get(slug, mode, from, to) as any
    ).n;
    const spark = everyDay(from, to).map(d => byDay.get(d)?.paid ?? 0),
      paid = spark.reduce((s, x) => s + x, 0);
    const t = runningTest(file, to);
    apps.push({
      slug,
      name,
      status,
      mode,
      hasFile: true,
      revenue: euros([...byDay.values()].reduce((s, r) => s + r.cents, 0)),
      page,
      paid,
      conversion: page ? round(paid / page, 6) : null,
      spark,
      test: t ? { id: t.id, state: standing(slug, mode, t, to).state } : null,
      updated: lastPush(slug, mode),
    });
  }
  // testers: the shop's tester orders (payments.ts paidByTester), apart from its customers'
  return {
    days,
    from,
    to,
    apps,
    broken,
    baskets: shopBaskets(from, to),
    testers: manifest(FRONT)?.basket ? testerOrders(from, to) : null,
  };
}
// The shop's live paid baskets (payments.ts basketsByDay), in all and per day: null when no shop takes baskets. Before
// them, the orders every stall put in the basket and those in a checkout opened (lineSteps), in all.
function shopBaskets(from: string, to: string) {
  if (!manifest(FRONT)?.basket) return null;
  const days = basketsByDay('live', from, to);
  const total = (key: 'paid' | 'several' | 'returning' | 'known') => days.reduce((sum, day) => sum + day[key], 0);
  const steps = (step: string) =>
    (
      db
        .prepare(
          `select coalesce(sum(n), 0) n from metric_counts where mode = 'live' and step = ? and day >= ? and day <= ?`,
        )
        .get(step, from, to) as { n: number }
    ).n;
  return {
    basket: steps('basket'),
    checkout: steps('checkout'),
    paid: total('paid'),
    several: total('several'),
    returning: total('returning'),
    known: total('known'),
    days,
  };
}

const SUMS =
  'sum(orders) orders, sum(paid) paid, sum(refunded) refunded, sum(kept) kept, sum(cents) cents, sum(net_cents) net, sum(net_unknown) net_unknown';
const money = (r: any) => ({ orders: r.orders ?? 0, paid: r.paid ?? 0, kept: r.kept ?? 0, eur: euros(r.cents ?? 0) });
const ranked = <T extends { kept: number; orders: number }>(rows: T[]) =>
  rows.sort((x, y) => y.kept - x.kept || y.orders - x.orders);

export function detail(slug: string, days: number, mode?: string) {
  const file = SLUG.test(slug) ? appFile(slug) : null;
  if (file === null) return [404, 'no app/metrics.json for this product'] as [number, string];
  if (typeof file === 'string') return [409, `app/metrics.json: ${file}`] as [number, string];
  const a = about(slug),
    m = mode ?? a.mode,
    to = companyToday(),
    from = addDays(to, -(days - 1));
  const where = 'product = ? and mode = ? and day >= ? and day <= ?',
    args = [slug, m, from, to];
  const counts = (by: string, extra = '', ...more: string[]) =>
    db
      .prepare(`select ${by}, sum(n) n from metric_counts where ${where} ${extra} group by ${by}`)
      .all(...args, ...more) as any[];
  const orders = (by: string) =>
    db.prepare(`select ${by}, ${SUMS} from metric_orders where ${where} group by ${by}`).all(...args) as any[];
  const ids = file.steps.map(s => s.id),
    zeros = () => Object.fromEntries(ids.map(id => [id, 0]));

  const steps = zeros();
  for (const r of counts('step')) if (r.step in steps) steps[r.step] = r.n;
  const daySteps = new Map<string, Record<string, number>>();
  for (const r of counts('day, step'))
    if (ids.includes(r.step)) (daySteps.get(r.day) ?? daySteps.set(r.day, zeros()).get(r.day)!)[r.step] = r.n;
  const dayOrders = new Map(orders('day').map(r => [r.day, r]));
  const daily = everyDay(from, to).map(d => ({
    day: d,
    steps: daySteps.get(d) ?? zeros(),
    ...money(dayOrders.get(d) ?? {}),
  }));

  const countries = orders('country');
  const pages = new Map(counts('campaign', "and step = 'page'").map(r => [r.campaign, r.n]));
  const byCampaign = new Map(orders('campaign').map(r => [r.campaign, r]));
  const campaigns = [...new Set([...pages.keys(), ...byCampaign.keys()])].map(c => ({
    campaign: c || null,
    page: pages.get(c) ?? 0,
    ...money(byCampaign.get(c) ?? {}),
  }));
  // every load by where it came from: a person's by the kind of page that sent them, or the crawler, fetcher or prefetch
  // that made it
  const sources = counts('campaign', "and step = 'load'")
    .map(r => ({ source: r.campaign || null, n: r.n }))
    .sort((x, y) => y.n - x.n);
  const stepWhat: Record<string, { what: string | null; n: number }[]> = {};
  for (const s of file.sections ?? [])
    if (s?.kind === 'step-what' && ids.includes(s.step))
      stepWhat[s.step] = counts('what', 'and step = ?', s.step)
        .map(r => ({ what: r.what || null, n: r.n }))
        .sort((x, y) => y.n - x.n);

  const all = (db.prepare(`select ${SUMS} from metric_orders where ${where}`).get(...args) as any) ?? {};
  const margins = file.margin && typeof file.margin === 'object' ? file.margin : null;
  const margin = margins
    ? round(
        countries.reduce((s, r) => s + r.kept * (Number(margins[r.country]) || 0), 0),
        2,
      )
    : null;
  return {
    slug,
    name: a.name,
    status: a.status,
    mode: m,
    days,
    from,
    to,
    updated: lastPush(slug, m),
    file,
    steps,
    daily,
    countries: ranked(countries.map(r => ({ country: r.country || null, ...money(r) }))),
    campaigns: ranked(campaigns),
    sources,
    what: ranked(orders('what').map(r => ({ what: r.what || null, ...money(r) }))),
    stepWhat,
    totals: {
      ...money(all),
      refunded: all.refunded ?? 0,
      net: all.net_unknown ? null : euros(all.net ?? 0),
      netUnknown: all.net_unknown ?? 0,
      margin,
    },
    tests: file.tests.map(t => standing(slug, m, t, to)),
    targets: (file.targets ?? []).map((t: any) => ({ ...t, value: null, mark: 'none' })),
  };
}

// The agents' route and the board's detail route: q is the query (app, days, mode); without an app, the home list.
export function numbers(q: { app?: unknown; days?: unknown; mode?: unknown }) {
  const days = q.days == null || q.days === '' ? HOME_DAYS : Number(q.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS)
    return [400, `days: a whole number from 1 to ${MAX_DAYS}`] as [number, string];
  if (q.app == null || q.app === '') return home(days);
  if (q.mode != null && q.mode !== '' && q.mode !== 'live' && q.mode !== 'preview')
    return [400, 'mode: live or preview'] as [number, string];
  return detail(String(q.app), days, q.mode ? String(q.mode) : undefined);
}
