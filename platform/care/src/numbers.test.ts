// node --test src/numbers.test.ts   (a throwaway DATA_DIR with the real SQLite, a local server playing HQ's line, fixed
// dates in a company whose time zone is Amsterdam's: 25 October 2026, the day the clocks go back, is 25 hours long there)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// HQ's side: the numbers it took, a route that can be "not deployed yet" or answer with no body, and the days its state asks for again
const took: any[] = [];
let route = 404, wanted: string[] = [], refuse = '';
const hqServer = createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d).on('end', () => {
    if (req.headers.authorization !== 'Bearer hq-test-token') return void res.writeHead(401).end();
    if (req.url === '/api/care/numbers') {
      if (route >= 300) return void res.writeHead(route).end();
      if (JSON.parse(body).day === refuse) return void res.writeHead(422).end(); // a day HQ won't ever take
      took.push(JSON.parse(body));
      if (route === 204) return void res.writeHead(204).end(); // "any 2xx": taken, with nothing to say
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url?.split('?')[0] === '/api/care/state' ? { busy: 'auto', queue: { waiting: 0, oldest: null }, numbers: wanted } : { ok: true }));
  });
});

let company: typeof import('./company.ts'), numbers: typeof import('./numbers.ts'), db: typeof import('./db.ts')['db'], ledger: typeof import('./ledger.ts'), hq: typeof import('./hq.ts');
before(async () => {
  await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { DATA_DIR: mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'care-numbers-')), CARE_EUR_PER_USD: '1', CARE_CAP_APP_DAY: '1',
    CARE_APPS: JSON.stringify({ shop: 'http://127.0.0.1:1', 'shop@preview': 'http://127.0.0.1:1' }),
    CARE_HQ_URL: `http://127.0.0.1:${(hqServer.address() as any).port}`, CARE_HQ_TOKEN: 'hq-test-token' });
  company = await import('./company.ts');
  company.use({ timeZone: 'Europe/Amsterdam' });
  numbers = await import('./numbers.ts');
  db = (await import('./db.ts')).db;
  ledger = await import('./ledger.ts');
  hq = await import('./hq.ts');
});

const DAY = '2026-10-25';
const MIN = 60_000, HOUR = 3600_000;

