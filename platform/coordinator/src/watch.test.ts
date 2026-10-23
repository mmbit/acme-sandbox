// node --test src/watch.test.ts   (the harness, the test company's Hello made live; the test plays the app and Stripe)
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { harness, type Running } from './harness.ts';
import type { Network } from './watch.ts';

// Bolt owns Hello and is the process role, Penny is finance. Hello's repairs go to Bolt's shop, the project its
// product.yaml declares, the CEO's alarms to Juno's desk, each a one-task thread there.
const PROJECTS = `made:
  alarms: { hq: desk }
projects:
  - { id: shop, name: The shop, owner: bolt }
  - { id: desk, name: The desk, owner: juno }
`;
const h = await harness('watch', {
  env: { PUBLIC_HOST: 'hq.example.test' },
  before: repo => writeFileSync(`${repo}/company/projects.yaml`, PROJECTS),
});
const { db, repo, dataDir } = h;
const { check, daily, tick, network, ALERT_AFTER_MS, SETTLE_MS } = await import('./watch.ts');
const { remember } = await import('./db.ts');
const ordering = await import('./ordering.ts');
const { CLOSED_MS } = await import('./payments.ts');
const { watchMark, tokenFor } = await import('./metrics.ts');
const { recordSpend } = await import('./spend.ts');

const MINUTE = 60_000,
  DAY = 24 * 60 * MINUTE,
  PAGE = 'https://www.example.test/hello/',
  CHECKOUT = `${PAGE}api/ready`,
  DOMAIN = 'https://hello.example',
  DOMAIN_CHECKOUT = `${DOMAIN}/api/ready`;
// The test company's clock is Amsterdam's, on summer time in October until the 25th
const at = (day: string, time = '07:30') => Date.parse(`${day}T${time}:00+02:00`);
const T0 = at('2026-10-05', '10:00');

// Live, it takes orders once the board approved its launch: on live partners, with Stripe for its payments
const ORDERING = 'partner_env: live\nneeds:\n  secrets: [stripe]\n';
const product = (status: string, watch = 'watch:\n  checkout: api/ready\n', ordering = ORDERING) =>
  writeFileSync(
    `${repo}/products/hello/product.yaml`,
    `name: Hello\nstatus: ${status}\nowner: bolt\nproject: shop\n${ordering}${watch}`,
  );
// What the board approved for Hello: its launch (it takes orders) or only its site (the approval record a card's Approve
// leaves; the board's approvals are tested in apps.test.ts)
type Grant = 'live' | 'site';
const approve = (grant: Grant) => {
  rmSync(`${dataDir}/approvals`, { recursive: true, force: true });
  mkdirSync(`${dataDir}/approvals`);
  writeFileSync(
    `${dataDir}/approvals/${grant}-hello.json`,
    JSON.stringify({ grant: `${grant}:hello`, request: 1, approved: '2026-10-01T10:00:00Z' }),
  );
};

// The app and Stripe as the watch reaches them: every address answers 200 but the failing ones, and a redirecting one
// answers 302 to a request that doesn't follow it
const failing = new Set<string>(),
  redirecting = new Set<string>(),
  asked: string[] = [];
type StripeState = 'ready' | 'refusing' | 'silent';
let stripe: StripeState = 'ready';
let stripeAsked = 0;
const net: Network = {
  get: async (url, redirects) => {
    asked.push(url);
    if (failing.has(url)) return 503;
    return redirecting.has(url) && redirects === 'manual' ? 302 : 200;
  },
  paymentsReady: async () => {
    stripeAsked++;
    if (stripe === 'silent') throw new Error('Stripe: 500');
    return stripe === 'ready';
  },
};

// Each test reads the jobs and feed lines made since it began. The watch's own record of the apps and the
// numbers it reads start empty: no route clears them.
let firstJob = 0,
  since = '';
beforeEach(async () => {
  const tables = 'watch_outages watch_apps alarms watch_errors watch_refunds watch_days care_numbers mailout_days';
  for (const table of `${tables} ad_spend metric_orders metric_order_days`.split(' ')) db.exec(`delete from ${table}`);
  db.exec("delete from settings where key like 'watch.%' or key like 'pay.closed.%'");
  rmSync(`${dataDir}/app-errors.json`, { force: true });
  failing.clear();
  redirecting.clear();
  asked.length = 0;
  stripe = 'ready';
  stripeAsked = 0;
  product('live');
  approve('live');
  limitEmails(null);
  firstJob = Math.max(0, ...h.jobs.listJobs().map(j => j.id));

  await new Promise(r => setTimeout(r, 2));
  since = new Date().toISOString();
});

