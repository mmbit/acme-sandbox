// HQ's watch on the live apps: whether each is up and able to sell, every 5 minutes, and the daily checks it runs (the
// error scan in triage.ts, the money check in money.ts, the email plan's check in mailplan.ts). What it does, and how a
// company tunes it: infra/products.md, "HQ's watch".
import { performance } from 'node:perf_hooks';
import { db, inOneStep, setting, remember } from './db.ts';
import { publish } from './events.ts';
import * as alarms from './alarms.ts';
import * as jobs from './jobs.ts';
import { list as listApps } from './apps.ts';
import { approved } from './approvals.ts';
import * as payments from './payments.ts';
import { manifest } from './manifests.ts';
import { ownerOf } from './owed.ts';
import * as company from './company.ts';
import * as metrics from './metrics.ts';
import * as spend from './spend.ts';
import * as triage from './triage.ts';
import * as money from './money.ts';
import * as mailplan from './mailplan.ts';
import { madeForProduct } from './made.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const CHECK_MS = 5 * MINUTE_MS;
export const ALERT_AFTER_MS = 60 * MINUTE_MS;
const FAILURES = 2;
const TIMEOUT_MS = 15_000;
// An outage's job that ended with no fix in review gets a successor only if the outage still fails this long after.
// sync.sh deploys a merged fix within minutes.
export const SETTLE_MS = 30 * MINUTE_MS;
// jobs an outage gets at most, its first included
const REPAIRS = 3;
// checks in a row that see it work before an outage ends: one between failures leaves it open
const RECOVERIES = 3;
// Today and the two days before. The ads' daily check records the day before, and today's may not be in yet.
const SPENDING_DAYS = 3;
// the apps push their orders hourly, so by then the day before is in
const DAILY_HOUR = 7;
// A job still at work on an outage: open, or done with its pull request in review. A job's end starts its review, and
// a fix reaches the app only once merged.
const AT_WORK = `(j.status in ('queued', 'running', 'blocked') or exists (select 1 from prs p
  where p.branch = coalesce(j.branch, 'job/' || j.id) and p.status in ('open', 'stuck', 'board')))`;

// An app's outages, one row for each thing a failure keeps from people (Blocks): its page fails, or it can't sell. Each
// has its own count, job and alarm, so a page that opens again says nothing of a checkout that failed before.
// repairs: the jobs the outage got. job_ended: when the watch first saw its job over, with no fix of it in review.
// passes: the checks in a row since its last failure that saw it work, the first at working_since.
db.exec(`create table if not exists watch_outages (product text not null, blocks text not null,
  failures integer not null default 0, failing_since text, failure text, job integer, repairs integer not null default 0,
  job_ended text, passes integer not null default 0, working_since text, primary key (product, blocks))`);
// unchecked_job: the last job asking the app's engineer for the check the watch couldn't run
db.exec('create table if not exists watch_apps (product text primary key, unchecked_job integer)');

// addresses: every public address it's served at (its shelf, its own domain). ordering: it takes orders. Without it,
// it's a site with ordering closed.
export type LiveApp = { slug: string; name: string; addresses: string[]; ordering: boolean };
// What a failure keeps from people: visits to its page, or orders
type Blocks = 'visits' | 'orders';
// What fails on the app now. blocks: what the failure keeps from people, as the watch saw it. at: the addresses where it
// fails, when it works at another of the app's, or null. plain: the failure in plain words. text: what the check saw,
// for the engineer only.
type Failure = { blocks: Blocks; at: string[] | null; plain: string; text: string };
// Why a check that would tell whether the app can sell couldn't run, so it's neither a failure nor a recovery
type Unchecked = 'stripe silent' | 'no checkout check';
// Whether the app can sell: its failure, null when it can, why that went unchecked, 'not taken' when it takes no orders,
// or 'closed' when it takes orders but the product said its ordering is closed on purpose for now
// (payments.orderingClosed).
type Orders = Failure | null | Unchecked | 'not taken' | 'closed';
// Whether its checkout is checked at all: not while it takes no orders, nor while its ordering is closed on purpose.
const checkoutChecked = (orders: Orders | undefined) => orders !== 'not taken' && orders !== 'closed';

