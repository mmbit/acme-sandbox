// node --test src/ledger.test.ts   (a throwaway DATA_DIR with the real SQLite; caps set small, euros at par with dollars)
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ledger: typeof import('./ledger.ts'), db: typeof import('./db.ts');
before(async () => {
  process.env.DATA_DIR = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'care-ledger-'));
  Object.assign(process.env, { CARE_EUR_PER_USD: '1', CARE_CAP_MONTH: '5', CARE_CAP_APP_DAY: '2', CARE_CAP_CONVERSATION: '0.5',
    CARE_CAP_SESSION: '0.15', CARE_CAP_IP_DAY: '0.6' });
  db = await import('./db.ts');
  ledger = await import('./ledger.ts');
  // the company's time zone, here one ahead of UTC, so its month starts before UTC's (company.ts)
  (await import('./company.ts')).use({ timeZone: 'Europe/Amsterdam' });
});
beforeEach(() => db.db.exec('delete from ledger'));

// Sonnet 5.5 output is $10 a million tokens: 10,000 output tokens is €0.10 here
const cents = (n: number) => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: n * 1000 });
const T = Date.UTC(2026, 9, 15, 12); // mid-month, midday UTC
const spendOn = (r: any, eur100: number, at = T) =>
  ledger.record({ purpose: 'reply', model: 'claude-sonnet-5-5', usage: cents(eur100), at, ...r });

test('a row costs what the price table says, cached and uncached tokens apart, and keeps no IP in clear', () => {
  const eur = ledger.record({ app: 'shop', conversation: 1, session: 's1', ip: '203.0.113.7', purpose: 'reply', model: 'claude-sonnet-5-5',
    usage: { input: 1000, cacheWrite: 10_000, cacheRead: 0, output: 150 } });
  assert.ok(Math.abs(eur - (1000 * 2 + 10_000 * 2.5 + 150 * 10) / 1e6) < 1e-12);
  // a dated id costs what its alias costs
  assert.equal(ledger.cost('claude-haiku-4-5-20251001', cents(10)), ledger.cost('claude-haiku-4-5', cents(10)));
  const row = db.db.prepare('select ip from ledger').get() as any;
  assert.notEqual(row.ip, '203.0.113.7');
  assert.notEqual(row.ip, db.hash('203.0.113.7'), 'a plain hash of an IPv4 address can be reversed');
});

test('the sweep blanks each row\'s IP hash after 2 days and keeps the row', () => {
  spendOn({ app: 'shop', ip: '203.0.113.7' }, 1, T - 3 * 864e5);
  spendOn({ app: 'shop', ip: '203.0.113.7' }, 1, T - 864e5);
  db.sweep(T);
  const rows = db.db.prepare('select ip from ledger order by at').all() as any[];
  assert.equal(rows.length, 2, 'the ledger stays');
  assert.equal(rows[0].ip, null);
  assert.ok(rows[1].ip);
});

test('Haiku 5.5 costs its own price, and its long-prompt price over 100,000 prompt tokens', () => {
  const usd = (u: any, p: any) => (u.input * p.input + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead + u.output * p.output) / 1e6;
  const short = { input: 2000, cacheWrite: 0, cacheRead: 98_000, output: 500 }; // a prompt of 100,000 tokens exactly
  assert.ok(Math.abs(ledger.cost('claude-haiku-5-5', short) - usd(short, { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 })) < 1e-12);
  const long = { ...short, cacheWrite: 1 }; // one more prompt token: the whole call at the long rate
  assert.ok(Math.abs(ledger.cost('claude-haiku-5-5', long) - usd(long, { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 })) < 1e-12);
  // not the dearest model's price, which a model missing from the table gets
  assert.ok(ledger.cost('claude-haiku-5-5', short) < ledger.cost('claude-opus-5-5', short) / 10);
});

