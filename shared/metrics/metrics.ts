// Counting for a product app: page loads, funnel steps and a daily order summary, sent to HQ (README.md).
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unanswered } from '../quiet/quiet.ts';
import { formats } from '../format/format.js';
import { forget, visitors } from './visitors.ts';
import { fetchedBy, loadSource, searchCampaign, SEARCH_CAMPAIGNS, type Headers } from './loads.ts';
// An app imports everything of metrics from here, who loaded its pages included (README.md)
export { aiReferral, crawlerName, fetchedBy, loadSource } from './loads.ts';

const env = process.env;
const URL_ = env.METRICS_URL ?? '',
  PRODUCT = env.METRICS_PRODUCT ?? '',
  TOKEN = env.METRICS_TOKEN ?? '';
const MODE = env.METRICS_MODE === 'live' ? 'live' : 'preview';
const connected = Boolean(URL_ && PRODUCT && TOKEN);
// The app's own day, as its orders are dated, on the company's clock: METRICS_TIME_ZONE beside the others, or on your
// own machine (sending nothing) UTC unless it names one.
const timeZone = connected ? env.METRICS_TIME_ZONE : (env.METRICS_TIME_ZONE ?? 'UTC');
const { dayAt } = formats({ locales: { en: 'en-GB' }, currency: undefined, timeZone });
export const day = (at: string | number | Date = Date.now()) => dayAt(new Date(at).getTime());
// The request being handled (serve()): its headers for visitors and visits, and whether its activity counts. A live
// product doesn't count one through its preview door (X-Preview-Door), one of our own visits (X-Own-Device), or one
// from HQ's watch (x-hq-watch with WATCH_MARK).
const handling = new AsyncLocalStorage<{ counted: boolean; headers: Headers }>();
// The day's visitors on a live product with the switch on, its list on the data volume (the container's DATA_DIR).
// With it off, a list an earlier run left is deleted at start.
const VISITORS_FILE = env.DATA_DIR ? join(env.DATA_DIR, 'visitors.json') : null;
const seen = env.METRICS_VISITORS === '1' && MODE === 'live' ? visitors({ file: VISITORS_FILE, day }) : null;
if (!seen && VISITORS_FILE) forget(VISITORS_FILE);
// The steps every app counts without listing them, each with its page load's source: page() counts a person's page
// load, visitor and visit with the app's label, and every load, a person's or not, with where it came from (loadSource)
// (load)
const LANDING = new Set(['page', 'visitor', 'visit', 'load']);
// The coordinator's watchMark() for this app: an HMAC of its token, which no visitor has
const WATCH_MARK = Buffer.from(TOKEN ? createHmac('sha256', TOKEN).update('hq-watch').digest('hex') : '');
// SOURCE_DAYS: how long an order keeps its source, here and in HQ (the coordinator's metrics.ts has the same number).
// The summary covers at least as long, so a source cleared early (an objection) leaves HQ with the next summary.
export const SOURCE_DAYS = 60;
const PUSH_MS = 5 * 60_000,
  ORDERS_MS = 60 * 60_000,
  ORDER_DAYS = SOURCE_DAYS;
const WORD = /^[a-z0-9-]{1,40}$/,
  COUNTRY = /^[A-Z]{2}$/,
  VARIANT = /^[a-z0-9-]{1,40}:[A-Z]$/;
// Per-click ad IDs (charter rule 7): never read, kept or passed on. Anything ending in "clid" too (fbclid, gclid,
// ttclid, msclkid's cousins), so a new network's ID is dropped without a change here.
const CLICK_IDS = new Set([
  'gbraid',
  'wbraid',
  'msclkid',
  'igshid',
  'li_fat_id',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'sccid',
  'epik',
  'irclickid',
  'yclid',
  'twclid',
  'rdt_cid',
]);
const isWatchMark = (v: unknown) => {
  const given = Buffer.from(typeof v === 'string' ? v : '');
  return WATCH_MARK.length > 0 && given.length === WATCH_MARK.length && timingSafeEqual(given, WATCH_MARK);
};
const isClickId = (k: string) => {
  const l = k.toLowerCase();
  return l.endsWith('clid') || CLICK_IDS.has(l);
};