// The network as the check sees it: a test plays the apps and Stripe.
// Redirects: the page may move, but the checkout check must answer itself.
type Redirects = 'follow' | 'manual';
export type Network = {
  get(url: string, redirects: Redirects, app: LiveApp): Promise<number>;
  paymentsReady(): Promise<boolean>;
};
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// as many as fetch follows
const MAX_REDIRECTS = 20;
// The app counts none of the watch's requests: they carry the app's watch mark, which no visitor has (metrics.ts). The
// check follows redirects itself, so the mark goes only to the app's own addresses and never to where one leads. A
// redirect away from http and https fails, as it does in a browser.
export const network: Network = {
  async get(url, redirects, app) {
    const { signal, stop } = patience(TIMEOUT_MS);
    try {
      return await follow(url, redirects, app, signal);
    } finally {
      stop();
    }
  },
  paymentsReady: payments.paymentsReady,
};

// Apps whose ability to sell went unchecked at the last look, and why, so the feed hears it once per spell
const unchecked = new Map<string, Unchecked>();
let busy = false;

export const start = () => {
  setInterval(tick, CHECK_MS);
};

// The check, then the daily checks. One's failure never holds up the other, nor the next tick.
export async function tick(now = Date.now(), net = network) {
  if (busy) return;
  busy = true;
  try {
    await check(now, net).catch(err => console.error('Watch: the check failed:', err));
    part('the daily checks', () => daily(now));
  } finally {
    busy = false;
  }
}

export async function check(now = Date.now(), net = network) {
  const apps = liveApps();
  for (const app of apps) {
    const { page, orders } = await probe(app, net, now);
    record(app, 'visits', page, orders, now);
    if (page) continue;
    if (orders === 'stripe silent' || orders === 'no checkout check') {
      if (unchecked.get(app.slug) !== orders) uncheckedSpell(app, orders);
      unchecked.set(app.slug, orders);
      if (orders === 'no checkout check') askForCheckout(app, now);
      continue;
    }
    unchecked.delete(app.slug);
    record(app, 'orders', checkoutChecked(orders) ? orders : null, orders, now);
  }
  const watchedProducts = db
    .prepare('select product from watch_outages union select product from watch_apps')
    .all() as { product: string }[];
  for (const { product } of watchedProducts) if (!apps.some(a => a.slug === product)) unwatch(product);
}

// From DAILY_HOUR on the company's clock. The email plan's check, the error scan and the refund check run once a day:
// one that fails, or can't run yet, goes again at the next tick. The check on each day's sales and ad spend runs at
// every tick, on the days whose numbers came in or changed since it last looked. One part's failure never holds up
// another. Mail goes out before any app is public, so the email plan's check runs without one.
export function daily(now = Date.now()) {
  const clock = companyClock(now);
  if (clock.hour < DAILY_HOUR) return;
  dailyPart('watch.emailsDay', clock.day, () => mailplan.checkMonth(clock.day));
  const apps = liveApps();
  if (!apps.length) return;
  dailyPart('watch.errorsDay', clock.day, () => triage.scanErrors(apps, now, clock.day));
  dailyPart('watch.refundsDay', clock.day, () => money.checkRefunds(apps, now));
  part('the money check', () => money.checkDays(apps, now));
}

// The timeout counts only the coordinator's idle time. An answer that arrives while it is busy on other work can be
// read only once it is free again.
function patience(ms: number) {
  const controller = new AbortController();
  const since = performance.eventLoopUtilization();
  let timer: NodeJS.Timeout;
  const wait = (left: number) => {
    timer = setTimeout(() => {
      const idle = performance.eventLoopUtilization(since).idle;
      if (idle < ms) return wait(ms - idle);
      controller.abort(new DOMException(`No answer within ${ms} ms`, 'TimeoutError'));
    }, left);
  };
  wait(ms);
  return { signal: controller.signal, stop: () => clearTimeout(timer) };
}

async function follow(url: string, redirects: Redirects, app: LiveApp, signal: AbortSignal) {
  for (let hops = 0; ; hops++) {
    const headers: Record<string, string> = { 'user-agent': 'HQ watch' };
    if (ownAddress(app, url)) headers['x-hq-watch'] = metrics.watchMark(app.slug);
    const response = await fetch(url, { redirect: 'manual', signal, headers });
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (redirects === 'manual' || !REDIRECTS.has(response.status) || !location) return response.status;
    if (hops === MAX_REDIRECTS) throw new Error(`More than ${MAX_REDIRECTS} redirects from ${url}`);
    const next = new URL(location, url);
    if (next.protocol !== 'http:' && next.protocol !== 'https:')
      throw new Error(`${url} redirects to a ${next.protocol} address`);
    url = next.href;
  }
}

