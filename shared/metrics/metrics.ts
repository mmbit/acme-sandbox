// Counting for a product app: page loads, funnel steps and a daily order summary, sent to HQ (README.md).
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unanswered } from '../quiet/quiet.ts';
import { formats } from '../format/format.js';
import { forget, visitors } from './visitors.ts';

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
type Headers = Record<string, string | string[] | undefined>;
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
const SEARCH_HOSTS = new Map([
  ['bing.com', 'bing'],
  ['duckduckgo.com', 'duckduckgo'],
  ['ecosia.org', 'ecosia'],
  ['search.yahoo.com', 'yahoo'],
  ['search.brave.com', 'brave'],
  ['startpage.com', 'startpage'],
  ['qwant.com', 'qwant'],
  ['baidu.com', 'baidu'],
  ['yandex.com', 'yandex'],
  ['yandex.ru', 'yandex'],
  ['search.aol.com', 'aol'],
  ['search.naver.com', 'naver'],
  ['search.seznam.cz', 'seznam'],
]);
const SEARCH_CAMPAIGNS = new Set(['search-google', ...[...SEARCH_HOSTS.values()].map(engine => `search-${engine}`)]);
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
let pending: { batch: string; counts: Count[]; orders?: ReturnType<typeof summarize> } | null = null;
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
    const sent = counts();
    tally = new Map();
    const summary = orders && now - ordersSent >= ORDERS_MS ? orderSummary(now) : null;
    if (!sent.length && !summary) return true;
    pending = { batch: randomBytes(16).toString('hex'), counts: sent, ...(summary ? { orders: summary } : {}) };
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
  const why = r ? `${r.status} ${String((await r.json().catch(() => ({})))?.error ?? '').slice(0, 200)}` : 'no answer';
  await r?.body?.cancel().catch(() => {});
  // HQ refused the batch itself (bad data, a wrong key): sending it again can't help, so it's dropped and said once.
  // Counts it refuses (days it no longer takes, after an outage) don't take the summary with them: it goes again alone,
  // from its first day, and is dropped only if HQ refuses that too. Busy, down or unreachable: it goes again next time.
  if (r && r.status === 400 && pending.orders && pending.counts.length) {
    pending.counts = [];
    pushes.answered();
    warnOnce(`HQ refused a push (${why}): its counts dropped, its order summary goes again alone`);
  } else if (r && r.status >= 400 && r.status < 500 && r.status !== 429) {
    if (pending.orders) ordersSent = 0;
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
  return false;
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

// The host of an http(s) referrer without credentials, minus a leading www; null for anything else.
function referrerHost(referrer: unknown): string | null {
  const url = typeof referrer === 'string' ? URL.parse(referrer) : null;
  return url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    ? url.hostname.replace(/^www\./, '')
    : null;
}

function searchCampaign(referrer: unknown): string | null {
  const host = referrerHost(referrer);
  if (!host) return null;
  if (/^google\.(?:com|[a-z]{2}|(?:co|com)\.[a-z]{2})$/.test(host)) return 'search-google';
  if (/^(?:[a-z]{2}\.)?search\.yahoo\.com$/.test(host)) return 'search-yahoo';
  const engine = SEARCH_HOSTS.get(host);
  return engine ? `search-${engine}` : null;
}

// ---- who loaded a page, and where from: a crawler or fetcher, a speculative load, or a person with the kind of page
// that sent them. page() counts these itself; an app that counts per page calls them too. Only the returned name is
// kept, never the user agent or referrer.
// (other fetchers, Meta's, prefetches and loadSource)

// The source of a load that isn't a person's, or null for a person's: agent-<name> for a crawler or fetcher
// (crawlerName), else prefetch for a load made ahead of a tap that may never come (speculative).
export function fetchedBy(headers: Headers): string | null {
  const agent = crawlerName(headers['user-agent']);
  if (agent) return `agent-${agent}`;
  return speculative(headers) ? 'prefetch' : null;
}

// The crawlers and fetchers that say who they are, by the robots token each company documents for its user agent
// (OpenAI's developers.openai.com/api/docs/bots, docs.perplexity.ai/guides/bots, Anthropic's support article 8896518,
// Bing's and Google's crawler pages, Meta's developers.facebook.com/docs/sharing/webmasters/web-crawlers). Matched as a
// whole word, case-insensitive: the full strings change with every version. A user agent is a claim anyone can make,
// so these count what visitors say they are. The AI ones are OpenAI's, Perplexity's and Anthropic's; bingbot,
// Googlebot and Applebot are search crawlers whose index the assistants also answer from (Copilot, Gemini, Siri), so
// they're named too, and a report tells them apart by name. Meta's fetch a shared link's preview
// (facebookexternalhit), review an ad's page (meta-externalads) and crawl for its AI and search.
const CRAWLERS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'GPTBot',
  'PerplexityBot',
  'Perplexity-User',
  'Claude-SearchBot',
  'Claude-User',
  'ClaudeBot',
  'bingbot',
  'Googlebot',
  'Applebot',
  'facebookexternalhit',
  'meta-externalads',
  'meta-externalagent',
  'meta-externalfetcher',
  'meta-webindexer',
];
const CRAWLER_TOKEN = new RegExp(`(?<![a-z0-9-])(${CRAWLERS.join('|')})(?![a-z0-9])`, 'i');
// Any other that says it's a bot: a name ending in bot, crawler or spider before its version or the end of its part
// ('AhrefsBot/7.0', 'Bytespider;', 'SEO Spider/21'; not a phone named Cubot, which a space follows), or the link to
// its own page that crawlers put in their user agent ('+https://…'), which no browser has
const DECLARED_BOT = /(?<![a-z0-9])[a-z0-9_-]*(?:bot|crawler|spider)(?=[/;),]|$)|\+https?:\/\//i;
// The HTTP libraries and headless browsers scripts fetch with, as the product token each puts in its user agent
// ('curl/8.5.0', 'python-requests/2.32', 'Go-http-client/2.0', Node's fetch 'node')
const LIBRARIES = [
  'curl',
  'Wget',
  'python-requests',
  'Python-urllib',
  'python-httpx',
  'aiohttp',
  'Go-http-client',
  'node',
  'node-fetch',
  'undici',
  'axios',
  'okhttp',
  'Java',
  'Apache-HttpClient',
  'libwww-perl',
  'Scrapy',
  'GuzzleHttp',
  'HeadlessChrome',
  'PhantomJS',
];
const LIBRARY_TOKEN = new RegExp(`(?<![a-z0-9-])(?:${LIBRARIES.join('|')})(?:/|$)`, 'i');

