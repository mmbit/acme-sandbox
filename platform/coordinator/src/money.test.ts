// node --test src/money.test.ts   (the harness, the test company's Hello made live; the test plays its order summaries)
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

// Bolt owns Hello, Penny is finance
const h = await harness('money', { serve: false, env: { PUBLIC_HOST: 'hq.example.test' } });
const { db, repo, dataDir } = h;
// Hello is live and takes orders: the board approved its launch (the record its card's Approve leaves)
const live = 'name: Hello\nstatus: live\nowner: bolt\npartner_env: live\nneeds:\n  secrets: [stripe]\n';
writeFileSync(`${repo}/products/hello/product.yaml`, live);
mkdirSync(`${dataDir}/approvals`, { recursive: true });
const approved = { grant: 'live:hello', request: 1, approved: '2026-10-01T10:00:00Z' };
writeFileSync(`${dataDir}/approvals/live-hello.json`, JSON.stringify(approved));
const { daily } = await import('./watch.ts');
const { recordSpend } = await import('./spend.ts');

const DAY = 24 * 60 * 60_000;
// The test company's clock is Amsterdam's, on summer time in October until the 25th
const at = (day: string, time = '07:30') => Date.parse(`${day}T${time}:00+02:00`);

// Each test starts on empty books (no route clears them) and reads the Finance jobs made since it began
let firstJob = 0;
beforeEach(() => {
  firstJob = Math.max(0, ...h.jobs.listJobs().map(j => j.id));
  for (const table of ['watch_days', 'watch_refunds', 'ad_spend', 'metric_orders', 'metric_order_days'])
    db.exec(`delete from ${table}`);
  db.exec("delete from settings where key like 'watch.%'");
});

// The briefs Finance's jobs carry: what the agent works from (in the table: no route hands it out without a claim)
type Job = { id: number; title: string; prompt: string };
const jobsFor = (agent: string) =>
  db.prepare('select id, title, prompt from jobs where agent = ? and id > ? order by id').all(agent, firstJob) as Job[];
// A day's orders as the app reports them, in a summary made once the day ended (in the table: the push route,
// metrics.test.ts, takes only days around today, and these are the test's)
const sold = (day: string, paid: number, cents = 499) => {
  db.prepare(
    `insert into metric_orders (product, mode, day, variant, campaign, country, what,
      orders, paid, refunded, kept, cents, net_cents) values ('hello', 'live', ?, '', '', 'NL', '', ?, ?, 0, ?, ?, ?)`,
  ).run(day, paid, paid, paid, paid * cents, paid * cents);
  reported(day);
};
const reported = (day: string) =>
  db
    .prepare(
      "insert or replace into metric_order_days (product, mode, day, summary_day) values ('hello', 'live', ?, ?)",
    )
    .run(day, new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10));

// A Finance job's line, by the numbers it gives in order
const line = (...numbers: string[]) => new RegExp(numbers.map(n => n.replace(/[.()]/g, '\\$&')).join('[^\\n]*'));

test('many sales a day: the same number stays quiet, a fall still counts', () => {
  const finance = () => jobsFor('penny');
  for (let d = 1; d <= 9; d++) sold(`2026-10-0${d}`, 800);
  daily(at('2026-10-10'));
  assert.equal(finance().length, 0);
  sold('2026-10-10', 700);
  daily(at('2026-10-11'));
  assert.equal(finance().length, 1);
  assert.match(finance()[0].prompt, line('700 sales', '800.0'));
});

