// node --test src/orders.test.ts   (the harness; a local server plays Print API's live API)
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { harness } from './harness.ts';

// ---- Print API, live, as far as the list uses it. Everything a customer typed (and Print API's own words) carries a
// planted string, so a test can look for it anywhere HQ keeps or shows things.
const PLANTED = ['Zwanenburgwal', 'Hortensia Pietersma', 'pietersma@example.nl', 'hortensia99', 'Oma Riekje', 'secret-note',
  'files.example/print', 'pay.example/setup', 'Klant belde', 'track.example', 'Denied for Hortensia'];
const DAY = 24 * 3600e3;
const dutch = (ms: number) => new Date(ms).toISOString().slice(0, 23);   // Print API's shape (Dutch time, no offset)
type Order = { id: string; placed: number; status: string; metadata: string; items?: any[]; invoice?: any; invoicingState?: string;
  cancellation?: string };
// since: each sync/statuses call's since, what Print API is asked for; calls: every call (none without the keys)
const pa = { orders: new Map<string, Order>(), log: [] as { id: string; status: string; dateTime: string }[], since: [] as string[], calls: 0, fail: 0, failRead: '', failCancel: '' };
function add(o: Order) {
  pa.orders.set(o.id, o);
  pa.log.push({ id: o.id, status: 'Created', dateTime: dutch(o.placed) });
}
function move(id: string, status: string, at = Date.now()) {
  pa.orders.get(id)!.status = status;
  pa.log.push({ id, status, dateTime: dutch(at) });
}
const invoice = (net: number) => ({ production: { cost: net, taxes: [{ rate: 0.21, amount: +(net * 0.21).toFixed(2), calculatedOver: net }] },
  shipping: { cost: 4.5, taxes: [{ rate: 0.21, amount: 0.95, calculatedOver: 4.5 }] }, handling: { cost: 0.4, taxes: [{ rate: 0.21, amount: 0.08, calculatedOver: 0.4 }] },
  discount: { cost: 0, taxes: [] }, total: { cost: net + 4.9, taxes: [{ rate: 0.21, amount: +((net + 4.9) * 0.21).toFixed(2), calculatedOver: net + 4.9 }] }, note: 'Klant belde' });
const orderOut = (o: Order) => ({ id: o.id, dateTime: dutch(o.placed), status: o.status, productionSpeed: 'Standard', email: 'pietersma@example.nl',
  checkout: { amount: 12.3, setupUrl: 'https://pay.example/setup/1' }, trackingUrl: 'https://track.example/3S-Zwanenburgwal',
  items: o.items ?? [{ id: '1', productId: 'kalender_30x88_1p', pageCount: 1, quantity: 1, title: 'Oma Riekje', metadata: 'secret-note',
    files: { content: { status: 'Accepted', url: 'https://files.example/print/1.pdf' } }, options: [] }],
  metadata: o.metadata, shipping: { method: { name: 'NL Pakket S', isTrackable: true },
    address: { name: 'Hortensia Pietersma', line1: 'Zwanenburgwal 12', postCode: '1011 JR', city: 'Amsterdam', country: 'NL' } },
  invoice: o.invoice ?? invoice(2.95), invoicingState: o.invoicingState ?? 'Included' });