// ---- up and able to sell
const liveApps = (): LiveApp[] =>
  listApps()
    .filter(a => a.status === 'live' && !a.platform && a.public.length)
    .map(a => ({ slug: a.slug, name: a.name, addresses: a.public, ordering: takesOrders(a.slug) }));

// What infra/products.py deploys taking orders, on top of `status: live` (infra/products.md, "Going public")
function takesOrders(slug: string) {
  const p = manifest(slug);
  const secrets = (p?.needs as { secrets?: unknown } | undefined)?.secrets;
  return (
    p?.partner_env === 'live' && Array.isArray(secrets) && secrets.includes('stripe') && !!approved(`live:${slug}`)
  );
}

// Its page's failure at any of its addresses, or null when it opens at each. And then whether it can sell: a page that
// fails leaves that unchecked.
async function probe(
  app: LiveApp,
  net: Network,
  now: number,
): Promise<{ page: Failure; orders?: never } | { page: null; orders: Orders }> {
  const pages = await failedAt(app, address => reach(address, 'follow', app, net));
  if (pages.length) return { page: failedCheck(app, 'visits', "its page doesn't open", 'its page', pages) };
  if (!app.ordering) return { page: null, orders: 'not taken' };
  return { page: null, orders: payments.orderingClosed(app.slug, now) ? 'closed' : await sells(app, net) };
}

// A checkout may fail because Stripe does. While Stripe doesn't answer, a failed checkout check proves nothing. While
// Stripe refuses payments, that is the failure everywhere.
async function sells(app: LiveApp, net: Network): Promise<Orders> {
  const path = checkoutPath(app.slug);
  const checkouts = path ? await failedAt(app, address => reach(new URL(path, address).href, 'manual', app, net)) : [];
  let ready: boolean;
  try {
    ready = await net.paymentsReady();
  } catch {
    return 'stripe silent';
  }
  if (!ready)
    return {
      blocks: 'orders',
      at: null,
      plain: "payments don't go through: Stripe refuses them",
      text: "live payments can't go through: Stripe refuses the live key, or says the account can't take charges",
    };
  if (checkouts.length)
    return failedCheck(app, 'orders', "its checkout doesn't work", `its checkout check (${path})`, checkouts);
  return path ? null : 'no checkout check';
}

// product.yaml's `watch.checkout`: a path under the app's address that answers 2xx itself, never a redirect, when a
// checkout could start now, and makes no order on the way. It is read relative to the app's address, so a shelf app's
// stays on its shelf.
function checkoutPath(slug: string) {
  const path = (manifest(slug)?.watch as { checkout?: unknown } | undefined)?.checkout;
  return typeof path === 'string' && /^[\w./~-]{1,200}$/.test(path) && !path.includes('..')
    ? path.replace(/^\/+/, '')
    : null;
}

// The app's addresses where a check failed, each with what it answered
type Failed = { address: string; answer: string };
async function failedAt(app: LiveApp, run: (address: string) => Promise<string | null>) {
  const failed: Failed[] = [];
  for (const address of app.addresses) {
    const answer = await run(address);
    if (answer) failed.push({ address, answer });
  }
  return failed;
}

async function reach(url: string, redirects: Redirects, app: LiveApp, net: Network) {
  try {
    const status = await net.get(url, redirects, app);
    return status >= 200 && status < 300 ? null : `answered ${status}`;
  } catch (err) {
    return (err as Error).name === 'TimeoutError'
      ? `didn't answer within ${TIMEOUT_MS / 1000} seconds`
      : "couldn't be reached";
  }
}

