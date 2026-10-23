// node --test src/credit-monthly.test.ts   (a throwaway DATA_DIR with the real SQLite, a local server playing HQ's line, euros
// at par with dollars: $20 prepaid on 9 October, a plan's $200 monthly credit from the billing cycle starting 2 October at
// 14:00 UTC, another key's $3 a month on the same account)
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const took: any[] = [];
const hqServer = createServer((req, res) => {
  let body = '';
  req
    .on('data', d => (body += d))
    .on('end', () => {
      if (req.url === '/api/care/credit') took.push(JSON.parse(body));
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify(
            req.url?.split('?')[0] === '/api/care/state'
              ? { busy: 'auto', queue: { waiting: 0, oldest: null } }
              : { ok: true },
          ),
        );
    });
});

let ledger: typeof import('./ledger.ts'), db: (typeof import('./db.ts'))['db'], hq: typeof import('./hq.ts');
before(async () => {
  await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    DATA_DIR: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'care-credit-monthly-')),
    CARE_EUR_PER_USD: '1',
    CARE_CAP_MONTH: '1000',
    CARE_CAP_APP_DAY: '1000',
    CARE_CREDIT_USD: '20',
    CARE_CREDIT_AT: '2026-10-09T12:00Z',
    CARE_CREDIT_OTHERS_USD: '3',
    CARE_CREDIT_MONTHLY_USD: '200',
    CARE_CREDIT_MONTHLY_FROM: '2026-10-02T14:00Z',
    CARE_HQ_URL: `http://127.0.0.1:${(hqServer.address() as any).port}`,
    CARE_HQ_TOKEN: 'hq-test-token',
  });
  (await import('./company.ts')).use({ timeZone: 'Europe/Amsterdam', helper: 'Pip' });
  db = (await import('./db.ts')).db;
  ledger = await import('./ledger.ts');
  hq = await import('./hq.ts');
});
beforeEach(() => {
  db.exec('delete from ledger; delete from credit_warnings; delete from downtime');
  took.length = 0;
});

const HOUR_MS = 36e5,
  DAY_MS = 864e5;
const OCT_CYCLE_END = Date.UTC(2026, 10, 2, 14),
  NOV_CYCLE_END = Date.UTC(2026, 11, 2, 14);
// Sonnet 5.5 output is $10 a million tokens: 100,000 output tokens is $1
const spend = (usd: number, at: number) =>
  ledger.record({
    app: 'shop',
    purpose: 'reply',
    model: 'claude-sonnet-5-5',
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: usd * 1e5 },
    at,
  });

test("the cycle's spend comes out of the monthly credit first: what's left is the prepaid credit and what the cycle's credit holds", () => {
  const t = Date.UTC(2026, 9, 20);
  spend(50, t - DAY_MS);
  const c = ledger.credit(t)!;
  assert.ok(Math.abs(c.left - (20 + 200 - 3 - 50)) < 1e-6);
  assert.equal(c.renews, OCT_CYCLE_END);
});

test("spend in the cycle before the prepaid credit was read counts against the cycle's monthly credit", () => {
  spend(30, Date.UTC(2026, 9, 5)); // after the cycle started, before the balance was read
  spend(10, Date.UTC(2026, 9, 1)); // the cycle before: no monthly credit then, and before the balance was read
  assert.ok(Math.abs(ledger.credit(Date.UTC(2026, 9, 20))!.left - (20 + 200 - 30 - 3)) < 1e-6);
});

test("what's over a cycle's monthly credit comes out of the prepaid one, and the next cycle brings a full one", () => {
  spend(210, Date.UTC(2026, 9, 25)); // $16 over October's with the other key's October and November: $4 prepaid left
  const end = ledger.credit(OCT_CYCLE_END - HOUR_MS)!;
  assert.ok(Math.abs(end.left - 4) < 1e-6);
  const next = ledger.credit(OCT_CYCLE_END + HOUR_MS)!;
  assert.ok(Math.abs(next.left - (4 + 200 - 3)) < 1e-6, "November's other key counts in November's cycle too");
  assert.equal(next.renews, NOV_CYCLE_END);
  // a cycle's unspent credit is gone at its end: a light November leaves December's $200, not more
  spend(1, Date.UTC(2026, 10, 10));
  assert.ok(Math.abs(ledger.credit(NOV_CYCLE_END + HOUR_MS)!.left - (4 + 200 - 3)) < 1e-6);
});