test('the money check: steady sales stay quiet; a day the app has not reported waits; no sales, a fall in what an order brings in, or a wave of refunds on older orders is a job for Finance', () => {
  const finance = () => jobsFor('penny');
  for (let d = 1; d <= 9; d++) sold(`2026-10-0${d}`, 6);
  daily(at('2026-10-10'));
  assert.equal(finance().length, 0, 'yesterday sold as the week before');

  daily(at('2026-10-11'));
  assert.equal(finance().length, 0, "the 10th's orders aren't in: unknown, not none");
  reported('2026-10-10');
  daily(at('2026-10-11', '18:00'));
  daily(at('2026-10-11', '18:05'));
  assert.equal(finance().length, 1);
  assert.match(finance()[0].title, line('Hello', '2026-10-10'));
  assert.match(finance()[0].prompt, line('No sales', '6.0'));
  assert.match(
    finance()[0].prompt,
    /\| 2026-10-09 \| 6 \| 6 \| 0 \| 0 \| €29\.94 \| not recorded \|\n\| 2026-10-10 \| 0 \| 0 \| 0 \| 0 \| €0\.00 \| not recorded \|/,
  );

  sold('2026-10-11', 2, 1);
  daily(at('2026-10-12'));
  assert.equal(finance().length, 2);
  assert.match(finance()[1].prompt, line('€0.02', '2 orders', '€0.01', '€4.99'));

  db.prepare(
    "update metric_orders set refunded = 1, kept = 5, cents = 2495 where product = 'hello' and day between '2026-10-01' and '2026-10-05'",
  ).run();
  sold('2026-10-12', 6);
  daily(at('2026-10-13'));
  assert.equal(finance().length, 3);
  assert.match(finance()[2].title, line('Hello', '2026-10-13'));
  assert.match(finance()[2].prompt, line('5 orders refunded', '2026-10-12', '0.0'));
});

test('no sales after a few a day is a swing only as unlikely as salesChance allows', () => {
  for (const [d, paid] of [1, 1, 1, 1, 1, 0, 0].entries()) sold(`2026-10-0${d + 1}`, paid);
  sold('2026-10-08', 0);
  daily(at('2026-10-09'));
  assert.deepEqual(jobsFor('penny'), [], 'no sales had about a 49% chance at 0.7 a day');
});

test("ad spend recorded after the day's check, or corrected, is checked when it comes", () => {
  const finance = () => jobsFor('penny');
  for (let d = 1; d <= 8; d++) sold(`2026-10-0${d}`, 2);
  for (let d = 1; d <= 7; d++)
    recordSpend({ app: 'hello', day: `2026-10-0${d}`, euros: '10' }, 'penny', at('2026-10-08'));
  daily(at('2026-10-09'));
  assert.equal(finance().length, 0, 'no spend recorded for the 8th yet');

  recordSpend({ app: 'hello', day: '2026-10-08', euros: '1000' }, 'penny', at('2026-10-09', '12:00'));
  daily(at('2026-10-09', '12:05'));
  daily(at('2026-10-10'));
  assert.equal(finance().length, 1);
  assert.match(finance()[0].title, line('Hello', '2026-10-08'));
  assert.match(finance()[0].prompt, line('€1,000.00', '€10.00', '7 days', '2 sales', '2.0'));

  recordSpend({ app: 'hello', day: '2026-10-08', euros: '10' }, 'penny', at('2026-10-10', '12:00'));
  daily(at('2026-10-10', '12:05'));
  recordSpend({ app: 'hello', day: '2026-10-08', euros: '900' }, 'penny', at('2026-10-10', '13:00'));
  daily(at('2026-10-10', '13:05'));
  assert.equal(finance().length, 2, 'a correction is checked again');
});

test('spend or sales of the days before that come in late or are corrected check the day again, and a swing found is told once', () => {
  const finance = () => jobsFor('penny');
  for (let d = 1; d <= 8; d++) sold(`2026-10-0${d}`, 6);
  recordSpend({ app: 'hello', day: '2026-10-08', euros: '14' }, 'penny', at('2026-10-08', '12:00'));
  daily(at('2026-10-09'));
  assert.equal(finance().length, 0, 'no spend recorded for the days before, and under firstSpendEuros');

  for (let d = 1; d <= 7; d++)
    recordSpend({ app: 'hello', day: `2026-10-0${d}`, euros: '5' }, 'penny', at('2026-10-09', '12:00'));
  daily(at('2026-10-09', '12:05'));
  assert.equal(finance().length, 1);
  assert.match(finance()[0].title, line('Hello', '2026-10-08'));
  recordSpend({ app: 'hello', day: '2026-10-03', euros: '6' }, 'penny', at('2026-10-09', '13:00'));
  daily(at('2026-10-09', '13:05'));
  daily(at('2026-10-09', '13:10'));
  assert.equal(finance().length, 1, 'the same swing, checked again, is not told again');

  for (let d = 1; d <= 3; d++) sold(`2026-10-1${d}`, 6);
  sold('2026-10-18', 0);
  daily(at('2026-10-19'));
  assert.equal(finance().length, 1, 'sales on 3 reported days before are no steady sales yet');
  for (let d = 4; d <= 7; d++) sold(`2026-10-1${d}`, 6);
  daily(at('2026-10-19', '12:00'));
  daily(at('2026-10-19', '12:05'));
  assert.equal(finance().length, 2);
  assert.match(finance()[1].prompt, /2026-10-18:\n- No sales/);
});