// The URL is at one of the app's addresses as the proxy routes it (infra/products.py): on its origin and under its path,
// but never on another product's shelf, which a host with an app at its root (the front's www and own domain) serves
// at /<slug>/, nor on a platform route (__care, __review), which reaches another service from under any app's path.
// Paths are compared as routedPath gives them.
function ownAddress(app: LiveApp, url: string) {
  const target = new URL(url);
  const path = routedPath(target.pathname);
  if (path === null || path.split('/').some(segment => segment.startsWith('__'))) return false;
  const shelves = listApps()
    .filter(a => a.slug !== app.slug && !a.slug.includes('/'))
    .map(a => `/${a.slug.toLowerCase()}/`);
  return app.addresses.some(address => {
    const own = new URL(address);
    const prefix = routedPath(own.pathname)?.replace(/\/?$/, '/');
    if (!prefix || target.origin !== own.origin || !(path + '/').startsWith(prefix)) return false;
    return prefix !== '/' || !shelves.some(shelf => (path + '/').startsWith(shelf));
  });
}

// A URL's path as Caddy's path matchers see it: unescaped, in lower case, its slashes merged. null when it doesn't
// unescape, or unescaping leaves a dot segment, whose route the check can't tell.
function routedPath(pathname: string) {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  path = path.toLowerCase().replace(/\/{2,}/g, '/');
  return path.split('/').some(segment => segment === '.' || segment === '..') ? null : path;
}

// plain, for the CEO: "its page doesn't open", and where when it works at another address. what, for the engineer:
// "its page", followed by each failed address and its answer.
function failedCheck(app: LiveApp, blocks: Blocks, plain: string, what: string, failed: Failed[]): Failure {
  const at = failed.length < app.addresses.length ? failed.map(f => f.address) : null;
  return {
    blocks,
    at,
    plain: at ? `${plain} at ${listed(at)}` : plain,
    text: failed.map(f => `${what} at ${f.address} ${f.answer}`).join('; '),
  };
}

// What one check saw of what the outage blocks: its failure, or null when that works. orders: whether the app can sell,
// as the same check saw it, for the line that ends an outage.
function record(app: LiveApp, blocks: Blocks, failure: Failure | null, orders: Orders | undefined, now: number) {
  const was = outageOf(app.slug, blocks);
  if (!failure) {
    if (was.failures) pass(app, blocks, was, orders, now);
    return;
  }
  const since = was.failing_since ?? new Date(now).toISOString();
  const failures = was.failures + 1;
  db.prepare(
    `insert into watch_outages (product, blocks, failures, failing_since, failure) values (?, ?, ?, ?, ?)
    on conflict (product, blocks) do update set failures = excluded.failures, failing_since = excluded.failing_since,
    failure = excluded.failure, passes = 0, working_since = null`,
  ).run(app.slug, blocks, failures, since, failure.text);
  if (failures === FAILURES)
    publish({ type: 'log', agent: engineerOf(app.slug), text: `Watch: ${problem(app, since, failure)}` });
  if (failures >= FAILURES) repair(app, was, since, failure, now);
  const spent = spentDays(app.slug, now);
  const told = alarms.isOn(alarmOf(app.slug, blocks));
  if (failures >= FAILURES && !told && (spent.length || now - Date.parse(since) >= ALERT_AFTER_MS))
    alert(app, since, failure, spent, now);
}

// An outage's row in watch_outages, or NO_OUTAGE
type Outage = {
  failures: number;
  failing_since: string | null;
  job: number | null;
  repairs: number;
  job_ended: string | null;
  passes: number;
  working_since: string | null;
};
const NO_OUTAGE: Outage = {
  failures: 0,
  failing_since: null,
  job: null,
  repairs: 0,
  job_ended: null,
  passes: 0,
  working_since: null,
};
const outageOf = (slug: string, blocks: Blocks) =>
  (db.prepare('select * from watch_outages where product = ? and blocks = ?').get(slug, blocks) as
    Outage | undefined) ?? NO_OUTAGE;

// A check that saw it work. A single failure before it is forgotten. An outage ends once RECOVERIES checks in a row saw
// it work. Until then it keeps its jobs, its settle clock and its alarm, and nobody hears of it.
function pass(app: LiveApp, blocks: Blocks, was: Outage, orders: Orders | undefined, now: number) {
  const passes = was.passes + 1;
  if (was.failures < FAILURES || passes >= RECOVERIES) return recover(app, blocks, was, orders, now);
  db.prepare(
    'update watch_outages set passes = ?, working_since = coalesce(working_since, ?) where product = ? and blocks = ?',
  ).run(passes, new Date(now).toISOString(), app.slug, blocks);
}