// The known crawler's or fetcher's name in lowercase ('gptbot', 'chatgpt-user'), other for any other bot or HTTP
// library and for a request without a user agent (every browser sends one), or null for a browser.
export function crawlerName(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return 'other';
  const agent = userAgent.slice(0, 1000),
    m = CRAWLER_TOKEN.exec(agent);
  if (m) return m[1].toLowerCase();
  return DECLARED_BOT.test(agent) || LIBRARY_TOKEN.test(agent) ? 'other' : null;
}

// A load made ahead of a tap that may never come: a browser's prefetch or prerender (Sec-Purpose, or Purpose in older
// ones), or Meta's apps loading an ad's page before it's tapped (X-Purpose: preview). A tap after one shows the page
// the load fetched, without a load of its own.
const PURPOSE_HEADERS = ['sec-purpose', 'purpose', 'x-purpose'];
const SPECULATIVE = /(?<![a-z0-9-])(?:prefetch|prerender|preview)(?![a-z0-9-])/i;
const speculative = (headers: Headers) => PURPOSE_HEADERS.some(name => SPECULATIVE.test(String(headers[name] ?? '')));

// Where a person's page load came from, by the referrer's host (and on a shelf its path) alone: stall for the app's own
// pages (a reload or a step inside it), shop for the shop's other pages on the same host, ai-<assistant> (aiReferral:
// its referrer or the page's utm_source), search-<engine>, a social network by name (SOCIAL_HOSTS), other for any
// other site, or none without a referrer. A shelf is the app at <shop host><X-Forwarded-Prefix> (infra/products.py).
// ownPage: which paths on the host are the app's own, for one whose host has other apps' shelves under it (the shop's
// front at the root); by default those under its prefix, or every path without one.
export function loadSource(headers: Headers, url: URL | string, ownPage?: (path: string) => boolean): string {
  const referrer = headers.referer,
    host = referrerHost(referrer),
    own = typeof headers.host === 'string' ? referrerHost(`http://${headers.host}`) : null;
  if (host && host === own) {
    const prefix = String(headers['x-forwarded-prefix'] ?? ''),
      path = URL.parse(String(referrer))!.pathname,
      ours = ownPage ?? ((p: string) => !prefix || p === prefix || p.startsWith(`${prefix}/`));
    return ours(path) ? 'stall' : 'shop';
  }
  const assistant = aiReferral(referrer, url);
  if (assistant) return assistant;
  if (!host) return referrer ? 'other' : 'none';
  return searchCampaign(referrer) ?? socialNetwork(host) ?? 'other';
}

// The social networks by their sites' domains, each with its subdomains (Facebook's link hosts l. and lm.)
const SOCIAL_HOSTS = new Map([
  ['facebook.com', 'meta'],
  ['instagram.com', 'meta'],
]);
const socialNetwork = (host: string) => {
  const labels = host.split('.');
  return labels.map((_, i) => SOCIAL_HOSTS.get(labels.slice(i).join('.'))).find(Boolean) ?? null;
};

// The assistants whose links send people here, by the referrer host, or utm_source on the page's URL (ChatGPT adds
// utm_source=chatgpt.com to the links it cites, and its app often sends no referrer).
const AI_HOSTS = new Map([
  ['chatgpt.com', 'chatgpt'],
  ['perplexity.ai', 'perplexity'],
  ['copilot.microsoft.com', 'copilot'],
  ['gemini.google.com', 'gemini'],
  ['claude.ai', 'claude'],
]);

// ai-<assistant> for a visit an AI assistant sent ('ai-chatgpt'), from the referrer or the page's URL; else null.
export function aiReferral(referrer: unknown, url: URL | string): string | null {
  const source = URL.parse(String(url), 'http://x')
    ?.searchParams.get('utm_source')
    ?.toLowerCase()
    .replace(/^www\./, '');
  const assistant = AI_HOSTS.get(referrerHost(referrer) ?? '') ?? AI_HOSTS.get(source ?? '');
  return assistant ? `ai-${assistant}` : null;
}