type Test = { id: string; variants: string[]; start: string; end?: string | null };
type File = { steps: { id: string }[]; tests?: Test[] };
type Dims = { variant?: string | null; campaign?: string | null; country?: string | null; what?: string | null };
// One order as the summary needs it: never a name, address, email or design. created: ISO time or ms. net: what the
// order leaves after tax and payment fees, in euros, or null while the app doesn't know it (never the total or 0).
// objected: its buyer objected to its source counting.
export type Order = {
  created: string | number;
  paid: boolean;
  refunded: boolean;
  total: number;
  net: number | null;
  objected?: boolean;
} & Dims;
export type Count = {
  day: string;
  step: string;
  variant: string;
  campaign: string;
  country: string;
  what: string;
  n: number;
};
export type OrderRow = {
  day: string;
  variant: string;
  campaign: string;
  country: string;
  what: string;
  orders: number;
  paid: number;
  refunded: number;
  kept: number;
  eur: number;
  net: number;
  netUnknown: number;
};

let file: File = { steps: [{ id: 'page' }], tests: [] };
let steps = new Set(LANDING);
let label: (v: unknown) => string | null = () => null;
let orders: (() => Order[]) | null = null;
let searchReferrers = false,
  orderCampaigns = false;
let tally = new Map<string, number>();
type Batch = { batch: string; counts: Count[]; orders?: ReturnType<typeof summarize> };
let pending: Batch | null = null;
let ordersSent = 0,
  timer: ReturnType<typeof setInterval> | null = null;
// HQ out of reach for ten minutes of pushes or more.
const pushes = unanswered(10 * 60_000);
const warned = new Set<string>();
const warnOnce = (text: string) => {
  if (!warned.has(text)) {
    warned.add(text);
    console.error(`metrics: ${text}`);
  }
};
const counts = (): Count[] =>
  [...tally].map(([k, n]) => {
    const [d, step, variant, campaign, country, what] = JSON.parse(k);
    return { day: d, step, variant, campaign, country, what, n };
  });

const fit = (re: RegExp, v: unknown) => (typeof v === 'string' && re.test(v) ? v : '');
// A version HQ will take: its test and letter are in the file (a started test stays there, with an end, never deleted)
const known = (v: unknown) => {
  const [id, letter] = fit(VARIANT, v).split(':');
  return (file.tests ?? []).some(t => t.id === id && t.variants.includes(letter)) ? `${id}:${letter}` : '';
};
const running = () =>
  (file.tests ?? []).find(t => t.start <= day() && !(t.end && t.end < day()) && t.variants?.length > 1) ?? null;

function add(step: string, d: Dims, n = 1) {
  if (handling.getStore()?.counted === false) return;
  if (!steps.has(step)) return warnOnce(`"${step}" isn't a step in metrics.json: not counted`);
  const campaign = LANDING.has(step) ? fit(WORD, d.campaign) : '';
  const key = JSON.stringify([day(), step, known(d.variant), campaign, fit(COUNTRY, d.country), fit(WORD, d.what)]);
  tally.set(key, (tally.get(key) ?? 0) + n);
}