// The outage is over: its line, and its alarm ends with it, a short job telling the CEO. Its job stays, so the outage
// coming back while the job is at work is that job's to fix.
function recover(app: LiveApp, blocks: Blocks, was: Outage, orders: Orders | undefined, now: number) {
  if (was.failures >= FAILURES) {
    const text = backLine(app, blocks, orders, was, now);
    publish({ type: 'log', agent: engineerOf(app.slug), text: `Watch: ${text}` });
    endAlarm(app.slug, blocks, text, now);
  }
  db.prepare(
    `update watch_outages set failures = 0, failing_since = null, failure = null, repairs = 0, job_ended = null,
    passes = 0, working_since = null where product = ? and blocks = ?`,
  ).run(app.slug, blocks);
}

// What works again, from what the same check saw of whether the app can sell
function backLine(app: LiveApp, blocks: Blocks, orders: Orders | undefined, was: Outage, now: number) {
  const working = was.working_since ? Date.parse(was.working_since) : now;
  const minutes = Math.max(1, Math.round((working - Date.parse(was.failing_since!)) / MINUTE_MS));
  const after = `after about ${minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`}`;
  if (orders === null || (!checkoutChecked(orders) && blocks === 'visits')) return `${app.name} works again, ${after}.`;
  if (orders === 'not taken')
    return `${app.name} no longer takes orders, so the watch stopped checking whether people can buy it.`;
  if (orders === 'closed')
    return (
      `${app.name}'s checkout isn't broken: its ordering is closed on purpose for now. The watch checks whether people ` +
      'can buy it again once ordering reopens.'
    );
  if (orders === 'stripe silent' || orders === 'no checkout check' || !orders)
    return `${app.name}'s page opens again, ${after}. Whether people can buy it wasn't checked yet.`;
  return `${app.name}'s page opens again, ${after}, but ${orders.plain}.`;
}

// A job for the app's engineer when the outage has none at work: at its start, and when its job ended with no fix of it
// in review and the outage still fails SETTLE_MS on. At most REPAIRS jobs an outage: the last one brings it to the board
// if it can't be fixed.
function repair(app: LiveApp, was: Outage, since: string, failure: Failure, now: number) {
  if (atWork(was.job)) return;
  if (!was.repairs) return handOff(app, since, failure, was, now);
  if (was.repairs >= REPAIRS) return;
  if (!was.job_ended)
    db.prepare('update watch_outages set job_ended = ? where product = ? and blocks = ?').run(
      new Date(now).toISOString(),
      app.slug,
      failure.blocks,
    );
  else if (now - Date.parse(was.job_ended) >= SETTLE_MS) handOff(app, since, failure, was, now);
}

// The outage's next job for the app's engineer, due as soon as it can on a one-task thread in its product's project,
// in one step with it (made.ts madeForProduct). An ended job before it is named, and so is the app's other outage's job
// at work, since one cause may be behind both.
function handOff(app: LiveApp, since: string, failure: Failure, was: Outage, now: number) {
  const other = db
    .prepare(
      `select j.id from watch_outages w join jobs j on j.id = w.job where w.product = ? and w.blocks != ? and ${AT_WORK}`,
    )
    .get(app.slug, failure.blocks) as { id: number } | undefined;
  const repairs = was.repairs + 1;
  const checks = app.ordering
    ? 'its page, its checkout check (product.yaml watch.checkout) at each of its addresses and whether Stripe takes live payments'
    : 'its page at each of its addresses';
  const notes = [
    ...(was.job ? [`Job #${was.job}, an earlier job about it, has ended, and no fix of it is in review.`] : []),
    ...(other ? [`Job #${other.id} about its other outage is open too: one cause may be behind both.`] : []),
  ];
  const settle = SETTLE_MS / MINUTE_MS;
  inOneStep(() => {
    const job = jobs.createJob({
      agent: engineerOf(app.slug),
      title: `${headline(app, failure)}: ${failure.text}`,
      prompt:
        `${app.name} (${app.addresses.join(', ')}) has failed HQ's watch since ${company.companyTime(Date.parse(since))}: ` +
        `${failure.text}. ${consequence(app, failure)} ${notes.join(' ')}${notes.length ? ' ' : ''}` +
        `The watch checks ${checks} every ${CHECK_MS / MINUTE_MS} minutes.\n\n` +
        "See first whether it works again (HQ's feed says so), then find the cause and fix it. A fix of yours for it " +
        "may already wait for review or deployment (an earlier job's pull request): then don't make another. See that " +
        "one through, and say so in this job's result. The watch queues no new job about the outage while this job's " +
        `pull request is in review, and once it's over, only if the outage still fails ${settle} minutes later, time ` +
        `for a merged fix to deploy. It queues ${REPAIRS} jobs about an outage at most, and this is job ${repairs}` +
        `${repairs === REPAIRS ? ': if it still fails after it, bring it to the board as one card' : ''}.\n\n` +
        `The CEO hears of it if ad spend was recorded for ${app.name} in the last ${SPENDING_DAYS} days or it fails ` +
        `for ${ALERT_AFTER_MS / MINUTE_MS} minutes, and when it works again, so don't write the board about the outage ` +
        'yourself. Bring it to the board only if the fix needs the board, as one card.',
    });
    madeForProduct(app.slug, job, { asap: now });
    db.prepare('update watch_outages set job = ?, repairs = ?, job_ended = null where product = ? and blocks = ?').run(
      job.id,
      repairs,
      app.slug,
      failure.blocks,
    );
  });
}

