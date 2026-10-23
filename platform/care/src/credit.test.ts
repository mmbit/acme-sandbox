// node --test src/credit.test.ts   (a throwaway DATA_DIR with the real SQLite, a local server playing HQ's line, euros at par
// with dollars: $100 of credit loaded on 20 September, another key's $3 a month on it)
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HQ's side: the credit warnings it took, or a route that fails
const took: any[] = [];
let failing = false;
const hqServer = createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d).on('end', () => {
    if (req.url === '/api/care/credit') {
      if (failing) return void res.writeHead(503).end();
      took.push(JSON.parse(body));
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url?.split('?')[0] === '/api/care/state' ? { busy: 'auto', queue: { waiting: 0, oldest: null } } : { ok: true }));
  });
});

let ledger: typeof import('./ledger.ts'), db: typeof import('./db.ts')['db'], hq: typeof import('./hq.ts');
before(async () => {
  await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { DATA_DIR: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'care-credit-')), CARE_EUR_PER_USD: '1',
    CARE_CAP_MONTH: '1000', CARE_CAP_APP_DAY: '1000', CARE_CREDIT_USD: '100', CARE_CREDIT_AT: '2026-09-20', CARE_CREDIT_OTHERS_USD: '3',
    CARE_HQ_URL: `http://127.0.0.1:${(hqServer.address() as any).port}`, CARE_HQ_TOKEN: 'hq-test-token' });
  (await import('./company.ts')).use({ timeZone: 'Europe/Amsterdam', helper: 'Pip' });
  db = (await import('./db.ts')).db;
  ledger = await import('./ledger.ts');
  hq = await import('./hq.ts');
});
beforeEach(() => { db.exec('delete from ledger; delete from credit_warnings; delete from downtime'); took.length = 0; failing = false; });

const DAY_MS = 864e5;
const T = Date.UTC(2026, 9, 15, 12); // 15 October: September and October each count the other key's $3
// Sonnet 5.5 output is $10 a million tokens: 100,000 output tokens is $1
const spend = (usd: number, at: number) =>
  ledger.record({ app: 'shop', purpose: 'reply', model: 'claude-sonnet-5-5', usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: usd * 1e5 }, at });

test('what is left is the credit less our spend since it was loaded and the other key\'s limit for each month', () => {
  spend(50, Date.UTC(2026, 8, 19)); // before the credit: not from it
  spend(60, T - 10 * DAY_MS);
  spend(14, T - 2 * DAY_MS);
  const c = ledger.credit(T)!;
  assert.ok(Math.abs(c.left - (100 - 6 - 74)) < 1e-6);
  assert.ok(Math.abs(c.perDay - 14 / 7) < 1e-6, "the pace is the last week's");
});

test('the credit counts the dollars each call cost, whatever the euro rate was then', () => {
  spend(60, T - 10 * DAY_MS);
  spend(14, T - 2 * DAY_MS);
  db.exec('update ledger set eur = eur * 0.9'); // counted at another rate: the dollars stay
  spend(1, T - DAY_MS);
  db.prepare('update ledger set usd = null where at = ?').run(T - DAY_MS); // a row from before the dollars were kept: its euros
  assert.ok(Math.abs(ledger.credit(T)!.left - (100 - 6 - 75)) < 1e-6);
});

test('at about $1 left every model call stops, verified or not, and the minutes count as ours', () => {
  const who = { app: 'shop', verified: true };
  spend(92.5, T - DAY_MS);
  assert.equal(ledger.blocked(who, T), null);
  spend(0.5, T - 60_000);
  assert.equal(ledger.blocked(who, T), 'credit');
  assert.equal(ledger.blocked({ app: 'hq', verified: true }, T), 'credit');
  assert.equal((db.prepare("select count(*) as n from downtime where kind = 'cap' and end is null").get() as any).n, 1);
});

test('the board hears through HQ once at $5 and once at $2, and a card HQ didn\'t take goes again', async () => {
  spend(88, T - 3 * DAY_MS); // $6 left
  await hq.sync(T);
  assert.equal(took.length, 0);
  spend(1.5, T - 60_000); // $4.50 left
  failing = true;
  await hq.sync(T);
  failing = false;
  await hq.sync(T);
  await hq.sync(T + 60_000);
  assert.equal(took.length, 1);
  assert.equal(took[0].helper, 'Pip');
  assert.ok(Math.abs(took[0].left - 4.5) < 1e-6 && took[0].stopAt === 1 && took[0].perDay > 0);
  spend(3, T); // $1.50: past $2
  await hq.sync(T + 120_000);
  await hq.sync(T + 180_000);
  assert.equal(took.length, 2);
  assert.ok(Math.abs(took[1].left - 1.5) < 1e-6);
});

test('a credit that falls past both steps at once is one card', async () => {
  spend(92.5, T - DAY_MS); // $1.50 left
  await hq.sync(T);
  await hq.sync(T + 60_000);
  assert.equal(took.length, 1);
});

test.after(() => { hqServer.close(); setTimeout(() => process.exit(0), 50); });