// ---- the order summary: per day and dimensions, what was ordered, paid, refunded and kept. net adds up the kept
// orders whose net the app knows, and netUnknown counts the rest. made: when, so HQ never takes an older summary over a
// newer one. A source SOURCE_DAYS old or more is left out, whatever the app still has. from: the first day, by default
// ORDER_DAYS back.
// objected: the last day with an objected order younger than SOURCE_DAYS, or null.
export function summarize(list: Order[], now = Date.now(), from = day(now - (ORDER_DAYS - 1) * 864e5)) {
  const to = day(now),
    rows = new Map<string, OrderRow>();
  let objected: string | null = null;
  for (const o of list) {
    const d = day(o.created);
    if (d < from || d > to) continue;
    const sourced = new Date(o.created).getTime() > now - SOURCE_DAYS * 864e5;
    if (sourced && o.objected === true && (objected === null || d > objected)) objected = d;
    const dims = {
      variant: known(o.variant),
      campaign: sourced ? fit(WORD, o.campaign) : '',
      country: fit(COUNTRY, o.country),
      what: fit(WORD, o.what),
    };
    const key = JSON.stringify([d, dims.variant, dims.campaign, dims.country, dims.what]);
    const r =
      rows.get(key) ??
      rows
        .set(key, { day: d, ...dims, orders: 0, paid: 0, refunded: 0, kept: 0, eur: 0, net: 0, netUnknown: 0 })
        .get(key)!;
    r.orders++;
    if (!o.paid) continue;
    r.paid++;
    if (o.refunded) {
      r.refunded++;
      continue;
    }
    r.kept++;
    r.eur = Math.round((r.eur + (Number(o.total) || 0)) * 100) / 100;
    if (typeof o.net === 'number' && Number.isFinite(o.net)) r.net = Math.round((r.net + o.net) * 100) / 100;
    else r.netUnknown++;
  }
  return { from, to, made: now, objected, rows: [...rows.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

// ---- the push: the batch that failed goes again with its counts as they were (HQ adds a batch id's counts once) and
// its order summary made again, so a retry never brings back a source the app cleared meanwhile. The summary made
// again starts on the same first day, so a change to an order on a day that has since left the window still reaches
// HQ. New counts wait for the next.
export async function push(now = Date.now()) {
  if (!connected) return false;
  if (!pending) {
    pending = newBatch(now);
    if (!pending) return true;
  } else if (pending.orders) {
    const summary = orderSummary(now, pending.orders.from);
    if (!summary) return false;
    pending.orders = summary;
  }
  const r = await fetch(`${URL_}/api/metrics/push`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify(pending),
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-product': PRODUCT,
      'x-mode': MODE,
      'content-type': 'application/json',
    },
  }).catch(() => null);
  if (r?.ok) {
    // HQ asks for a summary when it has none from this start: it drops every source when it starts (a restore included)
    if ((await r.json().catch(() => ({})))?.ordersDue === true) ordersSent = 0;
    pending = null;
    pushes.answered();
    return true;
  }
  await notTaken(r, pending, now);
  return false;
}

// The counts since the last batch, and the order summary when one is due; null with neither
function newBatch(now: number): Batch | null {
  const sent = counts();
  tally = new Map();
  const summary = orders && now - ordersSent >= ORDERS_MS ? orderSummary(now) : null;
  if (!sent.length && !summary) return null;
  return { batch: randomBytes(16).toString('hex'), counts: sent, ...(summary ? { orders: summary } : {}) };
}

// HQ refused the batch itself (bad data, a wrong key): sending it again can't help, so it's dropped and said once.
// Counts it refuses (days it no longer takes, after an outage) don't take the summary with them: it goes again alone,
// from its first day, and is dropped only if HQ refuses that too. Busy, down or unreachable: it goes again next time.
async function notTaken(r: Response | null, sent: Batch, now: number) {
  const why = r ? `${r.status} ${String((await r.json().catch(() => ({})))?.error ?? '').slice(0, 200)}` : 'no answer';
  await r?.body?.cancel().catch(() => {});
  if (r && r.status === 400 && sent.orders && sent.counts.length) {
    sent.counts = [];
    pushes.answered();
    warnOnce(`HQ refused a push (${why}): its counts dropped, its order summary goes again alone`);
  } else if (r && r.status >= 400 && r.status < 500 && r.status !== 429) {
    if (sent.orders) ordersSent = 0;
    pending = null;
    pushes.answered();
    warnOnce(`HQ refused a push (${why}): dropped`);
  } else {
    // a deploy restarts HQ with the products: quiet at first (shared/quiet).
    pushes.failed(
      `metrics: HQ hasn't taken the counts yet (${r?.status ?? 'out of reach'}); they go again in ${PUSH_MS / 60_000} minutes`,
      minutes => `metrics: push failed (${why}) for ${minutes} minutes, trying again in ${PUSH_MS / 60_000} minutes`,
      now,
    );
  }
}

function orderSummary(now: number, from?: string) {
  try {
    const summary = summarize(orders!(), now, from);
    ordersSent = now;
    return summary;
  } catch (e) {
    console.error(`metrics: the order summary failed: ${(e as Error).message.slice(0, 200)}`);
    return null;
  }
}

export const metrics = {
  connected,
  mode: MODE,

  // Reads the app's metrics.json (a URL, a path or the object itself) and starts the push timer.
  setup(o: {
    file: URL | string | File;
    label?: (v: unknown) => string | null;
    orders?: () => Order[];
    searchReferrers?: boolean;
    orderCampaigns?: boolean;
  }) {
    file = typeof o.file === 'object' && !(o.file instanceof URL) ? o.file : JSON.parse(readFileSync(o.file, 'utf8'));
    steps = new Set([...LANDING, ...file.steps.map(s => s.id)]);
    if (o.label) label = o.label;
    if (o.orders) orders = o.orders;
    searchReferrers = o.searchReferrers === true;
    orderCampaigns = o.orderCampaigns === true;
    if (connected && !timer) {
      timer = setInterval(() => push().catch(e => console.error('metrics:', (e as Error).message)), PUSH_MS);
      timer.unref();
      // the last few minutes' counts on the way out (a deploy stops the container with SIGTERM)
      process.once('SIGTERM', () => {
        Promise.race([push(), new Promise(r => setTimeout(r, 3000))]).finally(() => process.exit(0));
      });
    }
  },

  // Runs the request's handler. On a live product it counts nothing of a request through the preview door, from our own
  // visits or from HQ's watch.
  serve<T>(req: { headers: Headers }, fn: () => T): T {
    return handling.run({ counted: metrics.counts(req), headers: req.headers }, fn);
  },

  // Whether the app may count this request's activity in counts of its own: false on a live product for the preview
  // door, our own visits and HQ's watch, as serve() counts nothing of them.
  counts(req: { headers: Headers }) {
    const fromDoor = req.headers['x-preview-door'] !== undefined,
      ours = req.headers['x-own-device'] === '1';
    return !(MODE === 'live' && (fromDoor || ours || isWatchMark(req.headers['x-hq-watch'])));
  },

  // The request's address without ad click IDs, or null when it had none. Redirect the page to it before serving it.
  cleanUrl(reqUrl: string | undefined) {
    let u: URL;
    try {
      u = new URL(reqUrl ?? '/', 'http://x');
    } catch {
      return null;
    }
    const drop = [...u.searchParams.keys()].filter(isClickId);
    if (!drop.length) return null;
    for (const k of drop) u.searchParams.delete(k);
    // one leading slash: '//evil.com/x' would be another host's address in a Location header
    return '/' + u.pathname.replace(/^\/+/, '') + u.search;
  },

  // Count a page load with the app's label or, with searchReferrers, the search engine's name. Inside serve(), the load
  // also counts as `load` with where it came from (loadSource), and one that isn't a person's (fetchedBy) counts only
  // there, not as a page load, a visitor or a visit, and answers null.
  // Pick a test version at random, never from anything known about the visitor (charter rule 7).
  // (load and fetchedBy)
  page(url: URL, referrer?: unknown): { campaign: string | null; variant: string | null } | null {
    const req = handling.getStore(),
      fetcher = req ? fetchedBy(req.headers) : null;
    if (req) add('load', { campaign: fetcher ?? loadSource(req.headers, url) });
    if (fetcher) return null;
    const campaign =
      label(url.searchParams.get('c') ?? url.searchParams.get('utm_campaign')) ??
      (searchReferrers ? searchCampaign(referrer) : null);
    const t = running();
    const variant = t ? `${t.id}:${t.variants[randomInt(t.variants.length)]}` : null;
    add('page', { campaign, variant });
    const v = req ? metrics.visit(req) : null;
    if (v?.visitor) add('visitor', { campaign });
    if (v?.visit) add('visit', { campaign });
    return { campaign, variant };
  },

  // Whether this page load is a new visitor today and a new visit (./visitors.ts), for an app's own counts; null with
  // the switch off, off the live site, for a request counts() leaves out, and for a load that isn't a person's
  // (fetchedBy: a crawler, a fetcher or a prefetch).
  visit(req: { headers: Headers }): { visitor: boolean; visit: boolean } | null {
    if (!seen || !metrics.counts(req) || fetchedBy(req.headers)) return null;
    return seen.see(req.headers);
  },

  // Writes the page version and opted-in source into <html> for the current visit's checkout.
  mark(html: string, v: { variant: string | null; campaign?: string | null }) {
    const campaign = metrics.orderCampaign(v.campaign);
    const attributes = (v.variant ? ` data-ab="${v.variant}"` : '') + (campaign ? ` data-campaign="${campaign}"` : '');
    return attributes ? html.replace(/<html\b/i, `<html${attributes}`) : html;
  },

  // Validate the campaign sent with an order: an app label or search-<engine>, never a referrer address.
  // Return null unless orderCampaigns is enabled.
  orderCampaign(value: unknown): string | null {
    if (!orderCampaigns || typeof value !== 'string') return null;
    const ours = label(value);
    if (ours && WORD.test(ours)) return ours;
    return searchReferrers && SEARCH_CAMPAIGNS.has(value) ? value : null;
  },

  // A version the page sent back with the order, if it belongs to the test that's running; otherwise null.
  variant(v: unknown) {
    const t = running(),
      [id, letter] = typeof v === 'string' ? v.split(':') : [];
    return t && id === t.id && t.variants.includes(letter) && VARIANT.test(String(v)) ? String(v) : null;
  },

  // One step of the funnel, from a request the app handles anyway. Country only from the price request or the order.
  count(step: string, d: Dims = {}) {
    add(step, d);
  },

  // What's counted and not sent yet (tests, and a look on your own machine).
  snapshot: counts,
};