// The days of the last SPENDING_DAYS with ad spend recorded for the app
type Spent = { day: string; cents: number };
function spentDays(slug: string, now: number): Spent[] {
  const today = company.companyDay(now);
  const byDay = spend.spendByDay(slug, metrics.addDays(today, 1 - SPENDING_DAYS), today);
  return [...byDay].filter(([, cents]) => cents > 0).map(([day, cents]) => ({ day, cents }));
}

// The CEO's alarm says what the records show: the days ad spend was recorded, not whether the ads run now, and who
// records it, who runs them. One who is no longer on the team leaves who runs them unknown.
function alert(app: LiveApp, since: string, failure: Failure, spent: Spent[], now: number) {
  const recorder = spent.length ? spend.spendRecordedBy(app.slug, spent[0].day, spent.at(-1)!.day) : null;
  const wasted = failure.blocks === 'orders' ? "visits that can't buy" : "visits that can't open it";
  const leadTo = failure.at ? ` and lead to ${listed(failure.at)}` : '';
  const recorded = spent.map(s => `${s.day} (${payments.euros(s.cents, 'eur')})`).join(', ');
  const adsBy =
    recorder && jobs.findAgent(recorder)
      ? `${nameOf(recorder)} runs them.`
      : "Who runs them now isn't known: whoever recorded their spend is no longer on the team.";
  const ads = spent.length
    ? `Ad spend was recorded for it on ${recorded}. If its ads still run${leadTo}, they pay for ${wasted}. ${adsBy} ` +
      'Whether they pause until it works again is your call.'
    : `No ad spend was recorded for it in the last ${SPENDING_DAYS} days.`;
  const problemLine = problem(app, since, failure);
  alarms.raise(
    alarmOf(app.slug, failure.blocks),
    problemLine,
    {
      title: headline(app, failure),
      urgent: true,
      word: null, // (one app's outage of many: the CEO names its job's task code.)
      prompt:
        `${problemLine} ${nameOf(engineerOf(app.slug))} has an urgent job to fix it. ${ads} HQ's watch checks it ` +
        `every ${CHECK_MS / MINUTE_MS} minutes, and you hear when it works again.`,
    },
    now,
  );
}

// The failure in a title, and only where it fails when it works elsewhere
function headline(app: LiveApp, failure: Failure) {
  const where = failure.at ? ` at ${listed(failure.at)}` : '';
  return failure.blocks === 'orders' ? `${app.name} can't take orders${where}` : `${app.name} is down${where}`;
}

// The failure in plain words, for the CEO and the feed
const problem = (app: LiveApp, since: string, failure: Failure) =>
  `${app.name} has had a problem since ${company.companyTime(Date.parse(since))}: ${failure.plain}. ` +
  consequence(app, failure);