test('a day is the company\'s day: 25 hours when the clocks go back, 23 when they go forward', () => {
  const [s, e] = numbers.bounds(DAY);
  assert.equal(new Date(s).toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(e - s, 25 * HOUR);
  const [s2, e2] = numbers.bounds('2026-03-29');
  assert.equal(new Date(s2).toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(e2 - s2, 23 * HOUR);
  assert.equal(numbers.dayOf(s), DAY);
  assert.equal(numbers.dayOf(s - 1), '2026-10-24');
  assert.equal(numbers.dayOf(e - 1), DAY);
  // east of UTC the clocks can change between local midnight and midnight UTC (Auckland: 02:00 on 27 September 2026)
  company.use({ timeZone: 'Pacific/Auckland' });
  const [s3, e3] = numbers.bounds('2026-09-27');
  assert.equal(new Date(s3).toISOString(), '2026-09-26T12:00:00.000Z');
  assert.equal(e3 - s3, 23 * HOUR);
  assert.equal(numbers.dayOf(s3), '2026-09-27'); assert.equal(numbers.dayOf(s3 - 1), '2026-09-26');
  company.use({ timeZone: 'Europe/Amsterdam' });
});

test('first words are kept in 100 ms steps, the top one past a minute', () => {
  const t = Date.UTC(2026, 0, 10, 12);
  for (const ms of [0, 1500, 1501, 70_000]) numbers.firstWords('steps', 'plain', ms, t);
  const names = (db.prepare("select name from tallies where app = 'steps' order by n, name").all() as any[]).map(r => r.name).sort();
  assert.deepEqual(names, ['fw_plain:100', 'fw_plain:1500', 'fw_plain:1600', 'fw_plain:60100']);
  db.prepare("delete from tallies where app = 'steps'").run(); // a January day would be the first one closed below
});

test('one day\'s counts, exactly as the note lists them, from the tallies, the tables and the stored changes', () => {
  const [s, e] = numbers.bounds(DAY), at = (h: number) => s + h * HOUR;
  // conversations go by shop
  const conv = (app = 'shop', state = '{}') => Number(db.prepare('insert into conversations (shop, created, last, state) values (?, ?, ?, ?)').run(app, at(0), at(1), state).lastInsertRowid);
  const msg = (c: number, who: string, text: string, t: number) => db.prepare('insert into messages (conversation, at, who, text) values (?, ?, ?, ?)').run(c, t, who, text);
  const kase = (c: number | null, kind: string, t: number) => db.prepare("insert into cases (app, conversation, kind, checked, created, sent_hq) values ('shop', ?, ?, 'none', ?, 1)").run(c, kind, t);

  // conversations: the customer wrote that day (one counted); a greeting alone, the day before, or the preview's, not here
  const c1 = conv(); msg(c1, 'ai', 'Hi', at(1)); msg(c1, 'me', 'Where is my order?', at(1));
  const c2 = conv(); msg(c2, 'ai', 'Hi', at(2));
  const c3 = conv(); msg(c3, 'me', 'Hello?', s - HOUR);
  const p1 = conv('shop@preview'); msg(p1, 'me', 'Test', at(3));
  // resolved by the company's own tools: what its plug-in's `resolved` says for the app and the day
  company.use({ resolved: (app, from, to) => app === 'shop' && from === s && to === e ? 1 : 0 });
  const c5 = conv(); kase(c5, 'person', at(4));
  const c8 = conv();
  kase(c2, 'person', at(7)); kase(null, 'person', s - MIN); kase(c2, 'question', at(8));

  // the tallies: "Did this help?" and first words (one the day before, not counted)
  for (const n of ['helped_asked', 'helped_asked', 'helped_asked', 'helped_yes', 'helped_yes', 'helped_no', 'emails', 'emails']) numbers.count('shop', n, at(9));
  numbers.count('shop', 'helped_yes', s - MIN);
  for (const ms of [400, 800, 1000, 1200, 1400, 1500, 1501, 2900, 3100, 9000]) numbers.firstWords('shop', 'plain', ms, at(10));
  for (const ms of [2000, 2600]) numbers.firstWords('shop', 'lookup', ms, at(10));
  // turn timing: 100 ms steps to 10 s, then seconds to 2 minutes, then one step; the rounds a finished turn used
  for (const ms of [0, 2350, 10_001, 200_000]) numbers.took('shop', 'chat', 'turn', 'done', ms, at(10));
  numbers.took('shop', 'chat', 'model', 'cut', 8000, at(10)); numbers.took('shop', 'chat', 'turn', 'done', 500, s - MIN);
  numbers.rounds('shop', 'chat', 2, false, at(10)); numbers.rounds('shop', 'chat', 6, true, at(10));

  // the ledger: Sonnet 5.5 output is $10 a million tokens (€ at par here), Haiku 4.5's $5
  const spend = (conversation: number | null, model: string, output: number, t: number) =>
    ledger.record({ app: 'shop', conversation, purpose: 'reply', model, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output }, at: t });
  spend(c1, 'claude-sonnet-5-5', 10_000, at(3)); spend(c1, 'claude-sonnet-5-5', 5000, at(3)); spend(null, 'claude-sonnet-5-5', 1000, at(4));
  spend(c8, 'claude-haiku-4-5', 200_000, at(11));
  // the app's day cap (€1 here) reached at 12:00 the company's time: past it until its UTC day ends, after this day
  assert.equal(ledger.blocked({ app: 'shop', verified: true }, at(12)), 'app');
  assert.equal(ledger.blocked({ app: 'shop', verified: true }, at(13)), 'app');

  // the breaker: down for a minute (two failures, a failed probe, then a call that works); an outage that began the
  // evening before, counted from midnight; and one nobody asked about for hours, counted to 2 minutes past its last try
  ledger.breaker.failed(at(1)); ledger.breaker.failed(at(1)); ledger.breaker.failed(at(1) + 30_000); ledger.breaker.ok(at(1) + MIN);
  numbers.down('breaker', '', s - MIN); numbers.down('breaker', '', s + MIN); numbers.up('breaker', '', s + 2 * MIN);
  ledger.breaker.failed(at(14)); ledger.breaker.failed(at(14)); ledger.breaker.ok(at(20));

  assert.deepEqual(numbers.counts('shop', DAY, e + HOUR), {
    conversations: 1, resolved_helped: 2, resolved_remedy: 1, person_cases: 2, question_cases: 1,
    helped_asked: 3, helped_yes: 2, helped_no: 1, emails: 2, replies_plain: 10, replies_lookup: 2,
    first_words_ms: { plain: { p50: 1400, p95: 9000, to_1500: 6, to_3000: 2, to_5000: 1, over_5000: 1 },
      lookup: { p50: 2000, p95: 2600, to_1500: 0, to_3000: 2, to_5000: 0, over_5000: 0 } },
    outage_minutes: 1 + 2 + 2, cap_minutes: 13 * 60, model_calls: 4, cost_eur: 1.16, cost_eur_p95: 1, model: 'claude-sonnet-5-5',
    timing: { 'anthropic.chat.turn.done': { 100: 1, 2400: 1, 11000: 1, 121000: 1 }, 'anthropic.chat.model.cut': { 8000: 1 },
      'anthropic.chat.rounds.done': { 2: 1 }, 'anthropic.chat.rounds.out': { 6: 1 } },
  });
  // the preview is counted apart: its own conversation; the provider's outages are every app's, the cap was shop's
  const p = numbers.counts('shop@preview', DAY, e + HOUR);
  assert.equal(p.conversations, 1);
  assert.equal(p.outage_minutes, 5);
  assert.equal(p.cap_minutes, 0);
  assert.equal(p.model, null);
  assert.deepEqual(p.timing, {});
  // a day not over yet counts up to now
  assert.equal(numbers.counts('shop', DAY, at(13)).cap_minutes, 60);
});

test('each finished day goes to HQ once per app, retried until HQ has it; HQ can ask for a day again, and for today so far', async () => {
  const [, e] = numbers.bounds(DAY), t = e + 2 * HOUR; // 2026-10-26, 03:00 in the Netherlands
  await hq.sync(t); // HQ's route isn't there yet: nothing is lost
  assert.equal(took.length, 0);
  assert.equal((db.prepare('select count(*) as n from numbers where sent is null').get() as any).n, 4, 'the 24th and the 25th, for each app, closed');
  route = 200;
  await hq.sync(t + MIN);
  assert.deepEqual(took.map(x => `${x.app} ${x.day}`).sort(), ['shop 2026-10-24', 'shop 2026-10-25', 'shop@preview 2026-10-24', 'shop@preview 2026-10-25']);
  const sent = took.find(x => x.app === 'shop' && x.day === DAY);
  assert.deepEqual(sent.counts, numbers.counts('shop', DAY, t), 'the counts as closed');
  assert.deepEqual(Object.keys(sent), ['app', 'day', 'counts']);
  await hq.sync(t + 2 * MIN);
  assert.equal(took.length, 4, 'once each');

  // a chat deleted later doesn't change a closed day
  db.prepare("delete from conversations where shop = 'shop@preview'").run();
  wanted = [DAY, '2026-10-26', '2026-10-27', 'nonsense'];
  took.length = 0;
  await hq.sync(t + 3 * MIN); // today's goes at once, as it stands, and isn't stored
  assert.deepEqual(took.map(x => `${x.app} ${x.day} ${x.partial}`).sort(), ['shop 2026-10-26 true', 'shop@preview 2026-10-26 true']);
  wanted = [];
  await hq.sync(t + 4 * MIN); // the 25th again, as it was closed
  assert.deepEqual(took.slice(2).map(x => `${x.app} ${x.day}`).sort(), ['shop 2026-10-25', 'shop@preview 2026-10-25']);
  assert.equal(took.find(x => x.app === 'shop@preview' && x.day === DAY && !x.partial).counts.conversations, 1);
  assert.equal((db.prepare("select count(*) as n from numbers where day = '2026-10-26'").get() as any).n, 0);
});

test('HQ taking the numbers with an empty 204 is taken: every closed day goes once, none is sent again', async () => {
  route = 204; took.length = 0;
  const t = numbers.bounds('2026-10-29')[0] + 3 * HOUR;
  wanted = ['2026-10-29']; // and today's, as it stands
  await hq.sync(t);
  assert.equal((db.prepare('select count(*) as n from numbers where sent is null').get() as any).n, 0);
  const closed = ['2026-10-26', '2026-10-27', '2026-10-28'].flatMap(d => [`shop ${d}`, `shop@preview ${d}`]).sort();
  assert.deepEqual(took.filter(x => !x.partial).map(x => `${x.app} ${x.day}`).sort(), closed);
  assert.deepEqual(took.filter(x => x.partial).map(x => `${x.app} ${x.day}`).sort(), ['shop 2026-10-29', 'shop@preview 2026-10-29']);
  wanted = []; took.length = 0;
  await hq.sync(t + MIN);
  assert.equal(took.length, 0, 'once each');
  route = 200;
});

test('a day HQ refuses for good doesn’t hold back the days after it', async () => {
  took.length = 0; refuse = '2026-10-29';
  const t = numbers.bounds('2026-10-31')[0] + 3 * HOUR;
  await hq.sync(t);
  assert.deepEqual(took.map(x => `${x.app} ${x.day}`).sort(), ['shop 2026-10-30', 'shop@preview 2026-10-30']);
  assert.equal((db.prepare('select count(*) as n from numbers where sent is null').get() as any).n, 0, 'the refused day isn’t tried every minute');
  refuse = '';
});

test('a restart ends an outage the breaker had open where its last failed try was', async () => {
  const t = Date.UTC(2026, 10, 3, 9);
  ledger.breaker.failed(t); ledger.breaker.failed(t); ledger.breaker.failed(t + MIN);
  // care starting again on the same volume
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./numbers.ts', import.meta.url).href)})`], { env: process.env });
  assert.equal(numbers.counts('shop', '2026-11-03', t + 5 * HOUR).outage_minutes, 1);
  ledger.breaker.ok();
});

test("a failure after a quiet gap opens a new outage: the gap nobody met isn't counted", () => {
  const t = Date.UTC(2026, 10, 4, 8);
  ledger.breaker.failed(t); ledger.breaker.failed(t);
  assert.equal(numbers.counts('shop', '2026-11-04', t + 2 * HOUR).outage_minutes, 2);
  ledger.breaker.failed(t + 6 * HOUR); // the first customer in six hours, and the probe fails again
  assert.equal(numbers.counts('shop', '2026-11-04', t + 6 * HOUR + 2 * MIN).outage_minutes, 4);
  ledger.breaker.ok(t + 6 * HOUR + 3 * MIN);
  assert.equal(numbers.counts('shop', '2026-11-04', t + 7 * HOUR).outage_minutes, 4);
});

test("HQ's own drafts (app hq) go as a day of their own with only what they cost, closed and today alike", () => {
  const [s] = numbers.bounds('2026-11-05'), at = s + 10 * HOUR;
  // €0.01 each (euros at par here); the month's cap counts them with every app, so Care › Numbers' month has them too
  for (const purpose of ['inbox', 'inbox'] as const) ledger.record({ app: 'hq', purpose, model: 'claude-sonnet-5-5', usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 1000 }, at });
  const spend = { model_calls: 2, cost_eur: 0.02, model: 'claude-sonnet-5-5' };
  assert.deepEqual(numbers.again(['2026-11-05'], at + HOUR).find(x => x.app === 'hq')?.counts, spend, 'today so far');
  numbers.close(s + 30 * HOUR);
  assert.deepEqual(numbers.unsent(100).filter(x => x.app === 'hq'), [{ app: 'hq', day: '2026-11-05', counts: spend }], 'no chat counts, not even a 0');
});

test('periods are kept 400 days: a cap period nothing closed goes by its until, an open one stays', async () => {
  const { sweep } = await import('./db.ts');
  const t = Date.UTC(2027, 11, 20), old = t - 401 * 24 * HOUR;
  const put = db.prepare('insert into downtime (kind, app, start, last, until, end) values (?, ?, ?, ?, ?, ?)');
  const capped = put.run('cap', 'x', old - HOUR, old - HOUR, old, null).lastInsertRowid; // expired, never closed by up()
  const ended = put.run('breaker', 'x', old - HOUR, old - HOUR, null, old).lastInsertRowid;
  const recent = put.run('cap', 'x', t - HOUR, t - HOUR, t - MIN, null).lastInsertRowid;
  const open = put.run('cap', 'x', old - HOUR, old - HOUR, null, null).lastInsertRowid; // no until: still on
  sweep(t);
  const left = (db.prepare("select id from downtime where app = 'x' order by id").all() as any[]).map(r => r.id);
  assert.deepEqual(left, [recent, open].map(Number));
  assert.ok(![capped, ended].map(Number).some(id => left.includes(id)));
});

test.after(() => { hqServer.close(); setTimeout(() => process.exit(0), 50); });