test('each cap trips at its limit', () => {
  const who = { app: 'shop', conversation: 1, session: 's1', ip: '203.0.113.7', verified: false };
  const check = () => ledger.blocked(who, T);

  spendOn({ app: 'shop', session: 's1' }, 14);
  assert.equal(check(), null);
  spendOn({ app: 'shop', session: 's1' }, 1);
  assert.equal(check(), 'session', '€0.15 for a session before any check');

  db.db.exec('delete from ledger');
  for (let i = 0; i < 6; i++) spendOn({ app: 'shop', conversation: 10 + i, ip: '203.0.113.7' }, 10);
  assert.equal(check(), 'ip', '€0.60 a day from one address before any check');
  assert.equal(ledger.blocked(who, T + 864e5), null, 'the IP budget is per day');

  db.db.exec('delete from ledger');
  spendOn({ app: 'shop', conversation: 1 }, 49);
  assert.equal(ledger.blocked({ ...who, verified: true }, T), null);
  spendOn({ app: 'shop', conversation: 1 }, 1);
  assert.equal(ledger.blocked({ ...who, verified: true }, T), 'conversation', '€0.50 a conversation');

  db.db.exec('delete from ledger');
  for (let i = 0; i < 60; i++) ledger.record({ app: 'shop', conversation: 1, purpose: i % 2 ? 'draft' : 'reply', model: 'claude-sonnet-5-5', usage: cents(0), at: T });
  assert.equal(ledger.blocked({ ...who, verified: true }, T), 'calls', '60 model calls a conversation, drafts included');

  db.db.exec('delete from ledger');
  for (let i = 0; i < 4; i++) spendOn({ app: 'shop', conversation: 100 + i }, 50);
  assert.equal(ledger.blocked({ ...who, verified: true }, T), 'app', '€2 a day for an app');
  assert.equal(ledger.blocked({ ...who, verified: true }, T + 864e5), null, 'and it lifts at midnight UTC');
  assert.equal(ledger.blocked({ ...who, app: 'other', verified: true }, T), null, 'another app has its own day');
});

test('one person\'s budgets count the company\'s day: back the next day, they start again', () => {
  const who = { app: 'shop', conversation: 1, session: 's1', ip: '203.0.113.7', verified: false };
  const midnight = Date.UTC(2026, 9, 15, 22); // 16 October 00:00 in Amsterdam (summer time)
  spendOn({ app: 'shop', conversation: 1, session: 's1', ip: '203.0.113.7' }, 15, midnight - 60_000);
  assert.equal(ledger.blocked(who, midnight - 1), 'session', 'the session\'s €0.15, at 23:59');
  assert.equal(ledger.dayEnd(midnight - 1), midnight, 'until the company\'s midnight');
  assert.equal(ledger.blocked(who, midnight), null, 'a new day: answered again');
  spendOn({ app: 'shop', conversation: 1 }, 50, midnight - 60_000);
  assert.equal(ledger.blocked({ ...who, verified: true }, midnight - 1), 'conversation');
  assert.equal(ledger.blocked({ ...who, verified: true }, midnight), null, 'the conversation\'s too');
});

test('the session and IP budgets stop applying once the customer is verified', () => {
  spendOn({ app: 'shop', conversation: 2, session: 's1', ip: '203.0.113.7' }, 40);
  spendOn({ app: 'shop', conversation: 3, session: 's1', ip: '203.0.113.7' }, 40);
  const who = { app: 'shop', conversation: 4, session: 's1', ip: '203.0.113.7' };
  assert.equal(ledger.blocked({ ...who, verified: false }, T), 'session');
  assert.equal(ledger.blocked({ ...who, verified: true }, T), null);
});