test('ad spend not recorded is unknown, not none: spend swings only against days that have it', () => {
  for (let d = 1; d <= 8; d++) sold(`2026-10-0${d}`, 2);
  recordSpend({ app: 'hello', day: '2026-10-07', euros: '5' }, 'penny', at('2026-10-08', '12:00'));
  recordSpend({ app: 'hello', day: '2026-10-08', euros: '12' }, 'penny', at('2026-10-08', '12:00'));
  daily(at('2026-10-09'));
  assert.deepEqual(jobsFor('penny'), []);
});

test('ad spend on a day after none, from firstSpendEuros on and with no more sales, is a swing: after no record, or a week of none', () => {
  const finance = () => jobsFor('penny');
  for (let d = 1; d <= 11; d++) sold(`2026-10-${String(d).padStart(2, '0')}`, 0);
  recordSpend({ app: 'hello', day: '2026-10-03', euros: '80' }, 'penny', at('2026-10-03', '12:00'));
  daily(at('2026-10-04'));
  assert.equal(finance().length, 1);
  assert.match(finance()[0].title, line('Hello', '2026-10-03'));
  assert.match(finance()[0].prompt, line('€80.00', '0 sales'));

  for (let d = 4; d <= 10; d++)
    recordSpend({ app: 'hello', day: `2026-10-${String(d).padStart(2, '0')}`, euros: '0' }, 'penny', at('2026-10-11'));
  recordSpend({ app: 'hello', day: '2026-10-11', euros: '80' }, 'penny', at('2026-10-11', '12:00'));
  daily(at('2026-10-12'));
  assert.equal(finance().length, 2);
  assert.match(finance()[1].title, line('Hello', '2026-10-11'));
  assert.match(finance()[1].prompt, line('€80.00', '0 sales'));
});

test('ad spend on days before with no order summary still counts as spend before, and no summary leaves the sales uncompared', () => {
  const finance = () => jobsFor('penny');
  recordSpend({ app: 'hello', day: '2026-10-07', euros: '100' }, 'penny', at('2026-10-08', '12:00'));
  recordSpend({ app: 'hello', day: '2026-10-08', euros: '80' }, 'penny', at('2026-10-08', '12:00'));
  sold('2026-10-08', 0);
  daily(at('2026-10-09'));
  assert.deepEqual(finance(), [], '€100 of ad spend on the 7th, whose orders are not in');

  recordSpend({ app: 'hello', day: '2026-10-16', euros: '80' }, 'penny', at('2026-10-16', '12:00'));
  sold('2026-10-16', 3);
  daily(at('2026-10-17'));
  assert.equal(finance().length, 1);
  assert.match(finance()[0].prompt, line('€80.00', '3 sales', 'no order summary'));
  assert.doesNotMatch(finance()[0].prompt, /against 0\.0/);
});

test('no ad spend on reported days, after spend on a day not reported, is no swing', () => {
  recordSpend({ app: 'hello', day: '2026-10-01', euros: '20' }, 'penny', at('2026-10-02', '12:00'));
  for (let d = 2; d <= 8; d++) {
    sold(`2026-10-0${d}`, 0);
    recordSpend({ app: 'hello', day: `2026-10-0${d}`, euros: '0' }, 'penny', at('2026-10-09'));
  }
  daily(at('2026-10-09'));
  assert.deepEqual(jobsFor('penny'), []);
});
