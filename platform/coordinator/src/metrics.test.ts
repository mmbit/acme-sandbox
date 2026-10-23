// node --test src/metrics.test.ts   (the harness's test company with made-up products; HQ's real server and the real hq script)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { harness } from './harness.ts';

const RUN = mkdtempSync(`${tmpdir()}/metrics-run-`);   // the host's memory
after(() => rmSync(RUN, { recursive: true, force: true }));

// ---- days, as the apps count them (Dutch) and as the push's window is checked (UTC)
const DUTCH = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' });
const today = DUTCH.format(new Date());
const plus = (n: number, day = today) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// ---- made-up products: a live one with tests in every state, a preview, one without a file, one with a broken file
const tests = [
  { id: 'soon', variants: ['A', 'B'], metric: ['page', 'order'], finish: 100, start: plus(1) },
  { id: 'fresh', variants: ['A', 'B'], metric: ['page', 'order'], finish: 100, start: plus(-5) },
  { id: 'clear', question: 'Does a bigger button get more presses?', variants: ['A', 'B'], metric: ['page', 'order'], guardrail: ['order', 'paid'], finish: 1000, start: plus(-20) },
  { id: 'worse', variants: ['A', 'B'], metric: ['page', 'order'], finish: 1000, start: plus(-20) },
  { id: 'pricey', variants: ['A', 'B'], metric: ['page', 'order'], guardrail: ['order', 'paid'], finish: 1000, start: plus(-20) },
  { id: 'flat', variants: ['A', 'B'], metric: ['page', 'order'], finish: 1000, start: plus(-20) },
  { id: 'trio', variants: ['A', 'B', 'C'], metric: ['page', 'order'], finish: 1000, start: plus(-20) },
  { id: 'slow', variants: ['A', 'B'], metric: ['page', 'order'], finish: 100_000, start: plus(-50) },
  { id: 'drift', variants: ['A', 'B'], metric: ['page', 'order'], finish: 100, start: plus(-3) },
  { id: 'ended', variants: ['A', 'B'], metric: ['page', 'order'], finish: 100, start: plus(-60), end: plus(-30) },
];
const FILE = {
  steps: [{ id: 'page', label: 'Page loads' }, { id: 'price', label: 'Price checks' }, { id: 'order', label: 'Pressed Pay' }, { id: 'pack', label: 'Packs opened' }, { id: 'paid', label: 'Paid' }],
  funnel: ['page', 'order', 'paid'],
  what: { title: 'Which pebble was ordered', labels: { round: 'Round pebble', flat: 'Flat pebble' } },
  sections: [{ kind: 'what-orders', title: 'Which pebble' }, { kind: 'step-what', step: 'pack', title: 'Packs opened against ordered' }],
  margin: { NL: 10, BE: 8 },
  targets: [{ id: 'cpo', label: 'Cost per order from ads', goal: 10, max: 14, unit: 'EUR', lower: true }],
  tests,
};
const h = await harness('metrics', { env: { RUN_DIR: RUN }, before: repo => {
  const product = (slug: string, yaml: string, file?: unknown) => {
    mkdirSync(`${repo}/products/${slug}/app`, { recursive: true });
    writeFileSync(`${repo}/products/${slug}/product.yaml`, yaml);
    if (file !== undefined) writeFileSync(`${repo}/products/${slug}/app/metrics.json`, typeof file === 'string' ? file : JSON.stringify(file));
  };
  product('pebblepost', 'name: Pebble Post\nstatus: live\n', FILE);
  product('mossgram', 'name: Mossgram\nstatus: building\n', { steps: [{ id: 'page' }, { id: 'paid' }] });
  product('nofile', 'name: No File\nstatus: live\n');
  product('brokenapp', 'name: Broken\nstatus: building\n', '{"steps": [');
  product('front', 'name: The shop\nstatus: live\nbasket:\n  countries: [NL]\n');   // the shop: baskets, no metrics.json
  // a metrics.json that links out of the products folder, to a file shaped like one: never read
  product('linked', 'name: Linked\nstatus: live\n');
  writeFileSync(`${process.env.DATA_DIR}/outside.json`, JSON.stringify({ steps: [{ id: 'page' }], secret: 'planted-outside' }));
  symlinkSync(`${process.env.DATA_DIR}/outside.json`, `${repo}/products/linked/app/metrics.json`);
} });
const { db, base: HQ, board, dataDir: DATA } = h;
const metrics = await import('./metrics.ts');
db.exec('delete from metric_page_cutoff');   // a new HQ, not a restored one: its first start's cutoff aside
await import('./server.ts');