const printapi: Server = createServer(async (q, s) => {
  for await (const _ of q) { /* the body: only the token's */ }
  const url = new URL(q.url!, 'http://x'), json = (code: number, b: unknown) => { s.writeHead(code, { 'content-type': 'application/json' }); s.end(JSON.stringify(b)); };
  pa.calls++;
  if (url.pathname === '/v2/oauth') return json(200, { access_token: 'tok', expires_in: 14400 });
  if (q.headers.authorization !== 'Bearer tok') return json(401, { message: 'Authorization has been denied for this request.' });
  if (pa.fail) return json(pa.fail, { message: 'Denied for Hortensia Pietersma, Zwanenburgwal 12' });
  if (url.pathname === '/v2/orders') {
    const all = [...pa.orders.values()].sort((a, b) => b.placed - a.placed), offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
    return json(200, { count: all.length, offset, limit, results: all.slice(offset, offset + limit).map(o =>
      ({ id: o.id, dateTime: dutch(o.placed), status: o.status, url: `${process.env.PRINTAPI_LIVE_API}/orders/${o.id}`, email: 'pietersma@example.nl', username: 'hortensia99' })) });
  }
  if (url.pathname === '/v2/sync/statuses') {
    const since = url.searchParams.get('since')!;
    pa.since.push(since);
    return json(200, { since, results: pa.log.filter(e => e.dateTime >= since.slice(0, 23)) });
  }
  const m = url.pathname.match(/^\/v2\/orders\/([^/]+)(\/cancellation)?$/), o = m && pa.orders.get(decodeURIComponent(m[1]));
  if (!o) return json(404, { message: 'Not found' });
  if (!m![2] && o.id === pa.failRead) return json(500, { message: 'Denied for Hortensia Pietersma' });
  if (m![2] && o.id === pa.failCancel) return json(503, { message: 'Denied for Hortensia Pietersma' });
  if (m![2]) return json(200, { status: o.cancellation ?? 'None', reason: 'Klant belde: Zwanenburgwal' });
  return json(200, orderOut(o));
});
await new Promise<void>(r => printapi.listen(0, r));
after(() => printapi.close());

const h = await harness('orders', {
  env: { PRINTAPI_LIVE_API: `http://localhost:${(printapi.address() as AddressInfo).port}/v2` },
  before: repo => { for (const p of ['pebblet', 'plankbook', 'tidepool']) mkdirSync(`${repo}/products/${p}`, { recursive: true }); },
});
const { db, dataDir: DATA } = h;
const orders = await import('./orders.ts');
const ownOrders = await import('./printapi.ts');
const secrets = await import('./secrets.ts');
const jobs = await import('./jobs.ts');

const LIVE = { PRINTAPI_LIVE_CLIENT_ID: 'live-id', PRINTAPI_LIVE_CLIENT_SECRET: 'live-secret' };
const keyed = () => secrets.saveSecrets(Object.keys(LIVE), LIVE);
// The list as the agent whose work needs it reads it (hq orders: org.yaml's roles.orders)
const penny = await h.start({ agent: 'penny' });
const listed = async (since?: string) => (await h.call(`/api/agent/orders${since ? `?since=${since}` : ''}`, penny.token)).body;
const byId = async (id: string, since = 'all') => (await listed(since)).orders.find((o: any) => o.id === id);
const everything = () => ['hq.db', 'hq.db-wal', 'hq.db-journal'].map(f => existsSync(`${DATA}/${f}`) ? readFileSync(`${DATA}/${f}`).toString('latin1') : '').join();
const planted = (text: string) => PLANTED.filter(p => text.toLowerCase().includes(p.toLowerCase()));
// The hourly check, an hour (or more) on each time
const sync = (now = Date.now()) => orders.tick(now);

// Each test a Print API account of its own: what the last one synced goes (and its sync times with it)
beforeEach(() => {
  secrets.forget(Object.keys(LIVE));
  db.exec("delete from printapi_orders; delete from settings where key like 'orders.%'; delete from payments");
  pa.orders.clear(); pa.log.length = 0; pa.since.length = 0; pa.calls = 0; pa.fail = 0; pa.failRead = ''; pa.failCancel = '';
});

test('without both live keys nothing calls Print API, not even for a token', async () => {
  add({ id: 'bud-1', placed: Date.now() - DAY, status: 'Created', metadata: 'pebblet' });
  await sync();
  writeFileSync(`${DATA}/secrets/PRINTAPI_LIVE_CLIENT_ID`, 'live-id');   // one of the two
  await sync(Date.now() + 2 * 3600e3);
  assert.equal(pa.calls, 0);
  assert.deepEqual(await listed(), { keys: false, synced: null, since: new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10), error: null, orders: [] });
});