// The jobs as HQ lists them, and as the worker hands one to its agent (its prompt): claimed with whatever was queued
// before it, all left running
type Job = { id: number; title: string; status: string };
const jobsFor = (agent: string) =>
  (h.jobs.listJobs() as unknown as (Job & { agent: string })[])
    .filter(j => j.agent === agent && j.id > firstJob)
    .reverse();
const claimed = new Map<number, Running>();
const run = async (id: number) => {
  while (!claimed.has(id)) {
    const job = await h.claim();
    assert.ok(job, `job #${id} is queued`);
    claimed.set(job.id, job);
  }
  return claimed.get(id)!;
};
const prompt = async (job: Job) => (await run(job.id)).prompt as string;
// A job's thread and that thread's window
const placed = (job: Job) =>
  Object.values(
    db
      .prepare('select j.thread, t.deadline, t.aim from jobs j left join threads t on t.id = j.thread where j.id = ?')
      .get(job.id)!,
  );
// A job due as soon as it can from `t`, on a one-task thread in `project`: its deadline is its aim, and its latest start t
const dueAsap = (job: Job, project: string, t: number) => {
  const [thread, deadline, aim] = placed(job);
  assert.deepEqual([thread, aim], [`${project}/job-${job.id}`, deadline]);
  assert.equal(ordering.current(t).timings.get(job.id)!.latestStart, t, 'its latest start is then');
};
// The worker's finish of a job the watch made
const finish = async (job: Job, report: Record<string, unknown> = {}) =>
  assert.equal((await h.finish(await run(job.id), { status: 'done', ...report })).status, 200);