const as = (slug: string, mode = 'live', token = metrics.tokenFor(slug, mode)) => ({ authorization: `Bearer ${token}`, 'x-product': slug, 'x-mode': mode });
const push = async (body: unknown, headers: Record<string, string> = as('pebblepost')) => {
  const r = await fetch(`${HQ}/api/metrics/push`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};
let batches = 0;
const batch = () => (++batches).toString(16).padStart(32, '0');
const count = (over: Record<string, unknown> = {}) => ({ day: today, step: 'page', variant: '', campaign: '', country: '', what: '', n: 1, ...over });
const row = (over: Record<string, unknown> = {}) => ({ day: today, variant: '', campaign: '', country: 'NL', what: '', orders: 1, paid: 1, refunded: 0, kept: 1, eur: 39.95, net: 30, ...over });
// What a dashboard counted, over every step (HQ's page for the app)
const dash = async (q = '') => (await board(`/api/numbers/pebblepost${q}`)).body;
const stored = async (q = '') => Object.values((await dash(q)).steps as Record<string, number>).reduce((a, b) => a + b, 0);

test('an app pushes only with the token for its own slug and mode', async () => {
  const body = () => ({ batch: batch(), counts: [count()] });
  assert.equal((await push(body(), {})).status, 401);
  assert.equal((await push(body(), as('pebblepost', 'live', metrics.tokenFor('mossgram', 'live')))).status, 401);      // another app's
  assert.equal((await push(body(), as('pebblepost', 'live', metrics.tokenFor('pebblepost', 'preview')))).status, 401); // its preview's
  assert.equal((await push(body(), as('pebblepost', 'live', 'ab'.repeat(32)))).status, 401);
  assert.equal((await push(body(), { ...as('pebblepost'), 'x-mode': 'test' })).status, 401);
  // payments' token for the same slug and mode is no counting token, nor the other way round
  const payments = await import('./payments.ts');
  assert.equal((await push(body(), as('pebblepost', 'live', payments.tokenFor('pebblepost', 'live')))).status, 401);
  assert.equal(await stored(), 0);
  assert.equal((await push(body())).status, 200);
  assert.equal(await stored(), 1);
});

test('an app without a readable metrics.json is refused', async () => {
  assert.equal((await push({ batch: batch(), counts: [count()] }, as('nofile'))).status, 404);
  const broken = await push({ batch: batch(), counts: [count()] }, as('brokenapp', 'preview'));
  assert.equal(broken.status, 409);
});

test('anything odd in a push refuses all of it', async () => {
  const before = await stored(), orders = (o: Record<string, unknown>) => ({ from: plus(-3), to: today, made: Date.now(), rows: [row()], ...o });
  const bad: [string, unknown][] = [
    ['not json', '{counts:'], ['a list', []], ['no batch', { batch: undefined, counts: [count()] }], ['short batch', { batch: 'abc', counts: [] }],
    ['capital batch', { batch: 'A'.repeat(32), counts: [] }], ['no counts', { batch: batch() }],
    ['too many counts', { counts: Array.from({ length: 5001 }, () => count()) }],
    ['old day', { counts: [count({ day: plus(-4) })] }], ['future day', { counts: [count({ day: plus(3) })] }],
    ['not a day', { counts: [count({ day: '2026-02-30' })] }], ['unknown step', { counts: [count({ step: 'checkout' })] }],
    ['unknown test', { counts: [count({ variant: 'nope:A' })] }], ['unknown letter', { counts: [count({ variant: 'clear:C' })] }],
    ['variant shape', { counts: [count({ variant: 'clear:A:B' })] }], ['campaign shape', { counts: [count({ campaign: 'Spring Sale' })] }],
    ['long campaign', { counts: [count({ campaign: 'a'.repeat(41) })] }], ['country shape', { counts: [count({ country: 'nl' })] }],
    ['what shape', { counts: [count({ what: 'a b' })] }], ['a number for a label', { counts: [count({ campaign: 7 })] }],
    ['fraction', { counts: [count({ n: 1.5 })] }], ['negative', { counts: [count({ n: -1 })] }], ['huge', { counts: [count({ n: 1_000_001 })] }],
    ['n as text', { counts: [count({ n: '3' })] }], ['a row that is not an object', { counts: [null] }],
    ['orders without rows', { counts: [], orders: { from: today, to: today } }],
    ['summary undated', { counts: [], orders: orders({ made: undefined }) }],
    ['from after to', { counts: [], orders: orders({ from: today, to: plus(-1) }) }],
    ['too long ago', { counts: [], orders: orders({ from: plus(-130) }) }], ['to in the future', { counts: [], orders: orders({ to: plus(5) }) }],
    ['row outside from..to', { counts: [], orders: orders({ rows: [row({ day: plus(-5) })] }) }],
    ['paid fraction', { counts: [], orders: orders({ rows: [row({ paid: 0.5 })] }) }], ['negative euros', { counts: [], orders: orders({ rows: [row({ eur: -1 })] }) }],
    ['euros not finite', { counts: [], orders: orders({ rows: [row({ net: 'NaN' })] }) }], ['euros too many', { counts: [], orders: orders({ rows: [row({ eur: 10_000_001 })] }) }],
    ['unknown nets above kept', { counts: [], orders: orders({ rows: [row({ netUnknown: 2 })] }) }],
    ['unknown nets as null', { counts: [], orders: orders({ rows: [row({ netUnknown: null })] }) }], ['net as null', { counts: [], orders: orders({ rows: [row({ net: null })] }) }],
    ['row variant unknown', { counts: [], orders: orders({ rows: [row({ variant: 'gone:B' })] }) }],
    ['duplicate order row', { counts: [], orders: orders({ rows: [row(), row()] }) }],
    ['too many order rows', { counts: [], orders: orders({ from: plus(-119), rows: Array.from({ length: 5001 }, (_, i) => row({ day: plus(-(i % 100)), campaign: `c${i}` })) }) }],
    // one bad row among good ones: nothing of it is kept
    ['a bad row last', { counts: [count({ n: 5 }), count({ step: 'nope' })] }],
  ];
  for (const [why, b] of bad) {
    const body = typeof b === 'string' || Array.isArray(b) || 'batch' in (b as object) ? b : { batch: batch(), ...(b as object) };
    const r = await push(body);
    assert.equal(r.status, 400, why);
    }
  assert.equal(await stored(), before);
  assert.equal((await dash()).totals.orders, 0);
  // over 1 MB
  const big = await push({ batch: batch(), counts: [count({ what: 'x'.repeat(1_100_000) })] });
  assert.equal(big.status, 413);
});

test('counts add up; a batch sent again changes nothing', async () => {
  const before = await stored(), b = batch(), body = { batch: b, counts: [count({ step: 'price', country: 'BE', n: 3 }), count({ step: 'price', country: 'BE', n: 4 })] };
  // no order summary since HQ started: it asks for one
  assert.deepEqual((await push(body)).body, { ok: true, ordersDue: true });
  assert.deepEqual((await push(body)).body, { ok: true, duplicate: true, ordersDue: true });
  await push({ batch: batch(), counts: [count({ step: 'price', country: 'BE', n: 10 })] });
  assert.equal((await dash()).steps.price, 17);
  assert.equal(await stored(), before + 17);
  // the same batch id from another app is that app's own
  assert.deepEqual((await push({ batch: b, counts: [count()] }, as('mossgram', 'preview'))).body, { ok: true, ordersDue: true });
  // a preview's counts never mix with live ones
  assert.equal(await stored('?mode=preview'), 0);
});

test("order rows replace the app's rows for the days pushed, and only those", async () => {
  await push({ batch: batch(), counts: [], orders: { from: plus(-2), to: today, made: Date.now(), rows: [
    row({ day: plus(-2), country: 'BE', campaign: 'spring', what: 'round', eur: 20.004 }), row({ day: plus(-1), what: 'flat' }), row({ day: today, orders: 3, paid: 2, refunded: 1, kept: 1 }),
  ] } });
  // the next summary covers yesterday and today: the day before stays, yesterday's row goes, today's is replaced
  await push({ batch: batch(), counts: [], orders: { from: plus(-1), to: today, made: Date.now(), rows: [row({ day: today, orders: 4, paid: 3, refunded: 1, kept: 2, eur: 79.9, net: 60, what: 'round' })] } });
  const d = await dash('?days=3');
  assert.deepEqual(d.daily.map((x: any) => [x.day, x.orders, x.paid, x.kept, x.eur]), [[plus(-2), 1, 1, 1, 20], [plus(-1), 0, 0, 0, 0], [today, 4, 3, 2, 79.9]]);
  assert.deepEqual(d.countries.map((c: any) => c.country), ['NL', 'BE']);
  assert.deepEqual([...metrics.reportedDays('pebblepost', 'live', plus(-3), today)].sort(), [plus(-2), plus(-1)], 'a day is reported once a summary came after it ended');
  // a summary made before midnight, pushed again the next morning: the day it was made on wasn't over in it
  await push({ batch: batch(), counts: [], orders: { from: plus(-4), to: plus(-3), made: Date.now(), rows: [] } });
  assert.deepEqual([...metrics.reportedDays('pebblepost', 'live', plus(-4), plus(-3))], [plus(-4)]);
});

test('at most 120 pushes an hour per app and mode', async () => {
  let refused = 0;
  for (let i = 0; i < 125; i++) if ((await push({ batch: batch(), counts: [] }, as('mossgram', 'live'))).status === 429) refused++;
  assert.equal(refused, 5);
  // the preview has a budget of its own
  assert.equal((await push({ batch: batch(), counts: [] }, as('mossgram', 'preview'))).status, 200);
});

// ---- the standing, from counts pushed today into tests that started on different days
const arm = (t: string, letter: string, page: number, order: number, paid = 0) => [
  count({ variant: `${t}:${letter}`, n: page }), count({ variant: `${t}:${letter}`, step: 'order', n: order }),
  ...(paid ? [count({ variant: `${t}:${letter}`, step: 'paid', n: paid })] : [])];

test('each test gets its standing: not started, not called, won, lost, no difference, six weeks, drifted', async () => {
  assert.equal((await push({ batch: batch(), counts: [
    ...arm('soon', 'A', 50, 5), ...arm('fresh', 'A', 1000, 50), ...arm('fresh', 'B', 1000, 90),
    ...arm('clear', 'A', 2000, 80, 40), ...arm('clear', 'B', 2000, 140, 70),
    ...arm('worse', 'A', 2000, 140), ...arm('worse', 'B', 2000, 80),
    ...arm('pricey', 'A', 2000, 80, 60), ...arm('pricey', 'B', 2000, 140, 50),
    ...arm('flat', 'A', 2000, 80), ...arm('flat', 'B', 2000, 84),
    ...arm('trio', 'A', 2000, 80), ...arm('trio', 'B', 2000, 84), ...arm('trio', 'C', 2000, 140),
    ...arm('slow', 'A', 900, 30), ...arm('slow', 'B', 920, 31),
    ...arm('drift', 'A', 1000, 10), ...arm('drift', 'B', 1300, 13),
    ...arm('ended', 'A', 500, 10), ...arm('ended', 'B', 500, 50),
  ] })).status, 200);
  const d = await dash(), by = Object.fromEntries(d.tests.map((t: any) => [t.id, t]));
  const states = Object.fromEntries(d.tests.map((t: any) => [t.id, t.state]));
  assert.deepEqual(states, { soon: 'not-started', fresh: 'not-called', clear: 'won', worse: 'lost', pricey: 'lost', flat: 'no-difference',
    trio: 'won', slow: 'six-weeks', drift: 'split-drifted', ended: 'not-called' });
  assert.equal(by.clear.winner, 'B');
  assert.equal(by.trio.winner, 'C');
  assert.match(by.pricey.reason, /guardrail/);
  // the numbers behind it
  const [a, b] = by.clear.arms;
  assert.deepEqual(a.metric, { n: 80, of: 2000, rate: 0.04 });
  assert.deepEqual(b.guardrail, { n: 70, of: 140, rate: 0.5 });
  assert.equal(a.p, null);
  assert.ok(b.p < 0.001);
  assert.equal(by.clear.progress, 2);
  assert.equal(by.clear.days, 20);
  assert.ok(by.pricey.arms[1].guardrailP < 0.05);
  // the p values as known (Python's math.erfc): the two-sided z-test of the rates, the chi-square test of the split
  assert.equal(by.flat.arms[1].p, 0.749761);
  assert.ok(Math.abs(by.slow.split.p - 0.639207) <= 1e-6, String(by.slow.split.p));
  assert.ok(by.drift.split.p < 0.001);
  assert.ok(by.fresh.arms[1].p < 0.05);           // significant, but 5 days and short of nothing: still not called
  assert.equal(by.fresh.days, 5);
  // a test that ended counts nothing after its end
  assert.deepEqual(by.ended.arms.map((x: any) => x.metric.of), [0, 0]);
  assert.equal(by.ended.days, 31);
  assert.equal(by.ended.split.p, null);
  assert.match(by.ended.reason, /ended/);
});

test("HQ's home: one line per app with a metrics.json, behind the board's login", async () => {
  assert.equal((await fetch(`${HQ}/api/numbers`)).status, 401);
  assert.equal((await fetch(`${HQ}/api/numbers/pebblepost`)).status, 401);
  const home = (await board('/api/numbers')).body;
  assert.equal(home.days, 28);
  assert.equal(home.to, today);
  assert.equal(home.from, plus(-27));
  assert.deepEqual(home.apps.map((x: any) => [x.slug, x.name, x.status, x.mode]), [['mossgram', 'Mossgram', 'preview', 'preview'], ['pebblepost', 'Pebble Post', 'live', 'live']]);
  assert.deepEqual(home.broken.map((x: any) => x.slug), ['brokenapp', 'linked']);
  assert.doesNotMatch(JSON.stringify(home), /planted-outside/);
  const p = home.apps.find((x: any) => x.slug === 'pebblepost');
  assert.equal(p.spark.length, 28);
  assert.equal(p.spark[27], 3);
  assert.equal(p.spark[25], 1);
  assert.equal(p.paid, 4);
  assert.equal(p.revenue, 99.9);
  assert.equal(p.page, (await dash()).steps.page);
  assert.equal(p.conversion, Math.round(4 / p.page * 1e6) / 1e6);
  assert.deepEqual(p.test, { id: 'fresh', state: 'not-called' });   // the first test running today
  assert.match(p.updated, /^\d{4}-\d\d-\d\dT/);
});

test("one app's dashboard: every day, the funnel's steps, countries, labels, what was ordered, totals and margin", async () => {
  await push({ batch: batch(), counts: [count({ campaign: 'spring', n: 40 }), count({ step: 'pack', what: 'round', n: 6 }), count({ step: 'pack', n: 2 })] });
  const d = await dash('?days=7');
  assert.equal(d.days, 7);
  assert.equal(d.daily.length, 7);
  assert.deepEqual(d.daily.map((x: any) => x.day), Array.from({ length: 7 }, (_, i) => plus(i - 6)));
  assert.deepEqual(Object.keys(d.daily[0].steps), ['page', 'price', 'order', 'pack', 'paid']);
  assert.deepEqual(d.daily[0], { day: plus(-6), steps: { page: 0, price: 0, order: 0, pack: 0, paid: 0 }, orders: 0, paid: 0, kept: 0, eur: 0 });
  assert.deepEqual(d.daily[6].steps.price, 17);
  assert.deepEqual({ ...d.daily[6], steps: undefined }, { day: today, steps: undefined, orders: 4, paid: 3, kept: 2, eur: 79.9 });
  assert.equal(d.steps.pack, 8);
  assert.deepEqual(d.countries, [{ country: 'NL', orders: 4, paid: 3, kept: 2, eur: 79.9 }, { country: 'BE', orders: 1, paid: 1, kept: 1, eur: 20 }]);
  assert.deepEqual(d.campaigns.find((c: any) => c.campaign === 'spring'), { campaign: 'spring', page: 40, orders: 1, paid: 1, kept: 1, eur: 20 });
  assert.equal(d.campaigns.find((c: any) => c.campaign === null).orders, 4);
  assert.deepEqual(d.what, [{ what: 'round', orders: 5, paid: 4, kept: 3, eur: 99.9 }]);
  assert.deepEqual(d.stepWhat, { pack: [{ what: 'round', n: 6 }, { what: null, n: 2 }] });
  assert.deepEqual(d.totals, { orders: 5, paid: 4, kept: 3, eur: 99.9, refunded: 1, net: 90, netUnknown: 0, margin: 28 });   // 2 × €10 (NL) + 1 × €8 (BE)
  assert.deepEqual(d.targets, [{ ...FILE.targets[0], value: null, mark: 'none' }]);
  assert.deepEqual(d.file, FILE);
  assert.equal(d.mode, 'live');
  // the preview's numbers are separate, and the period's bounds are checked
  const pv = await dash('?mode=preview');
  assert.equal(pv.mode, 'preview');
  assert.equal(pv.totals.orders, 0);
  assert.equal(pv.updated, null);
  assert.equal((await board('/api/numbers/pebblepost?days=0')).status, 400);
  assert.equal((await board('/api/numbers/pebblepost?days=401')).status, 400);
  assert.equal((await board('/api/numbers/pebblepost?days=400')).body.daily.length, 400);
  assert.equal((await board('/api/numbers/pebblepost?mode=test')).status, 400);
  assert.equal((await board('/api/numbers/nofile')).status, 404);
  assert.equal((await board('/api/numbers/..%2Fcompany')).status, 404);
});

// A paid basket of the shop's, stored as payments.ts and codes.ts keep one (no route short of a Stripe checkout and its
// webhook makes one): its things (and a line of the shop's own going
// with the first, when asked), and whether its buyer had paid for one before (null: not known)
let baskets = 0;
function paidBasket(at: string, things: number, back: boolean | null, o: { mode?: string; status?: string; amount?: number; own?: boolean } = {}) {
  const n = ++baskets, session = `cs_live_basket${n}`, paidAt = `${at}T10:00:00.000Z`;
  db.prepare(`insert into payments (id, created, product, mode, reference, amount, currency, status, updated, basket)
    values (?, ?, 'front', ?, ?, ?, 'eur', ?, ?, ?)`).run(session, paidAt, o.mode ?? 'live', `bk${n}`, o.amount ?? 3995, o.status ?? 'paid', paidAt, `bk${n}`);
  for (let i = 0; i < things + (o.own ? 1 : 0); i++) {
    const line = `ln_basket${n}_${i}`;
    db.prepare(`insert into pay_lines (id, created, product, mode, reference, amount, currency, description, ships_in, cutoff, status, session,
      paid_at, updated, goes_with) values (?, ?, 'pebblepost', ?, ?, 3995, 'eur', '', 1, 12, 'paid', ?, ?, ?, ?)`)
      .run(line, paidAt, o.mode ?? 'live', line, session, paidAt, paidAt, i === things ? `ln_basket${n}_0` : null);
    db.prepare('insert into session_lines (session, line, position, card, saved) values (?, ?, ?, 3995, 0)').run(session, line, i);
  }
  if (back !== null) db.prepare('insert into code_orders (session, mode, paid, newcomer) values (?, ?, ?, ?)').run(session, o.mode ?? 'live', at, back ? 0 : 1);
}

test('a net the app doesn\'t know stays unknown: the dashboard gives no net while any kept order lacks one', async () => {
  const summary = (rows: unknown[]) => ({ batch: batch(), counts: [], orders: { from: plus(-1), to: today, made: Date.now(), rows } });
  await push(summary([row({ day: plus(-1), kept: 2, paid: 2, orders: 2, eur: 9.98, net: 3.8, netUnknown: 1 })]), as('pebblepost', 'preview'));
  const unknown = (await dash('?days=7&mode=preview')).totals;
  assert.deepEqual({ eur: unknown.eur, net: unknown.net, netUnknown: unknown.netUnknown }, { eur: 9.98, net: null, netUnknown: 1 });
  // the same days summarised again once the app knows both nets
  await push(summary([row({ day: plus(-1), kept: 2, paid: 2, orders: 2, eur: 9.98, net: 7.6 })]), as('pebblepost', 'preview'));
  const known = (await dash('?days=7&mode=preview')).totals;
  assert.deepEqual({ eur: known.eur, net: known.net, netUnknown: known.netUnknown }, { eur: 9.98, net: 7.6, netUnknown: 0 });
});

test("the home carries the shop's live paid baskets per day: with more than one thing, and from a buyer who came back", async () => {
  paidBasket(today, 1, false);
  paidBasket(today, 2, true);
  paidBasket(today, 1, true, { own: true });   // a line of the shop's own is no second thing
  paidBasket(plus(-3), 3, null);
  paidBasket(plus(-40), 2, true);   // before the home's 28 days
  paidBasket(today, 2, true, { mode: 'test' });
  paidBasket(today, 2, true, { status: 'test', amount: 0 });
  paidBasket(today, 2, true, { amount: 0 });   // paid by vouchers alone
  // the orders the stalls put in the basket and those in a checkout opened (payments.ts lineSteps, as its baskets call
  // them), live only: one taken back from the day it was counted, a test line's in preview
  const { lineSteps } = await import('./payments.ts');
  const step = (mode: string, s: 'basket' | 'checkout', day: string, n: 1 | -1) => {
    for (const hook of lineSteps) hook({ product: 'nofile', mode } as any, s, `${day}T10:00:00.000Z`, n);
  };
  for (const s of ['basket', 'basket', 'basket', 'checkout', 'checkout'] as const) step('live', s, today, 1);
  step('live', 'basket', plus(-1), 1);
  step('live', 'basket', plus(-1), -1);
  step('test', 'basket', today, 1);
  assert.deepEqual((await board('/api/numbers')).body.baskets, { basket: 3, checkout: 2, paid: 4, several: 2, returning: 2, known: 3, days: [
    { day: plus(-3), paid: 1, several: 1, returning: 0, known: 0 },
    { day: today, paid: 3, several: 1, returning: 2, known: 3 },
  ] });
  // and over a longer span when asked (hq numbers --days)
  const longer = (await board('/api/numbers?days=60')).body;
  assert.deepEqual([longer.days, longer.baskets.paid], [60, 5]);
  assert.equal((await board('/api/numbers?days=0')).status, 400);
});

test('agents read the same numbers, and hq numbers prints them', async () => {
  const penny = await h.start({ agent: 'penny' });
  const agent = (q: string) => h.agent(`numbers${q}`, penny.token);
  assert.deepEqual((await agent('')).body, (await board('/api/numbers')).body);
  assert.deepEqual((await agent('?app=pebblepost&days=14')).body, await dash('?days=14'));
  assert.equal((await agent('?app=pebblepost&days=1000')).status, 400);
  assert.equal((await agent('?app=nofile')).status, 404);
  assert.equal((await h.agent('numbers', '')).status, 401);

  const run = async (...args: string[]) => { const r = await h.hq(penny, 'numbers', ...args); assert.equal(r.code, 0, r.out); return r.out; };
  const list = await run();
  assert.match(list, /pebblepost .*€99\.90 from 4 paid orders/);
  assert.match(list, /test fresh: not-called/);
  assert.match(list, /brokenapp: app\/metrics\.json/);
  assert.match(list, /The shop's baskets \(live\): 3 orders put in, 2 in a checkout opened, 4 paid, 2 with more than one thing \(50%\), 2 from a buyer who came back \(66\.67%/);
  assert.match(list, new RegExp(`\\n  ${today}: 3 paid, 1 with more than one thing \\(33\\.33%\\), 2 from a buyer who came back \\(66\\.67%\\)\\n  ${plus(-3)}: 1 paid`));
  assert.match(await run('--days', '60'), /The shop's baskets \(live\): 3 orders put in, 2 in a checkout opened, 5 paid/);
  const one = await run('pebblepost', '--days', '7');
  for (const shown of [/Pressed Pay: 1417 \(4\.85%/, /NL: 2 kept of 3 paid \(4 made\), €79\.90/, /spring: 40 page loads, 1 kept/, /Round pebble: 3 kept/,
    /margin before ads €28\.00/, /clear: Does a bigger button get more presses\?\n {4}won: B/]) assert.match(one, shown);
  assert.equal(JSON.parse(await run('pebblepost', '--json', '--mode', 'preview')).mode, 'preview');
  assert.notEqual((await h.hq(penny, 'numbers', 'nofile')).code, 0);
});

test('a search source is a campaign label like any other, on the page and sales dashboard', async () => {
  const campaign = 'search-google';
  assert.equal((await push({ batch: batch(), counts: [count({ campaign, n: 9 })], orders: { from: today, to: today, made: Date.now(), rows: [row({ campaign })] } })).status, 200);
  assert.deepEqual((await dash('?days=7')).campaigns.find((c: any) => c.campaign === campaign), { campaign, page: 9, orders: 1, paid: 1, kept: 1, eur: 39.95 });
});

// ---- order sources
const preview = as('pebblepost', 'preview');
const sourceRows = (table: string) => (db.prepare(`select day, campaign from ${table} where product = 'pebblepost' and mode = 'preview' and campaign != '' order by day`).all() as any[]).map(r => ({ ...r }));
const pageSources = (database = db) => (database.prepare(`select product, day, campaign from metric_counts where mode = 'preview'
  and step = 'page' and campaign != '' order by product, day, campaign`).all() as any[]).map(r => `${r.product} ${r.day} ${r.campaign}`);
const pageLoads = (database = db) => Object.fromEntries((database.prepare(`select product, sum(n) n from metric_counts where mode = 'preview'
  and step = 'page' group by product order by product`).all() as any[]).map(r => [r.product, r.n]));
const previewTotals = () => ({ ...(db.prepare(`select count(distinct day) days, sum(orders) orders, sum(paid) paid, sum(kept) kept, sum(cents) cents, sum(net_cents) net
  from metric_orders where product = 'pebblepost' and mode = 'preview'`).get() as any) });

test('a source goes once its day is 60 days old, never rides on a step past the page load, and leaves the totals whole', async () => {
  // A restored copy can hold an old day's source and sources on a funnel step
  db.prepare(`insert into metric_orders (product, mode, day, variant, campaign, country, what, orders, paid, refunded, kept, cents, net_cents, net_unknown)
    values ('pebblepost', 'preview', ?, '', ?, 'NL', '', 1, 1, 0, 1, 499, 400, 0)`).run(plus(-200), 'spring');
  db.prepare(`insert into metric_orders (product, mode, day, variant, campaign, country, what, orders, paid, refunded, kept, cents, net_cents, net_unknown)
    values ('pebblepost', 'preview', ?, '', '', 'NL', '', 2, 1, 0, 1, 499, 400, 0)`).run(plus(-200));
  db.prepare(`insert into metric_counts (product, mode, day, step, variant, campaign, country, what, n) values ('pebblepost', 'preview', ?, 'order', '', 'spring', '', '', 1)`).run(plus(-1));
  const response = await push({ batch: batch(), counts: [count({ step: 'order', campaign: 'spring' }), count({ campaign: 'spring', n: 5 })],
    orders: { from: plus(-61), to: today, made: Date.now(), rows: [row({ day: plus(-61), campaign: 'spring' }), row({ day: plus(-58), campaign: 'spring' })] } }, preview);
  assert.equal(response.status, 200);
  // the old day's and the day past 60 go as the push arrives. The page load keeps its label
  assert.deepEqual(sourceRows('metric_orders'), [{ day: plus(-58), campaign: 'spring' }]);
  assert.deepEqual(sourceRows('metric_counts'), [{ day: today, campaign: 'spring' }]);
  assert.equal((db.prepare("select sum(n) n from metric_counts where product = 'pebblepost' and mode = 'preview' and step = 'order'").get() as any).n, 2);
  assert.deepEqual(previewTotals(), { days: 3, orders: 5, paid: 4, kept: 4, cents: 499 * 2 + 3995 * 2, net: 400 * 2 + 3000 * 2 });
  // A push without an order summary still folds a day that has come of age
  db.prepare("update metric_orders set day = ? where product = 'pebblepost' and mode = 'preview' and day = ?").run(plus(-62), plus(-58));
  assert.equal((await push({ batch: batch(), counts: [] }, preview)).status, 200);
  assert.deepEqual(sourceRows('metric_orders'), []);
  assert.deepEqual(previewTotals(), { days: 3, orders: 5, paid: 4, kept: 4, cents: 499 * 2 + 3995 * 2, net: 400 * 2 + 3000 * 2 });
});

test("a summary made before the one HQ has is never taken, and a batch sent again brings its newer summary", async () => {
  const later = Date.now(), earlier = later - 60_000, b = batch();
  const summary = (made: number, campaign: string) => ({ from: plus(-1), to: today, made, rows: [row({ day: plus(-1), campaign })] });
  assert.deepEqual((await push({ batch: b, counts: [count({ step: 'pack' })], orders: summary(earlier, 'spring') }, preview)).body, { ok: true });
  // the same batch again, its summary made since the buyer objected: counted once, the source gone
  assert.deepEqual((await push({ batch: b, counts: [count({ step: 'pack' })], orders: summary(later, '') }, preview)).body, { ok: true, duplicate: true });
  assert.equal((db.prepare("select n from metric_counts where product = 'pebblepost' and mode = 'preview' and step = 'pack' and day = ?").get(today) as any).n, 1);
  assert.deepEqual(sourceRows('metric_orders').filter(r => r.day === plus(-1)), []);
  // the first summary, delayed on the way: its counts are a batch of their own, its rows are older
  assert.equal((await push({ batch: batch(), counts: [], orders: summary(earlier, 'spring') }, preview)).status, 200);
  assert.deepEqual(sourceRows('metric_orders').filter(r => r.day === plus(-1)), []);
  // a copy without its time can't pass for a newer one
  assert.equal((await push({ batch: batch(), counts: [], orders: { ...summary(earlier, 'spring'), made: undefined } }, preview)).status, 400);
  assert.deepEqual(sourceRows('metric_orders').filter(r => r.day === plus(-1)), []);
  assert.equal((await push({ batch: batch(), counts: [], orders: { ...summary(later, ''), made: later + 2 * 60_000 } }, preview)).status, 400);
});

test('a visitor and a visit need no line in metrics.json and keep their source as a page load does', async () => {
  const moss = as('mossgram', 'preview');
  const landed = () => (db.prepare(`select day, step, campaign, n from metric_counts where product = 'mossgram' and mode = 'preview'
    and step in ('visitor', 'visit') order by day, step, campaign`).all() as any[]).map(r => ({ ...r }));
  // A restored copy can hold an old day's source on a visit too
  db.prepare(`insert into metric_counts (product, mode, day, step, variant, campaign, country, what, n) values ('mossgram', 'preview', ?, 'visit', '', 'winter', '', '', 3)`).run(plus(-61));
  assert.equal((await push({ batch: batch(), counts: [count({ step: 'visitor', campaign: 'meta-open-shop', n: 2 }),
    count({ step: 'visit', campaign: 'meta-open-shop', n: 3 }), count({ step: 'paid', campaign: 'meta-open-shop' })] }, moss)).status, 200);
  assert.deepEqual(landed(), [
    { day: plus(-61), step: 'visit', campaign: '', n: 3 },
    { day: today, step: 'visit', campaign: 'meta-open-shop', n: 3 },
    { day: today, step: 'visitor', campaign: 'meta-open-shop', n: 2 },
  ]);
  // a funnel step still carries none, and a step neither built in nor in the file is refused
  assert.equal((db.prepare(`select count(*) n from metric_counts where product = 'mossgram' and step = 'paid' and campaign != ''`).get() as any).n, 0);
  assert.equal((await push({ batch: batch(), counts: [count({ step: 'visitors' })] }, moss)).status, 400);
});

test('every load needs no line in metrics.json, keeps where it came from, and the numbers give it by source, outside the funnel', async () => {
  const moss = as('mossgram', 'preview');
  assert.equal((await push({ batch: batch(), counts: [count({ step: 'load', campaign: 'meta', n: 4 }), count({ step: 'load', campaign: 'prefetch', n: 9 }),
    count({ step: 'load', campaign: 'agent-facebookexternalhit', n: 2 }), count({ step: 'page', n: 4 })] }, moss)).status, 200);
  const penny = await h.start({ agent: 'penny' });
  const numbers = (await h.agent('numbers?app=mossgram&mode=preview', penny.token)).body;
  assert.deepEqual(numbers.sources, [{ source: 'prefetch', n: 9 }, { source: 'meta', n: 4 }, { source: 'agent-facebookexternalhit', n: 2 }]);
  assert.deepEqual(Object.keys(numbers.steps), ['page', 'paid']);
  const r = await h.hq(penny, 'numbers', 'mossgram', '--mode', 'preview');
  assert.match(r.out, /Every load by where it came from[^\n]*\n {2}prefetch: 9\n {2}meta: 4\n {2}agent-facebookexternalhit: 2\n/);
});

test('a start, a restored copy included, folds every source into totals that stay whole', async () => {
  await push({ batch: batch(), counts: [], orders: { from: plus(-1), to: today, made: Date.now(), rows: [row({ day: plus(-1), campaign: 'spring' })] } }, preview);
  const copy = mkdtempSync(`${tmpdir()}/metrics-restore-`);
  after(() => rmSync(copy, { recursive: true, force: true }));
  db.prepare('vacuum into ?').run(`${copy}/hq.db`);
  const copied = new DatabaseSync(`${copy}/hq.db`);
  const totals = () => ({ ...(copied.prepare(`select sum(orders) orders, sum(kept) kept, sum(cents) cents from metric_orders where product = 'pebblepost' and mode = 'preview'`).get() as any) });
  const kept = totals(), loads = pageLoads(copied);
  assert.ok((copied.prepare("select count(*) n from metric_orders where campaign != ''").get() as any).n > 0);
  assert.ok(pageSources(copied).length > 0);
  copied.close();
  await startOn(copy);
  const restored = new DatabaseSync(`${copy}/hq.db`, { readOnly: true });
  assert.equal((restored.prepare("select count(*) n from metric_orders where campaign != ''").get() as any).n, 0);
  assert.deepEqual({ ...(restored.prepare(`select sum(orders) orders, sum(kept) kept, sum(cents) cents from metric_orders where product = 'pebblepost' and mode = 'preview'`).get() as any) }, kept);
  assert.deepEqual(pageSources(restored), []);
  assert.deepEqual(pageLoads(restored), loads);
  restored.close();
});

// ---- page sources
test("a page load's source goes after 60 days and through an objected order's day on every app, and the totals stay whole", async () => {
  const moss = as('mossgram', 'preview'), autumn = () => pageSources().filter(s => s.endsWith(' autumn'));
  // A restored copy can hold an old day's page source
  db.prepare(`insert into metric_counts (product, mode, day, step, variant, campaign, country, what, n) values ('mossgram', 'preview', ?, 'page', '', 'autumn', '', '', 3)`).run(plus(-61));
  const loads = pageLoads();
  assert.equal((await push({ batch: batch(), counts: [count({ campaign: 'autumn', n: 2 }), count({ day: plus(-1), campaign: 'autumn' })] }, preview)).status, 200);
  assert.equal((await push({ batch: batch(), counts: [count({ campaign: 'autumn' }), count({ day: plus(-1), campaign: 'autumn' })] }, moss)).status, 200);
  assert.deepEqual(autumn(), [`mossgram ${plus(-1)} autumn`, `mossgram ${today} autumn`, `pebblepost ${plus(-1)} autumn`, `pebblepost ${today} autumn`]);

  // Yesterday's buyer objects: Pebble Post's summary has every app's page loads lose their source through that day
  const summary = (objected: unknown) => ({ from: plus(-1), to: today, made: Date.now(), objected, rows: [row({ day: plus(-1) })] });
  assert.equal((await push({ batch: batch(), counts: [], orders: summary(plus(1)) }, preview)).status, 400);
  assert.equal((await push({ batch: batch(), counts: [], orders: summary(plus(-1)) }, preview)).status, 200);
  assert.deepEqual(autumn(), [`mossgram ${today} autumn`, `pebblepost ${today} autumn`]);
  // A visit of that day that reaches HQ only now (a retry after an outage) has none either
  assert.equal((await push({ batch: batch(), counts: [count({ day: plus(-1), campaign: 'autumn', n: 4 })] }, moss)).status, 200);
  assert.deepEqual(autumn(), [`mossgram ${today} autumn`, `pebblepost ${today} autumn`]);
  assert.deepEqual(pageLoads(), { ...loads, mossgram: loads.mossgram + 1 + 1 + 4, pebblepost: loads.pebblepost + 2 + 1 });
});

test("a page load's source stays at any start of HQ's own data on its host, and goes on a copy that lacks an objection", async () => {
  assert.equal((await push({ batch: batch(), counts: [count({ campaign: 'winter' }), count({ day: plus(-1), campaign: 'winter' })] }, preview)).status, 200);
  const folder = (name: string) => { const made = mkdtempSync(`${tmpdir()}/metrics-${name}-`); after(() => rmSync(made, { recursive: true, force: true })); return made; };
  const read = <T>(copy: string, look: (database: DatabaseSync) => T) => { const copied = new DatabaseSync(`${copy}/hq.db`, { readOnly: true }); try { return look(copied); } finally { copied.close(); } };
  const cutoff = (database: DatabaseSync) => database.prepare('select through from metric_page_cutoff').all().map((r: any) => r.through);
  // this host's memory as it is now, for a start that mustn't change the one the tests' HQ runs on
  const thisHost = () => { const run = folder('host'); cpSync(RUN, run, { recursive: true }); return run; };
  // A deploy, a crash or a slow start: HQ starts again on the same data and host, with no stop of its own written
  // (a copy stands for the original's start), as often as it likes
  const deploy = folder('deploy'), host = thisHost();
  db.prepare('vacuum into ?').run(`${deploy}/hq.db`);
  const sources = read(deploy, pageSources), loads = read(deploy, pageLoads);
  assert.ok(sources.some(s => s.endsWith(' winter')));
  for (let start = 0; start < 2; start++) {
    await startOn(deploy, { run: host });
    assert.deepEqual(read(deploy, pageSources), sources);
    assert.deepEqual(read(deploy, cutoff), []);
  }
  // On another host, or after the host's reboot, it keeps no page source, and keeps today's cutoff
  await startOn(deploy, { run: folder('reboot') });
  assert.deepEqual(read(deploy, pageSources), []);
  assert.deepEqual(read(deploy, pageLoads), loads);
  assert.deepEqual(read(deploy, cutoff), [today]);

  // HQ's whole data folder is copied, the database and whatever lies beside it, and today's buyer objects on the
  // original. The copy, started on the same host or another, keeps no page source and keeps today's cutoff.
  const snapshot = folder('snapshot'), token = readFileSync(`${RUN}/metrics-objection`, 'utf8');
  cpSync(DATA, snapshot, { recursive: true, filter: from => !from.startsWith(`${DATA}/hq.db`) });
  db.prepare('vacuum into ?').run(`${snapshot}/hq.db`);
  assert.ok(read(snapshot, pageSources).some(s => s.endsWith(' winter')));
  assert.equal((await push({ batch: batch(), counts: [], orders: { from: today, to: today, made: Date.now(), objected: today, rows: [row()] } }, preview)).status, 200);
  assert.deepEqual(pageSources().filter(s => s.endsWith(' winter')), []);
  assert.notEqual(readFileSync(`${RUN}/metrics-objection`, 'utf8'), token);
  const restored = [];
  for (const run of [folder('other'), thisHost()]) {
    const copy = folder('restore');
    cpSync(snapshot, copy, { recursive: true });
    await startOn(copy, { run });
    assert.deepEqual(read(copy, pageSources), []);
    assert.deepEqual(read(copy, cutoff), [today]);
    restored.push(run);
  }
  // A second copy of the same snapshot on the host where the first has started since passes no better
  const again = folder('again');
  cpSync(snapshot, again, { recursive: true });
  await startOn(again, { run: restored[1] });
  assert.deepEqual(read(again, pageSources), []);

  // The same objected day again changes nothing: a copy taken before it holds every objection
  const before = folder('before');
  db.prepare('vacuum into ?').run(`${before}/hq.db`);
  const now = readFileSync(`${RUN}/metrics-objection`, 'utf8');
  assert.equal((await push({ batch: batch(), counts: [count({ day: plus(-1), campaign: 'winter' })], orders: { from: today, to: today, made: Date.now(), objected: today, rows: [row()] } }, preview)).status, 200);
  assert.equal(readFileSync(`${RUN}/metrics-objection`, 'utf8'), now);
  const kept = read(before, pageSources);
  await startOn(before, { run: thisHost() });
  assert.deepEqual(read(before, pageSources), kept);
  assert.deepEqual(read(before, cutoff), []);
});

test("an objection taken after a copy was made sends that copy's page sources, counts kept, through its start's day", async () => {
  const folder = (name: string) => { const made = mkdtempSync(`${tmpdir()}/metrics-${name}-`); after(() => rmSync(made, { recursive: true, force: true })); return made; };
  const look = <T>(copy: string, read: (database: DatabaseSync) => T) => { const copied = new DatabaseSync(`${copy}/hq.db`, { readOnly: true }); try { return read(copied); } finally { copied.close(); } };
  const sources = (database: DatabaseSync) => (database.prepare(`select day, campaign from metric_counts where product = 'pebblepost' and mode = 'live'
    and step = 'page' and campaign = 'spring' order by day`).all() as any[]).map(r => `${r.day} ${r.campaign}`);
  const loads = (database: DatabaseSync) => (database.prepare(`select sum(n) n from metric_counts where product = 'pebblepost' and mode = 'live' and step = 'page'`).get() as any).n;
  const cutoff = (database: DatabaseSync) => database.prepare('select through from metric_page_cutoff').all().map((r: any) => r.through);
  const thisHost = () => { const run = folder('host'); cpSync(RUN, run, { recursive: true }); return run; };
  assert.equal((await push({ batch: batch(), counts: [count({ campaign: 'spring' }), count({ day: plus(-1), campaign: 'spring' })] })).status, 200);

  // A copy, then yesterday's buyer objects, then another copy
  const earlier = folder('earlier');
  db.prepare('vacuum into ?').run(`${earlier}/hq.db`);
  assert.deepEqual(look(earlier, sources), [`${plus(-1)} spring`, `${today} spring`]);
  const had = look(earlier, loads);
  assert.equal((await push({ batch: batch(), counts: [], orders: { from: plus(-1), to: today, made: Date.now(), objected: plus(-1), rows: [row({ day: plus(-1) })] } })).status, 200);
  assert.deepEqual(sources(db), [`${today} spring`]);
  const later = folder('later');
  db.prepare('vacuum into ?').run(`${later}/hq.db`);

  // The earlier copy started on this host folds every page source, counts kept, through the start's day
  await startOn(earlier, { run: thisHost() });
  assert.deepEqual(look(earlier, sources), []);
  assert.equal(look(earlier, loads), had);
  assert.deepEqual(look(earlier, cutoff), [today]);
  // The later one keeps what the objection left
  await startOn(later, { run: thisHost() });
  assert.deepEqual(look(later, sources), [`${today} spring`]);
  assert.deepEqual(look(later, cutoff), []);
});

test("a page load that reaches a restored copy before any summary has no source through the restore's day", async () => {
  // A copy taken before an objection, started on another host; yesterday's visit waits in the app's counter
  const copy = mkdtempSync(`${tmpdir()}/metrics-pending-`);
  after(() => rmSync(copy, { recursive: true, force: true }));
  db.prepare('vacuum into ?').run(`${copy}/hq.db`);
  const unobjected = new DatabaseSync(`${copy}/hq.db`);
  unobjected.exec('update metric_summaries set objected = null');
  unobjected.close();
  const loads = (database: DatabaseSync) => (database.prepare(`select coalesce(sum(n), 0) n from metric_counts where product = 'pebblepost' and mode = 'preview' and step = 'page' and day = ?`).get(plus(-1)) as any).n;
  const before = new DatabaseSync(`${copy}/hq.db`, { readOnly: true }), had = loads(before);
  before.close();
  await startOn(copy, { push: { batch: batch(), counts: [count({ day: plus(-1), campaign: 'pending', n: 2 })] } });
  const restored = new DatabaseSync(`${copy}/hq.db`, { readOnly: true });
  assert.deepEqual(pageSources(restored), []);
  assert.equal(loads(restored), had + 2);
  restored.close();
});

// HQ's metrics started on another data folder (and another host's memory, without run), as a process of its own, and a
// push from Pebble Post's preview to it
const startOn = (copy: string, { push, run = '' }: { push?: unknown; run?: string } = {}) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
  const metrics = await import(${JSON.stringify(new URL('./metrics.ts', import.meta.url).href)});
  if (process.env.PUSH) {
    const { createServer } = await import('node:http');
    const hq = createServer(metrics.handle).listen(0);
    await new Promise(done => hq.once('listening', done));
    const r = await fetch('http://localhost:' + hq.address().port + '/api/metrics/push', { method: 'POST', body: process.env.PUSH, headers: {
      authorization: 'Bearer ' + metrics.tokenFor('pebblepost', 'preview'), 'x-product': 'pebblepost', 'x-mode': 'preview', 'content-type': 'application/json' } });
    if (r.status !== 200) throw new Error(await r.text());
  }
  process.exit(0)`], { env: { ...process.env, DATA_DIR: copy, SECRETS_DIR: `${copy}/secrets`, RUN_DIR: run, PUSH: push === undefined ? '' : JSON.stringify(push) } });