test('the month cap counts every app and purpose, HQ\'s own drafts too, from the 1st in the company\'s time', () => {
  const apps = ['shop', 'other', 'shop@preview', 'hq'];
  // 1 October 00:30 in the company's time (Amsterdam's) is still 30 September in UTC: it's October's, as Care › Numbers counts it
  spendOn({ app: 'hq', purpose: 'inbox' }, 50, Date.UTC(2026, 8, 30, 22, 30));
  for (let day = 1; day <= 9; day++) spendOn({ app: apps[day % 4], conversation: day, purpose: day % 2 ? 'summary' : 'eval' }, 50, Date.UTC(2026, 9, day, 9));
  spendOn({ app: 'shop', conversation: 99 }, 150, Date.UTC(2026, 8, 30, 21, 30)); // 23:30 on 30 September there: September's
  assert.equal(ledger.blocked({ app: 'quill', verified: true }, T), 'month', '€5 across four apps blocks a fifth');
  assert.equal(ledger.blocked({ app: 'quill', verified: true }, Date.UTC(2026, 9, 31, 22, 59)), 'month', 'still October in Amsterdam');
  assert.equal(ledger.blocked({ app: 'quill', verified: true }, Date.UTC(2026, 9, 31, 23, 0, 1)), null, 'November there (UTC+1 by then)');
  assert.ok(Math.abs(ledger.spend({ since: Date.UTC(2026, 8, 30, 22) }) - 5) < 1e-9);
  assert.deepEqual(ledger.top({ since: 0, n: 1 }).map(r => [r.conversation, r.calls]), [[99, 1]]);
});

test("with a share of their own, HQ's drafts stop at it and the chats at the rest of the month", async () => {
  const company = await import('./company.ts');
  company.use({ hqMonth: 1 });   // of the month's €5: the chats keep €4
  try {
    spendOn({ app: 'hq', purpose: 'inbox' }, 50, Date.UTC(2026, 9, 1, 9));
    for (let day = 2; day <= 9; day++) spendOn({ app: day % 2 ? 'shop' : 'other', conversation: day }, 50, Date.UTC(2026, 9, day, 9));
    assert.equal(ledger.blocked({ app: 'shop', verified: true }, T), 'month', "the chats' €4 used up");
    assert.equal(ledger.blocked({ app: 'hq', verified: true }, T), null, 'HQ still has half of its €1');
    spendOn({ app: 'hq', purpose: 'inbox' }, 50, Date.UTC(2026, 9, 10, 9));
    assert.equal(ledger.blocked({ app: 'hq', verified: true }, T), 'month');
  } finally { company.use({ hqMonth: 0 }); }
});

test("HQ already past its share (the share set mid-month): the month's total still stops the chats at the cap", async () => {
  const company = await import('./company.ts');
  company.use({ hqMonth: 1 });   // of the month's €5: HQ has spent €2 of it already, the chats €3
  try {
    for (let day = 1; day <= 4; day++) spendOn({ app: 'hq', purpose: 'inbox' }, 50, Date.UTC(2026, 9, day, 9));
    for (let day = 5; day <= 9; day++) spendOn({ app: 'shop', conversation: day }, 50, Date.UTC(2026, 9, day, 9));
    assert.equal(ledger.blocked({ app: 'shop', verified: true }, T), null, "€2.50 of the chats' €4, €4.50 in all");
    spendOn({ app: 'shop', conversation: 10 }, 50, Date.UTC(2026, 9, 10, 9));
    assert.equal(ledger.blocked({ app: 'shop', verified: true }, T), 'month', "€3 of the chats' €4, but €5 in all");
    assert.equal(ledger.blocked({ app: 'hq', verified: true }, T), 'month');
  } finally { company.use({ hqMonth: 0 }); }
});

test('the breaker goes down after a failed call and a failed retry, then lets one probe through every 30 s', () => {
  const b = ledger.breaker;
  b.failed(T);
  assert.equal(b.state(), 'up', 'one failure is what the retry is for');
  assert.equal(b.probe(T + 1), true);
  b.failed(T + 2);
  assert.equal(b.state(), 'down');
  assert.equal(b.probe(T + 10_000), false);
  assert.equal(b.probe(T + 30_002), true, 'the first call after 30 s is the probe');
  assert.equal(b.probe(T + 30_003), false, 'and only one');
  b.failed(T + 31_000);
  assert.equal(b.probe(T + 50_000), false, 'a failed probe waits another 30 s');
  assert.equal(b.probe(T + 61_000), true);
  b.ok();
  assert.equal(b.state(), 'up');
  assert.equal(b.probe(T + 61_001), true);
});