test('the first sync pages through the listing and reads every order and its cancellation, with its history', async () => {
  keyed();
  const now = Date.now();
  for (let i = 0; i < 60; i++) add({ id: `ys-${i}`, placed: now - (i + 1) * 3600e3, status: 'Created', metadata: 'plankbook' });
  await sync(now);
  assert.equal((await listed('all')).orders.length, 60);                    // past the listing's first page of 50
  assert.equal(pa.since[0].endsWith('Z'), true);                              // UTC with Z
  assert.equal(Date.parse(pa.since[0]), now - 6 * DAY);                      // first run: as far back as it safely goes
  const { firstSeen, lastChecked, ...o } = await byId('ys-0'), { note, ...kept } = invoice(2.95);
  assert.deepEqual(o, {
    id: 'ys-0', placed: dutch(now - 3600e3), shop: 'plankbook', status: 'Created', history: [{ status: 'Created', at: dutch(now - 3600e3) }],
    items: [{ productId: 'kalender_30x88_1p', quantity: 1, pageCount: 1 }], shipping: 'NL Pakket S', productionSpeed: 'Standard',
    invoice: kept, invoicingState: 'Included', cancellation: { status: 'None', accepted: null },
    ours: { from: null, status: 'no record in HQ', amount: null, currency: null }, reprintOf: null });
  assert.equal(note, 'Klant belde');                                          // (Print API's text: dropped)
  assert.deepEqual([firstSeen, lastChecked, (await listed()).synced], Array(3).fill(new Date(now).toISOString()));
  // an hour on: the status feed from the last good sync's start minus an hour
  await sync(now + 3600e3);
  assert.equal(Date.parse(pa.since[1]), now - 3600e3);
});

test("what a customer typed, and Print API's own words, never reach the table, the database file or the route", async () => {
  keyed();
  add({ id: 'bud-1', placed: Date.now() - DAY, status: 'Created', metadata: 'pebblet Oma Riekje secret-note Zwanenburgwal',
    items: [{ id: '1', productId: 'textielposter_30x40_sta', pageCount: 1, quantity: 2, title: 'Oma Riekje', metadata: 'secret-note',
      files: { content: { url: 'https://files.example/print/x.jpg' } }, options: [{ id: 'finish', value: 'matte' }, { id: 'note', value: 'Oma Riekje' }] }] });
  add({ id: 'bud-2', placed: Date.now() - 2 * DAY, status: 'Created', metadata: '{"product": "pebblet", "note": "Zwanenburgwal 12"}', cancellation: 'Accepted' });
  move('bud-2', 'Cancelled');
  await sync();
  pa.fail = 500;
  await sync(Date.now() + 2 * 3600e3);
  const o = await byId('bud-1');
  assert.equal(o.shop, 'pebblet');                                           // the first word, a product folder
  assert.deepEqual(o.items, [{ productId: 'textielposter_30x40_sta', quantity: 2, pageCount: 1, options: [{ id: 'finish', value: 'matte' }, { id: 'note', value: null }] }]);
  const route = JSON.stringify(await listed('all'));
  assert.match(route, /bud-1/);
  assert.deepEqual(planted(route), []);
  assert.deepEqual(planted(everything()), []);
});