const outageJobs = () => jobsFor('bolt').filter(j => !j.title.includes("can't check its checkout"));
// The CEO's (Juno's) jobs: an outage's alarm, and the short one when it's over
const alarms = () => jobsFor('juno').filter(j => /^Hello (is down|can't take orders)/.test(j.title));
const ends = () => jobsFor('juno').filter(j => !alarms().some(a => a.id === j.id));
// hq summary, as a job of the CEO's reads it
const summary = async (job: Job) => (await h.agent('summary', (await run(job.id)).token)).body.text as string;
// Hello's live payments say its ordering is closed on purpose, as POST /api/pay/expire/open records it (at the test's
// time: the route stamps the real one)
const saysClosed = (at: number) => remember('pay.closed.hello', new Date(at).toISOString());
// The watch's lines in HQ's feed
const said = async () =>
  (await h.feed()).filter(e => (e as { ts?: string }).ts! >= since && e.text?.startsWith('Watch:')).map(e => e.text);

// org.yaml's watch.emailsPerMonth, or none
const orgFile = `${repo}/company/org.yaml`;
const orgChart = readFileSync(orgFile, 'utf8');
const limitEmails = (perMonth: number | null) =>
  writeFileSync(orgFile, perMonth === null ? orgChart : `${orgChart}\nwatch:\n  emailsPerMonth: ${perMonth}\n`);
// The emails the service took on a day, as care-numbers.ts keeps the chat's (partial: today so far) and mailout.ts HQ's
// (in the table: their routes stamp today, and these days are the test's)
const chatSent = (app: string, day: string, emails: number, partial = false) =>
  db
    .prepare('insert or replace into care_numbers (app, day, counts, partial, at) values (?, ?, ?, ?, ?)')
    .run(app, day, JSON.stringify({ conversations: 4, emails }), partial ? 1 : 0, `${day}T23:00:00Z`);
const hqSent = (day: string, emails: number) =>
  db
    .prepare(
      'insert into mailout_days (day, emails) values (?, ?) on conflict (day) do update set emails = emails + excluded.emails',
    )
    .run(day, emails);
const emailJobs = () => jobsFor('bolt').filter(j => j.title.includes('emails sent'));

// Each part is in the text: an address, a status, a number
const mentions = (text: string, ...parts: string[]) => {
  for (const part of parts) assert.ok(text.includes(part), `${JSON.stringify(text)} names ${part}`);
};

// Checks every 5 minutes from a time on, as many as asked: returns the time of the next one
async function checks(from: number, n: number) {
  for (let i = 0; i < n; i++) await check(from + i * 5 * MINUTE, net);
  return from + n * 5 * MINUTE;
}

test('nothing is watched while no app is live', async () => {
  product('preview');
  failing.add(PAGE);
  await check(T0, net);
  daily(at('2026-10-05'));
  assert.deepEqual(asked, []);
  const made = h.jobs.listJobs().filter(j => j.id > firstJob);
  assert.deepEqual(made, []);
});

test('a checkout failing twice in a row is one urgent job; an hour of it is one urgent alarm for the CEO, in hq summary; working again, the CEO hears', async () => {
  await check(T0, net);
  assert.deepEqual(asked, [PAGE, CHECKOUT]);
  failing.add(CHECKOUT);
  await check(T0 + 5 * MINUTE, net);
  assert.equal(jobsFor('bolt').length, 0, 'one failed check is no outage');
  await check(T0 + 10 * MINUTE, net);
  assert.equal(jobsFor('bolt').length, 1);
  const [job] = jobsFor('bolt');
  mentions(job.title, 'orders', 'api/ready', PAGE, '503');
  dueAsap(job, 'shop', T0 + 10 * MINUTE);
  assert.deepEqual(alarms(), [], "no money going out and not failing an hour: the CEO isn't told yet");

  await check(T0 + 5 * MINUTE + ALERT_AFTER_MS - MINUTE, net);
  assert.equal(alarms().length, 0);
  await checks(T0 + 5 * MINUTE + ALERT_AFTER_MS, 2);
  assert.equal(alarms().length, 1, 'one alarm per outage');
  assert.equal(jobsFor('bolt').length, 1);
  const [alarm] = alarms();
  mentions(alarm.title, 'Hello', 'orders');
  const raised = T0 + 5 * MINUTE + ALERT_AFTER_MS;
  dueAsap(alarm, 'desk', raised);
  const brief = await prompt(alarm);
  mentions(brief, 'checkout', 'buy', 'Bolt has an urgent job to fix it', 'is your call');
  assert.doesNotMatch(
    brief + (await said()).join('\n'),
    /api\/ready|503/,
    "the check's path and answer are the engineer's",
  );
  assert.ok((await said()).some(s => s.includes('checkout') && s.includes('buy')));
  assert.match(
    await summary(alarm),
    new RegExp(`^- Hello has had a problem since .*: its checkout doesn't work\\. .*\\(your job #${alarm.id}\\)$`, 'm'),
  );

  failing.clear();
  await checks(T0 + 15 * MINUTE + ALERT_AFTER_MS, 3);
  const [over] = ends();
  assert.match(over.title, /works again.*\b70 minutes/);
  assert.deepEqual(placed(over), [`desk/job-${over.id}`, null, null], 'the end notice has no window');
  assert.doesNotMatch(await summary(alarm), /Hello has had a problem/);
  assert.equal((await said()).filter(s => s.includes('works again')).length, 1);
  assert.deepEqual((await h.board('/api/requests')).body, [], 'and the board gets no card');
});

test('an outage that works for one check between failures stays one outage, within its jobs and its alarm', async () => {
  recordSpend({ app: 'hello', day: '2026-10-05', euros: '20' }, 'penny', T0);
  failing.add(CHECKOUT);
  let next = T0;
  for (let cycle = 0; cycle < 5; cycle++) {
    next = await checks(next, 2);
    for (const job of outageJobs()) if (job.status !== 'done') await finish(job);
    failing.delete(CHECKOUT);
    next = await checks(next, 1);
    failing.add(CHECKOUT);
  }
  assert.equal(alarms().length, 1, 'one alarm');
  assert.equal(outageJobs().length, 2, 'its first job, and one more once the outage still failed 30 minutes on');
  assert.deepEqual(ends(), [], 'the CEO heard of no recovery');
  assert.ok(!(await said()).some(s => s.includes('works again')));

  failing.clear();
  await checks(next, 3);
  assert.equal(ends().length, 1);
  assert.equal((await said()).filter(s => s.includes('works again')).length, 1);
});

// Its shelf answers the watch's fetch itself (only page loads move to the domain), so a domain that fails must not read
// as an app that still opens on its shelf
test('a product with a domain of its own is checked there alone: its shelf, which sends visitors there, never counts as working', async () => {
  product('live', undefined, `${ORDERING}domain: hello.example\n`);
  recordSpend({ app: 'hello', day: '2026-10-05', euros: '20' }, 'penny', T0);
  await check(T0, net);
  assert.deepEqual(asked, [DOMAIN, DOMAIN_CHECKOUT]);

  failing.add(DOMAIN);
  const next = await checks(T0 + 5 * MINUTE, 2);
  assert.equal(outageJobs().length, 1);
  mentions(outageJobs()[0].title, DOMAIN, '503');
  const page = await prompt(alarms()[0]),
    told = page + (await said()).join('\n');
  mentions(page, "Visitors can't open it until it's back.");
  assert.ok(!told.includes(PAGE), 'nothing names the shelf');
  assert.doesNotMatch(told, /still opens/);

  failing.clear();
  failing.add(DOMAIN_CHECKOUT);
  await checks(next, 3);
  mentions(outageJobs()[1].title, 'orders', DOMAIN, 'api/ready', '503');
  const checkout = await prompt(alarms()[1]);
  mentions(checkout, "Nobody can buy it until it's back.");
  assert.ok(!checkout.includes(PAGE));
  assert.doesNotMatch(checkout + (await said()).join('\n'), /api\/ready|503|People can still buy it/);
});

test('with the front public at a domain of its own, a shelf is checked there, never through www, which only redirects', async () => {
  const shop = 'https://shop.example';
  mkdirSync(`${repo}/products/front`, { recursive: true });
  writeFileSync(
    `${repo}/products/front/product.yaml`,
    'name: Front\nstatus: live\nowner: bolt\ndomain: shop.example\n',
  );
  writeFileSync(
    `${dataDir}/approvals/site-front.json`,
    JSON.stringify({ grant: 'site:front', request: 2, approved: '2026-10-01T10:00:00Z' }),
  );
  redirecting.add(PAGE).add(CHECKOUT);
  try {
    await check(T0, net);
    assert.deepEqual(asked, [shop, `${shop}/hello/`, `${shop}/hello/api/ready`]);
    await checks(T0 + 5 * MINUTE, 2);
  } finally {
    rmSync(`${repo}/products/front`, { recursive: true });
  }
  assert.deepEqual(outageJobs(), []);
});

test("an outage's job with its fix in review gets no successor; one that ended without one gets one if the outage still fails 30 minutes on, and an outage gets 3 at most", async () => {
  const settle = SETTLE_MS / (5 * MINUTE);
  failing.add(CHECKOUT);
  let next = await checks(T0, 2);
  const [first] = outageJobs();
  await finish(first, {
    pr: 1,
    branch: `job/${first.id}`,
    sha: 'a'.repeat(40),
    files: ['products/hello/app/server.js'],
  });
  next = await checks(next, 3 * settle);
  assert.equal(outageJobs().length, 1, 'its fix waits for review');

  // merged, as the review merges it (review.test.ts)
  db.prepare("update prs set status = 'merged' where number = 1").run();
  next = await checks(next, settle);
  assert.equal(outageJobs().length, 1, 'its merged fix may still be deploying');
  next = await checks(next, 1);
  assert.equal(outageJobs().length, 2);
  assert.match(await prompt(outageJobs()[1]), new RegExp(`Job #${first.id}\\b`));

  await finish(outageJobs()[1]);
  next = await checks(next, settle + 1);
  assert.equal(outageJobs().length, 3, 'ended without a fix in review');
  await finish(outageJobs()[2]);
  await checks(next, 4 * settle);
  assert.equal(outageJobs().length, 3);
});

test("ad spend recorded by someone no longer on the team: the CEO hears that who runs the ads isn't known", async () => {
  recordSpend({ app: 'hello', day: '2026-10-05', euros: '20' }, 'ghost', T0);
  failing.add(PAGE);
  await checks(T0, 2);
  const brief = await prompt(alarms()[0]);
  mentions(
    brief,
    "Who runs them now isn't known",
    'no longer on the team',
    'Whether they pause until it works again is your call',
  );
  assert.doesNotMatch(brief, /Bolt runs them/, 'no record says Bolt runs them');
});

test('a checkout check answers itself, and without one an app that takes orders is never called able to sell', async () => {
  const noCheck = 'no way yet to check its checkout';
  const asking = () => jobsFor('bolt').filter(j => j.title.includes("can't check its checkout"));
  redirecting.add(CHECKOUT);
  await checks(T0, 2);
  assert.equal(jobsFor('bolt').length, 1);
  mentions(jobsFor('bolt')[0].title, 'api/ready', PAGE, '302'); // a redirect to a working page is no answer

  product('live', '');
  await checks(T0 + 10 * MINUTE, 2);
  product('live', 'watch:\n  checkout: ../ready\n');
  await checks(T0 + 20 * MINUTE, 2);
  assert.equal(jobsFor('bolt').length, 2, 'a missing or invalid setting is one job');
  assert.equal(asking().length, 1);
  assert.deepEqual(placed(asking()[0]), [`shop/job-${asking()[0].id}`, null, null], 'with no window');
  assert.equal((await said()).filter(s => s.includes(noCheck)).length, 1, 'one line a spell');
  assert.ok(!(await said()).some(s => s.includes('works again')), 'nor a recovery');

  await finish(asking()[0]);
  // when it ended, on the test's clock (the worker's finish stamps the real one)
  db.prepare('update jobs set finished = ? where id = ?').run(new Date(T0 + 25 * MINUTE).toISOString(), asking()[0].id);
  await check(T0 + 30 * MINUTE + DAY - 10 * MINUTE, net);
  assert.equal(asking().length, 1, 'a day after the job ended, not before');
  await check(T0 + 30 * MINUTE + 2 * DAY, net);
  assert.equal(asking().length, 2, 'still missing two days on: asked again');
  assert.equal((await said()).filter(s => s.includes(noCheck)).length, 1, 'in the same spell');

  product('live');
  redirecting.clear();
  await checks(T0 + 35 * MINUTE + 2 * DAY, 3);
  assert.equal((await said()).filter(s => s.includes('works again')).length, 1);
});

test('a page that opens again ends its outage, though the checkout went unchecked', async () => {
  failing.add(PAGE);
  await checks(T0, 2);
  await check(T0 + 5 * MINUTE + ALERT_AFTER_MS, net);

  failing.clear();
  product('live', '');
  await checks(T0 + 10 * MINUTE + ALERT_AFTER_MS, 3);
  assert.match(ends()[0].title, /opens again.*\b70 minutes.*wasn't checked/);

  failing.add(CHECKOUT);
  product('live');
  await checks(T0 + 25 * MINUTE + ALERT_AFTER_MS, 2);
  assert.equal(outageJobs().length, 2, 'a checkout that fails after is an outage of its own');
  mentions(outageJobs()[1].title, 'orders');
});

test('a checkout outage outlasts a page outage: the page opening again with the checkout unchecked leaves its alarm on', async () => {
  failing.add(CHECKOUT);
  await checks(T0, 2);
  let next = await checks(T0 + 5 * MINUTE + ALERT_AFTER_MS, 1);
  assert.equal(alarms().length, 1);
  mentions(alarms()[0].title, 'orders');

  failing.add(PAGE);
  next = await checks(next, 1);
  failing.delete(PAGE);
  product('live', '');
  next = await checks(next, 3);
  assert.deepEqual(ends(), [], 'one failure of its page, then the page opens, but the checkout went unchecked');
  assert.ok(!(await said()).some(s => s.includes('opens again') || s.includes('works again')));

  failing.add(PAGE);
  next = await checks(next, 2);
  assert.equal(outageJobs().length, 2, 'the page outage has a job of its own');
  mentions(await prompt(outageJobs()[1]), `Job #${outageJobs()[0].id} `);
  failing.delete(PAGE);
  next = await checks(next, 3);
  assert.deepEqual(ends(), [], 'a page outage that ends ends only itself, and the CEO never heard of that one');
  assert.ok((await said()).some(s => s.includes('opens again') && s.includes("wasn't checked")));

  product('live');
  next = await checks(next, 1);
  assert.deepEqual(ends(), [], 'the checkout still fails');
  failing.clear();
  await checks(next, 3);
  assert.equal(ends().length, 1);
  assert.match(ends()[0].title, /works again/);
});

test("a page outage's alarm ends when its page opens, while its checkout fails", async () => {
  failing.add(PAGE);
  await checks(T0, 2);
  const next = await checks(T0 + 5 * MINUTE + ALERT_AFTER_MS, 1);
  assert.ok(!alarms()[0].title.includes('orders'));

  failing.clear();
  failing.add(CHECKOUT);
  await checks(next, 3);
  assert.match(ends()[0].title, /opens again.*\b70 minutes.*checkout/);
  assert.equal(
    outageJobs().length,
    2,
    'the checkout failing is its own outage, with a job of its own naming the open one',
  );
  mentions(await prompt(outageJobs()[1]), `Job #${outageJobs()[0].id} `);
});

// (this test and the next)
test('an app that says its ordering is closed on purpose is checked on its pages alone, ends its checkout outage saying so, and counts again once it stops saying it', async () => {
  failing.add(CHECKOUT);
  let next = await checks(T0, 2);
  next = await checks(next + ALERT_AFTER_MS, 1);
  assert.equal(outageJobs().length, 1);
  assert.equal(alarms().length, 1);

  asked.length = 0;
  stripeAsked = 0;
  for (let i = 0; i < 3; i++) {
    saysClosed(next - MINUTE);
    next = await checks(next, 1);
  }
  assert.deepEqual(new Set(asked), new Set([PAGE]), 'its checkout check and Stripe go unasked');
  assert.equal(stripeAsked, 0);
  assert.match(ends()[0].title, /closed on purpose/);
  assert.doesNotMatch(ends()[0].title, /works again/);
  assert.equal(outageJobs().length, 1, 'no job about a closing on purpose');
  assert.deepEqual(
    jobsFor('bolt').filter(j => j.title.includes("can't check its checkout")),
    [],
    'nor about its checkout check',
  );

  const outages = async () => (await said()).filter(s => s.includes('has had a problem')).length;
  next = await checks(next - MINUTE + CLOSED_MS, 1);
  assert.equal(await outages(), 1, 'once it stops saying so, its checkout counts again: one failure');
  await checks(next, 1);
  assert.equal(await outages(), 2, 'two are an outage again');
});

test("with ad spend recorded in the last days, the CEO hears at the outage's start, with the days it was recorded and who runs the ads", async () => {
  for (const [day, euros] of [
    ['2026-10-03', '12.50'],
    ['2026-10-04', '0'],
    ['2026-10-05', '0'],
  ])
    assert.equal(typeof recordSpend({ app: 'hello', day, euros }, 'penny', T0), 'object');
  stripe = 'refusing';
  await checks(T0, 2);
  assert.equal(alarms().length, 1);
  const brief = await prompt(alarms()[0]);
  mentions(
    brief,
    'Stripe',
    '2026-10-03',
    '€12.50',
    'Penny runs them',
    'Whether they pause until it works again is your call',
  );
  assert.doesNotMatch(brief, /2026-10-0[45]/, 'days with no spend');
  assert.doesNotMatch(brief, /are running|is going out/);
});

test("Stripe that doesn't answer is neither an outage nor a recovery", async () => {
  stripe = 'silent';
  await checks(T0, 3);
  assert.equal(jobsFor('bolt').length, 0);
  assert.equal((await said()).filter(s => s.includes("Stripe didn't answer")).length, 1, 'one line a spell');

  stripe = 'refusing';
  await checks(T0 + 15 * MINUTE, 2);
  assert.equal(jobsFor('bolt').length, 1);
  stripe = 'silent';
  await checks(T0 + 25 * MINUTE + ALERT_AFTER_MS, 2);
  assert.equal(alarms().length, 0, "a check that couldn't run doesn't add to the outage");
  stripe = 'refusing';
  await check(T0 + 35 * MINUTE + ALERT_AFTER_MS, net);
  assert.equal(alarms().length, 1);
  stripe = 'silent';
  await check(T0 + 40 * MINUTE + ALERT_AFTER_MS, net);
  assert.deepEqual(ends(), [], 'nor is it a recovery');
});

test("a checkout that fails while Stripe doesn't answer is no result, but a page that fails still is", async () => {
  stripe = 'silent';
  failing.add(CHECKOUT);
  await checks(T0, 3);
  assert.equal(stripeAsked, 3, 'Stripe is asked though the checkout failed');
  assert.deepEqual(jobsFor('bolt'), [], 'the checkout may fail because Stripe does');

  failing.add(PAGE);
  await checks(T0 + 15 * MINUTE, 2);
  assert.equal(jobsFor('bolt').length, 1);
  mentions(jobsFor('bolt')[0].title, PAGE, '503');
});

test('a site with ordering closed: only its page is checked, and no line says nobody can buy it', async () => {
  failing.add(CHECKOUT);
  stripe = 'refusing';
  product('live', undefined, 'partner_env: live\n');
  await check(T0, net);
  assert.deepEqual(asked, [PAGE], 'launched, but without Stripe its ordering stays closed');
  product('live', undefined, 'needs:\n  secrets: [stripe]\n');
  await check(T0, net);
  assert.deepEqual(asked, [PAGE, PAGE], 'launched, but on test partners');
  product('live');
  approve('site');
  asked.length = 0;
  await check(T0, net);
  assert.deepEqual(asked, [PAGE]);
  failing.add(PAGE);
  await checks(T0 + 5 * MINUTE, 2);
  await check(T0 + 5 * MINUTE + ALERT_AFTER_MS, net);
  const [job] = jobsFor('bolt'),
    [alarm] = alarms();
  mentions(job.title, PAGE, '503');
  assert.ok(!alarm.title.includes('orders'));
  assert.doesNotMatch((await prompt(job)) + (await prompt(alarm)), /buy/);
});

test("an app that stops being live while down: its alarm ends, saying the watch ended, and it isn't watched", async () => {
  failing.add(PAGE);
  await checks(T0, 2);
  await check(T0 + 5 * MINUTE + ALERT_AFTER_MS, net);
  assert.equal(alarms().length, 1);
  product('preview');
  asked.length = 0;
  await check(T0 + 10 * MINUTE + ALERT_AFTER_MS, net);
  assert.match(ends()[0].title, /stopped watching/);
  assert.deepEqual(asked, []);
});

test('a daily check that fails holds up neither the tick nor the next one', async () => {
  db.exec('alter table settings rename to settings_away');
  try {
    await tick(at('2026-10-06'), net);
  } finally {
    db.exec('alter table settings_away rename to settings');
  }
  asked.length = 0;
  await tick(at('2026-10-06', '07:35'), net);
  assert.deepEqual(asked, [PAGE, CHECKOUT]);
});

test("the watch's mark goes to the app's own addresses only, never to where a redirect leads", async () => {
  // The mark each address got, by its full URL
  const marks = new Map<string, unknown>();
  // A local server whose routes answer with a redirect to their target, or 200
  const serve = (routes: Record<string, string> = {}) =>
    new Promise<string>(resolve => {
      const server = createServer((req, res) => {
        marks.set(`${origin}${req.url}`, req.headers['x-hq-watch']);
        const location = routes[req.url!];
        res.writeHead(location ? 302 : 200, location ? { location } : {}).end();
      });
      let origin = '';
      server.unref().listen(0, '127.0.0.1', () => {
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve(origin);
      });
    });
  const elsewhere = await serve();
  const shelf = await serve({ '/hello/': '/hello/home', '/hello/home': '/other/', '/other/': `${elsewhere}/x` });
  const hello = { slug: 'hello', name: 'Hello', addresses: [`${shelf}/hello/`], ordering: true };

  assert.equal(await network.get(`${shelf}/hello/`, 'manual', hello), 302);
  assert.equal(await network.get(`${shelf}/hello/`, 'follow', hello), 200);
  assert.deepEqual(Object.fromEntries(marks), {
    [`${shelf}/hello/`]: watchMark('hello'),
    [`${shelf}/hello/home`]: watchMark('hello'),
    [`${shelf}/other/`]: undefined,
    [`${elsewhere}/x`]: undefined,
  });

  // A redirect away from http and https, which a browser refuses, fails the page
  const away = await serve({ '/hello/': '/hello/home', '/hello/home': 'data:text/html,maintenance' });
  const moved = { ...hello, addresses: [`${away}/hello/`] };
  await assert.rejects(network.get(`${away}/hello/`, 'follow', moved), /redirects to a data: address/);

  // A front at its host's root: another product's shelf there, in any spelling the proxy routes to it, and a platform
  // route get no mark
  mkdirSync(`${repo}/products/other`, { recursive: true });
  writeFileSync(`${repo}/products/other/product.yaml`, 'name: Other\nstatus: preview\nowner: bolt\n');
  marks.clear();
  const www = await serve({
    '/': '/home',
    '/home': '/other/',
    '/other/': '/%4Fther/x',
    '/%4Fther/x': '/OTHER',
    '/OTHER': '/home/__care/x',
  });
  const front = { slug: 'front', name: 'Front', addresses: [`${www}/`], ordering: false };
  try {
    assert.equal(await network.get(`${www}/`, 'follow', front), 200);
  } finally {
    rmSync(`${repo}/products/other`, { recursive: true });
  }
  assert.deepEqual(Object.fromEntries(marks), {
    [`${www}/`]: watchMark('front'),
    [`${www}/home`]: watchMark('front'),
    [`${www}/other/`]: undefined,
    [`${www}/%4Fther/x`]: undefined,
    [`${www}/OTHER`]: undefined,
    [`${www}/home/__care/x`]: undefined,
  });
});

test('an app that answers at once still opens while the coordinator is busy for longer than the 15 s it gets', async () => {
  const server = createServer((req, res) => res.end());
  await new Promise<void>(resolve => server.unref().listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hello = { slug: 'hello', name: 'Hello', addresses: [`${origin}/`], ordering: false };

  const status = network.get(`${origin}/`, 'follow', hello);
  // The coordinator blocked by other work for 16 s, without spinning a core
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 16_000);
  assert.equal(await status, 200);
});

test("the metrics kit counts none of the watch's requests to its app, and one with another app's mark as a visit", async () => {
  // Hello's live container, with the token infra/products.py gives it
  Object.assign(process.env, {
    METRICS_PRODUCT: 'hello',
    METRICS_MODE: 'live',
    METRICS_TOKEN: tokenFor('hello', 'live'),
  });
  const { metrics: kit } = await import('../../../shared/metrics/metrics.ts');
  const server = createServer((req, res) =>
    kit.serve(req, () => {
      kit.page(new URL(req.url!, 'http://app.test'));
      res.end();
    }),
  );
  await new Promise<void>(resolve => server.unref().listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hello = { slug: 'hello', name: 'Hello', addresses: [`${origin}/`], ordering: false };
  const visits = () => kit.snapshot().find(count => count.step === 'page')?.n ?? 0;

  assert.equal(await network.get(`${origin}/`, 'manual', hello), 200);
  assert.equal(visits(), 0);
  // Another app's mark is as long as Hello's
  assert.equal(await network.get(`${origin}/`, 'manual', { ...hello, slug: 'front' }), 200);
  assert.equal(visits(), 1);
});

test("a month's emails reaching the limit, the chat's and HQ's own together, are one job for the process role, with no app live", async () => {
  product('preview');
  limitEmails(200);
  chatSent('hello', '2026-09-30', 150);
  chatSent('hello', '2026-10-01', 90);
  chatSent('hello@preview', '2026-10-02', 30);
  chatSent('hello', '2026-10-05', 20, true);
  hqSent('2026-10-03', 59);
  daily(at('2026-10-05'));
  assert.deepEqual(emailJobs(), [], "199 emails in October stay under it, September's aside");
  hqSent('2026-10-05', 2);
  daily(at('2026-10-06'));
  const [job, ...more] = emailJobs();
  assert.deepEqual(more, []);
  mentions(await prompt(job), '201 emails', '2026-10', '200 a month', 'HQ sent 61', 'sent 140');
});

test("the email plan's job: none without watch.emailsPerMonth; with it, once a calendar month, the next month may bring one", async () => {
  product('preview');
  hqSent('2026-10-04', 210);
  daily(at('2026-10-04', '09:00'));
  assert.deepEqual(emailJobs(), [], 'no limit set');
  limitEmails(200);
  daily(at('2026-10-05'));
  hqSent('2026-10-05', 40);
  daily(at('2026-10-06'));
  daily(at('2026-10-31', '23:00'));
  assert.equal(emailJobs().length, 1, 'another day past the limit adds none');
  daily(at('2026-11-01', '09:00'));
  assert.equal(emailJobs().length, 1, "November's own emails are under it");
  hqSent('2026-11-01', 200);
  daily(at('2026-11-02', '09:00'));
  assert.equal(emailJobs().length, 2);
  mentions(emailJobs()[1].title, '200 emails', '2026-11');
});