test("the other key's limit renews on the 1st: November's counts from 1 November, before the cycle renews on the 2nd", () => {
  spend(210, Date.UTC(2026, 9, 25));
  assert.ok(Math.abs(ledger.credit(Date.UTC(2026, 9, 31, 12))!.left - (20 + 200 - 210 - 3)) < 1e-6);
  assert.ok(Math.abs(ledger.credit(Date.UTC(2026, 10, 1, 12))!.left - (20 + 200 - 210 - 3 - 3)) < 1e-6);
});

test("the other key's month counts in the cycle it is spent in, after a billing renewal", () => {
  for (let day = 10; day < 20; day++) spend(21.6, Date.UTC(2026, 10, day)); // $216 in November's cycle
  // October's cycle may hold November's $3 (1 November), and November's cycle may too (from 2 November): $20 + $200 - $216 - $3
  assert.ok(Math.abs(ledger.credit(Date.UTC(2026, 10, 20))!.left - 1) < 1e-6);
  assert.equal(ledger.blocked({ app: 'shop', verified: true }, Date.UTC(2026, 10, 20)), 'credit');
});

test("a balance read on the 1st: the first cycle's months before it count too, and the month goes on into the next cycle", async () => {
  const CREDIT = (await import('./config.ts')).CREDIT!,
    readAt = CREDIT.at;
  CREDIT.at = Date.UTC(2026, 10, 1, 12);
  try {
    spend(195, Date.UTC(2026, 9, 20)); // before the balance was read: $5 of October's cycle left
    // October's and November's other key against that $5: $1 comes off the prepaid $20
    assert.ok(Math.abs(ledger.credit(Date.UTC(2026, 10, 1, 13))!.left - (20 + 5 - 6)) < 1e-6);
    spend(215, Date.UTC(2026, 10, 10));
    assert.ok(Math.abs(ledger.credit(Date.UTC(2026, 10, 20))!.left - (19 + 200 - 215 - 3)) < 1e-6);
    assert.equal(ledger.blocked({ app: 'shop', verified: true }, Date.UTC(2026, 10, 20)), 'credit');
  } finally {
    CREDIT.at = readAt;
  }
});

test('the chat stops at about $1 of both credits together', () => {
  spend(215.5, Date.UTC(2026, 9, 25)); // $1.50 left
  assert.equal(ledger.blocked({ app: 'shop', verified: true }, Date.UTC(2026, 9, 26)), null);
  spend(0.6, Date.UTC(2026, 9, 26));
  assert.equal(ledger.blocked({ app: 'shop', verified: true }, Date.UTC(2026, 9, 26, 1)), 'credit');
});

test("the board hears at $5 with the monthly credit's next date, and again in a cycle after the credit came back", async () => {
  spend(213, Date.UTC(2026, 9, 25)); // $4 left
  await hq.sync(Date.UTC(2026, 9, 26));
  await hq.sync(Date.UTC(2026, 9, 26, 1));
  assert.equal(took.length, 1);
  assert.ok(Math.abs(took[0].left - 4) < 1e-6);
  assert.equal(took[0].renews, OCT_CYCLE_END);
  spend(197, Date.UTC(2026, 10, 20)); // $1 of prepaid credit after October, and November's $200 less the other key's $3
  await hq.sync(Date.UTC(2026, 10, 21));
  assert.equal(took.length, 2, "a new cycle's credit is a recharge: its steps are owed again");
  assert.ok(Math.abs(took[1].left - 1) < 1e-6);
});

test.after(() => {
  hqServer.close();
  setTimeout(() => process.exit(0), 50);
});