test('a status change in sync/statuses re-reads the order and adds to its history; Accepted gets its Cancelled time', async () => {
  keyed();
  const t0 = Date.now();
  add({ id: 'ys-1', placed: t0 - 3 * DAY, status: 'Created', metadata: 'plankbook' });
  add({ id: 'ys-2', placed: t0 - 2 * DAY, status: 'Created', metadata: 'plankbook' });
  add({ id: 'ys-3', placed: t0 - DAY, status: 'Created', metadata: 'plankbook' });
  await sync(t0);
  move('ys-1', 'Processing', t0 + 10 * 60e3);
  pa.orders.get('ys-1')!.cancellation = 'Requested';
  await sync(t0 + 3600e3);
  let o = await byId('ys-1');
  assert.equal(o.status, 'Processing');
  assert.deepEqual(o.history.map((h: any) => h.status), ['Created', 'Processing']);
  assert.deepEqual(o.cancellation, { status: 'Requested', accepted: null });

  // Requested: its cancellation is asked again every hour
  pa.orders.get('ys-1')!.cancellation = 'Accepted';
  move('ys-1', 'Cancelled', t0 + 2 * 3600e3 - 60e3);
  await sync(t0 + 2 * 3600e3);
  o = await byId('ys-1');
  assert.deepEqual(o.history.map((h: any) => h.status), ['Created', 'Processing', 'Cancelled']);
  assert.deepEqual(o.cancellation, { status: 'Accepted', accepted: { at: dutch(t0 + 2 * 3600e3 - 60e3), from: "Print API's status history, Dutch time" } });

  // Accepted with no Cancelled in the history HQ has (older than the feed reaches): when HQ first saw it, and it says so
  pa.orders.get('ys-2')!.cancellation = 'Accepted';
  pa.orders.get('ys-2')!.status = 'Cancelled';                                // (the listing shows it moved, the feed doesn't)
  await sync(t0 + 3 * 3600e3);
  assert.deepEqual((await byId('ys-2')).cancellation, { status: 'Accepted', accepted: { at: new Date(t0 + 3 * 3600e3).toISOString(), from: 'when HQ first saw it, UTC' } });
});

test('the invoice is kept as first read (the price at placement); the daily re-read updates invoicingState, for the last 90 days', async () => {
  keyed();
  const t0 = Date.now();
  add({ id: 'ys-1', placed: t0 - DAY, status: 'Processing', metadata: 'plankbook', invoicingState: 'Excluded' });
  add({ id: 'ys-old', placed: t0 - 100 * DAY, status: 'Shipped', metadata: 'plankbook', invoicingState: 'Excluded' });
  await sync(t0);
  for (const id of ['ys-1', 'ys-old']) Object.assign(pa.orders.get(id)!, { invoice: invoice(9.99), invoicingState: 'Included' });
  await sync(t0 + 3600e3);
  assert.equal((await byId('ys-1')).invoicingState, 'Excluded');            // not daily yet
  await sync(t0 + DAY + 3600e3);
  assert.deepEqual([(await byId('ys-1')).invoicingState, (await byId('ys-old')).invoicingState], ['Included', 'Excluded']);
  assert.equal((await byId('ys-1')).invoice.production.cost, 2.95);
  assert.equal((await byId('ys-1')).invoice.total.taxes[0].amount, 1.65);
});

test('since: 90 days by default, a date, or all; anything else is refused, and the list is a job\'s', async () => {
  keyed();
  const now = Date.now();
  add({ id: 'a', placed: now - 5 * DAY, status: 'Shipped', metadata: '' });
  add({ id: 'b', placed: now - 40 * DAY, status: 'Shipped', metadata: '' });
  add({ id: 'c', placed: now - 120 * DAY, status: 'Shipped', metadata: '' });
  await sync(now);
  const ids = async (since?: string) => (await listed(since)).orders.map((o: any) => o.id);
  assert.deepEqual(await ids(), ['a', 'b']);
  assert.deepEqual(await ids('all'), ['a', 'b', 'c']);
  assert.deepEqual(await ids(dutch(now - 10 * DAY).slice(0, 10)), ['a']);
  assert.equal((await h.call('/api/agent/orders?since=2026-13', penny.token)).status, 400);
  assert.equal((await h.send('/api/agent/orders')).status, 401);
});