// What the failure keeps from people, in a sentence: only where it fails, when it works elsewhere
function consequence(app: LiveApp, failure: Failure) {
  const working = listed(app.addresses.filter(address => !failure.at?.includes(address)));
  if (failure.blocks === 'orders')
    return failure.at
      ? `Nobody can buy it there until it's back. People can still buy it at ${working}.`
      : "Nobody can buy it until it's back.";
  return failure.at
    ? `Visitors can't open it there until it's back. It still opens at ${working}.`
    : "Visitors can't open it until it's back.";
}

const listed = (addresses: string[]) => addresses.join(' and ');

// A check that couldn't run, said once a spell in the feed
function uncheckedSpell(app: LiveApp, why: Unchecked) {
  const again = `The watch asks again in ${CHECK_MS / MINUTE_MS} minutes.`;
  const text =
    why === 'stripe silent'
      ? `Watch: Stripe didn't answer, so ${app.name}'s live payments went unchecked. ${again}`
      : `Watch: ${app.name} takes orders, but the watch has no way yet to check its checkout, so whether people can ` +
        `buy it went unchecked. ${nameOf(engineerOf(app.slug))} is to add one. ${again}`;
  publish({ type: 'log', agent: engineerOf(app.slug), text });
}

// An app that takes orders without a checkout check is the engineer's to fix: a job, again a day after the last one
// ended, on a one-task thread with no window (made.ts made).
function askForCheckout(app: LiveApp, now: number) {
  const asked = db
    .prepare(
      `select 1 from watch_apps w join jobs j on j.id = w.unchecked_job where w.product = ?
      and (j.status in ('queued', 'running', 'blocked') or j.finished > ?)`,
    )
    .get(app.slug, new Date(now - DAY_MS).toISOString());
  if (asked) return;
  const job = jobs.createJob({
    agent: engineerOf(app.slug),
    title: `${app.name} takes orders, but the watch can't check its checkout`,
    prompt:
      `${app.name} (${app.addresses.join(', ')}) takes orders, but its product.yaml has no valid watch.checkout. Until it has one, ` +
      "HQ's watch can't tell whether people can buy it: it never reports the app able to sell, nor an outage of its " +
      'checkout. An outage of its checkout it already reported stays open.\n\n' +
      "Add watch.checkout: a path under the app's address that answers 2xx itself, not through a redirect, when a " +
      'checkout could start now. It does what a buy does up to the payment and makes no order (infra/products.md, ' +
      `"HQ's watch").`,
  });
  madeForProduct(app.slug, job);
  db.prepare(
    'insert into watch_apps (product, unchecked_job) values (?, ?) on conflict (product) do update set unchecked_job = excluded.unchecked_job',
  ).run(app.slug, job.id);
}

const atWork = (job: number | null) =>
  !!job && !!db.prepare(`select 1 from jobs j where j.id = ? and ${AT_WORK}`).get(job);

// An app that stopped being live isn't watched any more. Its alarms end, saying the watch ended: whether the app works
// again wasn't checked.
function unwatch(slug: string) {
  const name = listApps().find(a => a.slug === slug)?.name ?? slug;
  const text = `HQ stopped watching ${name}: it's no longer live. Whether it works again wasn't checked.`;
  for (const blocks of ['visits', 'orders'] as const) endAlarm(slug, blocks, text);
  for (const table of ['watch_outages', 'watch_apps']) db.prepare(`delete from ${table} where product = ?`).run(slug);
}

const alarmOf = (slug: string, blocks: Blocks) => `watch.${slug}.${blocks}`;
const endAlarm = (slug: string, blocks: Blocks, text: string, now = Date.now()) =>
  alarms.end(alarmOf(slug, blocks), { title: text, prompt: text }, now);

const engineerOf = (slug: string) => ownerOf(slug).agent;
const nameOf = (agent: string) => jobs.findAgent(agent)?.name ?? agent;

// ---- once a day
const companyClock = (at: number) => {
  const f = company.companyFormats();
  return { day: f.dayAt(at), hour: Math.floor(f.hourAt(at)) };
};

function dailyPart(key: string, day: string, run: () => boolean) {
  part(key, () => {
    if (setting(key) !== day && run()) remember(key, day);
  });
}

function part(name: string, run: () => void) {
  try {
    run();
  } catch (err) {
    console.error(`Watch: ${name} failed:`, err);
  }
}