test('a 401 or a 500 is kept as the sync\'s error with its status code only; the next good sync clears it', async () => {
  keyed();
  const t0 = Date.now();
  add({ id: 'a', placed: t0 - DAY, status: 'Created', metadata: '' });
  await sync(t0);
  pa.fail = 401;
  await sync(t0 + 3600e3);
  let l = await listed();
  assert.equal(l.error, `Print API answered 401, failing since ${new Date(t0 + 3600e3).toISOString()}`);
  assert.equal(l.synced, new Date(t0).toISOString());
  pa.fail = 500;
  await sync(t0 + 2 * 3600e3);
  l = await listed();
  assert.equal(l.error, `Print API answered 500, failing since ${new Date(t0 + 3600e3).toISOString()}`);   // since the first failure
  assert.deepEqual(planted(everything()), []);
  pa.fail = 0;
  await sync(t0 + 3 * 3600e3);
  assert.equal((await listed()).error, null);
  // no answer at all
  const was = process.env.PRINTAPI_LIVE_API;
  process.env.PRINTAPI_LIVE_API = 'http://localhost:1/v2';
  await sync(t0 + 4 * 3600e3);
  process.env.PRINTAPI_LIVE_API = was;
  assert.match((await listed()).error, /^Print API didn't answer, failing since /);
});

test('a sync that stops partway: the next one lists to the end, so no order further down is left out', async () => {
  keyed();
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) add({ id: `ys-${i}`, placed: t0 - DAY - i * 3600e3, status: 'Created', metadata: 'plankbook' });
  pa.failRead = 'ys-50';                                                     // the 51st read fails: 50 kept
  await sync(t0);
  assert.equal((await listed('all')).orders.length, 50);
  assert.match((await listed()).error, /^Print API answered 500/);
  pa.failRead = '';
  await sync(t0 + 3600e3);                                                   // page 0 is all known, but the last sync stopped
  assert.equal((await listed('all')).orders.length, 60);
  assert.equal((await listed()).error, null);
});

test("a Requested cancellation on an order Print API no longer shows doesn't stop the sync", async () => {
  keyed();
  const t0 = Date.now();
  add({ id: 'gone', placed: t0 - DAY, status: 'Created', metadata: '', cancellation: 'Requested' });
  add({ id: 'kept', placed: t0 - 2 * DAY, status: 'Created', metadata: '' });
  await sync(t0);
  assert.equal((await byId('gone')).cancellation.status, 'Requested');
  pa.orders.delete('gone');
  await sync(t0 + 3600e3);
  const l = await listed();
  assert.equal(l.error, null);
  assert.equal(l.synced, new Date(t0 + 3600e3).toISOString());
});

test("a cancellation that fails to read leaves the order due: the next sync reads it again, even past the status feed's window", async () => {
  keyed();
  const t0 = Date.now();
  add({ id: 'bud-old', placed: t0 - 200 * DAY, status: 'Created', metadata: 'pebblet' });   // past the daily re-read's 90 days
  await sync(t0);
  const o = pa.orders.get('bud-old')!;
  o.status = 'Cancelled'; o.cancellation = 'Accepted';                        // not in sync/statuses: outside its window
  pa.failCancel = 'bud-old';
  await sync(t0 + 3600e3);
  let got = await byId('bud-old');
  assert.deepEqual([got.status, got.cancellation.status], ['Created', 'None']);
  assert.match((await listed()).error, /^Print API answered 503/);
  pa.failCancel = '';
  await sync(t0 + 2 * 3600e3);
  got = await byId('bud-old');
  assert.deepEqual([got.status, got.cancellation.status], ['Cancelled', 'Accepted']);
  assert.equal((await listed()).error, null);
});

test("the job that reads hq orders holds customer data: an order's id opens it on the product's site", async () => {
  const job = await h.start({ agent: 'penny' });
  assert.equal(jobs.holdsCustomerData(job.id), false);
  assert.equal((await h.call('/api/agent/orders', job.token)).status, 200);
  assert.equal(jobs.holdsCustomerData(job.id), true);
  await h.finish(job);
});

// a company's own tool that places live orders answers for its own ids
const sample = { status: 'waiting', price: null as number | null };
ownOrders.registerOrders(id => id === 'pf-sample-1' ? { shop: 'pebbleford', ours: { from: 'sample run', status: sample.status, amount: sample.price, currency: 'eur' } } : null);
ownOrders.registerOrders(id => id.startsWith('pf-') ? { shop: 'other', ours: { from: 'a second tool', status: 'x', amount: null, currency: null } } : null);

test('HQ\'s own payment and a company tool\'s order give "ours" and the shop; otherwise "no record in HQ"', async () => {
  keyed();
  const now = Date.now();
  add({ id: 'ys-paid', placed: now - DAY, status: 'Processing', metadata: '' });
  add({ id: 'pf-sample-1', placed: now - DAY, status: 'Created', metadata: '' });
  add({ id: 'pf-other-2', placed: now - DAY, status: 'Created', metadata: '' });
  add({ id: 'manual-77', placed: now - DAY, status: 'Created', metadata: 'greetings world' });
  // (live payments as Stripe's checkouts leave them: a live one needs live Stripe, which no test has)
  const pay = db.prepare("insert into payments (id, created, product, mode, reference, amount, currency, status, updated) values (?, 'x', ?, ?, ?, ?, 'eur', ?, 'x')");
  pay.run('cs_live_1', 'plankbook', 'live', 'ys-paid', 2450, 'expired');
  pay.run('cs_live_2', 'plankbook', 'live', 'ys-paid', 2450, 'paid');
  pay.run('cs_test_3', 'tidepool', 'test', 'manual-77', 1000, 'paid');      // a test payment isn't ours
  Object.assign(sample, { status: 'placed', price: 32.37 });     // the tool's own record, read when the list is
  await sync(now);
  const o = async (id: string) => { const x = await byId(id); return [x.shop, x.ours]; };
  assert.deepEqual(await o('ys-paid'), ['plankbook', { from: 'payment', status: 'paid', amount: 24.5, currency: 'eur' }]);
  assert.deepEqual(await o('pf-sample-1'), ['pebbleford', { from: 'sample run', status: 'placed', amount: 32.37, currency: 'eur' }]);
  assert.equal((await o('pf-other-2'))[1].from, 'a second tool');      // each tool answers for its own ids, the first that does wins
  assert.deepEqual(await o('manual-77'), [null, { from: null, status: 'no record in HQ', amount: null, currency: null }]);
});

test('reprintOf comes only from JSON metadata with that key and a plain id', async () => {
  keyed();
  const now = Date.now();
  add({ id: 'r1', placed: now - DAY, status: 'Created', metadata: '{"product": "tidepool", "reprintOf": "iou-123_ab"}' });
  add({ id: 'r2', placed: now - DAY, status: 'Created', metadata: 'tidepool reprintOf: iou-123' });
  add({ id: 'r3', placed: now - DAY, status: 'Created', metadata: '{"product": "nosuchshop", "reprintOf": "iou 123 Zwanenburgwal"}' });
  add({ id: 'r4', placed: now - DAY, status: 'Created', metadata: '{"reprintOf": ["iou-1"]}' });
  await sync(now);
  const got = Object.fromEntries((await listed('all')).orders.map((o: any) => [o.id, [o.shop, o.reprintOf]]));
  assert.deepEqual(['r1', 'r2', 'r3', 'r4'].map(id => got[id]), [['tidepool', 'iou-123_ab'], ['tidepool', null], [null, null], [null, null]]);
});

test('the check syncs at most hourly, across restarts too (the last try is a setting)', async () => {
  keyed();
  add({ id: 'a', placed: Date.now() - DAY, status: 'Created', metadata: '' });
  const t0 = Date.now(), at = (t: number) => new Date(t).toISOString();
  await sync(t0);
  await sync(t0 + 59 * 60e3);
  assert.equal((await listed()).synced, at(t0));
  await sync(t0 + 61 * 60e3);
  assert.equal((await listed()).synced, at(t0 + 61 * 60e3));
});
