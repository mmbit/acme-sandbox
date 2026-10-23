// node --test src/gate.test.ts   (uses a throwaway DATA_DIR and a local server playing an app's order endpoint)
// What each level sees, no enumeration, the code and the signed link.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- the app: the shop's order endpoint, as the contract says (it normalises, compares, answers match or no match)
const TOKEN = 'test-care-token', SHELF_TOKEN = 'test-shelf-token';   // a shelf's
const view = (id: string) => ({
  id, ref: '1234', placed_at: '2026-09-30T10:00:00Z', title: 'Name mug', status: 'shipped',
  shipped_at: '2026-10-01T09:00:00Z', delivered_at: null, carrier: 'Royal Mail', tracking_url: 'https://royalmail.com/t/1',
  country: 'GB', total_cents: 4900, address_masked: '1 Test Street, Leeds',
  weight_grams: 3400,   // what an app must never send, and care must never pass on if one does
});
const ORDERS: Record<string, string> = {
  'ORD-1': 'mila@example.com', 'ORD-2': 'sam@example.com', 'ORD-3': 'ada@example.com', 'ORD-4': 'noor@example.com',
  'ORD-5': 'lev@example.com', 'ORD-6': 'ivo@example.com', 'ORD-7': 'mila@example.com', 'ORD-8': 'pia@example.com',
  'ORD-9': 'eli@example.com', 'ORD-I1': 'ida@example.com', 'ORD-10': 'tom@example.com', 'ORD-B1': 'bo@example.com',
  'ORD-B2': 'bo@example.com',
};
const BASKET = '4829172';
const app = createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d).on('end', () => {
    // an app on a shelf answers under its path only, as Caddy's handle_path hands it on (infra/products.py)
    const shelved = req.url!.startsWith('/shelf/'), path = shelved ? req.url!.slice('/shelf'.length) : req.url;
    if (req.headers.authorization !== `Bearer ${shelved ? SHELF_TOKEN : TOKEN}`) { res.writeHead(401).end(); return; }
    const b = JSON.parse(body);
    const answer = (o: object, ms: number) => setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o)), ms);
    if (path === '/api/care/match') {
      // the number with any separators, as a stall may read it
      const bare = String(b.order).toUpperCase().replace(/[^A-Z0-9]/g, ''), e = String(b.email).trim().toLowerCase();
      // a basket's number names two orders of its payer's
      if (bare === BASKET && e === 'bo@example.com') return answer({ match: true, order: view('ORD-B1'), orders: ['ORD-B1', 'ORD-B2'].map(id => ({ ...view(id), number: BASKET })) }, 5);
      const o = Object.keys(ORDERS).find(k => k.replace('-', '') === bare)!;
      // a real match is slower here on purpose, half the floor: the gate's floor must hide it
      return ORDERS[o] === e ? answer({ match: true, order: view(o) }, 300) : answer({ match: false }, 5);
    }
    if (path === '/api/care/orders') return answer({ orders: Object.keys(ORDERS).filter(k => ORDERS[k] === b.email).map(view) }, 5);
    res.writeHead(404).end();
  });
});
await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(app.address() as any).port}`;

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'care-gate-'));
// the shelf:
process.env.CARE_APPS = JSON.stringify({ shop: url, 'shop@preview': url, broken: url, shelf: `${url}/shelf/` });
process.env.CARE_TOKENS = JSON.stringify({ shop: TOKEN, 'shop@preview': TOKEN, broken: 'wrong-token', shelf: SHELF_TOKEN });
const gate = await import('./gate.ts');
const session = await import('./session.ts');
const apps = await import('./apps.ts');
const { db } = await import('./db.ts');
test.after(() => app.close());

const HOUR = 3_600_000;
let ips = 0;
const ip = () => `198.51.100.${++ips}`;   // a fresh caller, so one test's failures don't limit the next
// timed from before the call: matchOrder's floor counts from its own first line, which runs before any await
const timed = async <T>(f: () => Promise<T>) => { const t = performance.now(); const r = await f(); return { r, ms: performance.now() - t }; };
const matched = async (order: string, email: string, app = 'shop') => {
  const m = await gate.matchOrder(session.create(app).session, ip(), order, email);
  assert.ok(m.ok);
  return m.session;
};

test('each level sees only its own: nothing at 0, no price or address at 1, the full view at 2', async () => {
  const s0 = session.create('shop').session;
  assert.equal(session.level(s0), 0);
  assert.equal(gate.viewFor(0, view('ORD-1')), null);

  const m = await gate.matchOrder(s0, ip(), '  ord-1 ', ' Mila@Example.com');
  assert.ok(m.ok);
  assert.equal(session.level(m.session), 1);
  assert.deepEqual(m.session.orders, [{ app: 'shop', id: 'ORD-1' }]);
  // the contract's level-1 fields, and the app care asked
  assert.deepEqual(Object.keys(m.views[0]).sort(), ['app', 'carrier', 'country', 'delivered_at', 'id', 'number', 'placed_at', 'quantity', 'ref', 'ship_by', 'shipped_at', 'status', 'title', 'tracking_url']);

  const sent = gate.sendCode(m.session, ip());
  assert.ok(sent.ok);
  const c = gate.checkCode(m.session, sent.code);
  assert.ok(c.ok);
  assert.equal(session.level(c.session), 2);
  const all = await apps.orders('shop', c.session.email!);
  assert.deepEqual(all.map(o => o.id), ['ORD-1', 'ORD-7']);
  const full = gate.viewFor(2, all[0])!;
  assert.equal(full.total_cents, 4900);
  assert.equal(full.address_masked, '1 Test Street, Leeds');
  assert.equal('weight_grams' in full, false, 'only the contract\'s fields pass, whatever an app adds');
});

test("a basket's number grants each of its orders, which the order tools then find by id", async () => {
  const m = await gate.matchOrder(session.create('shop').session, ip(), '482 9172', 'bo@example.com');
  assert.ok(m.ok);
  assert.deepEqual(m.views.map(v => [v.id, v.number]), [['ORD-B1', BASKET], ['ORD-B2', BASKET]]);
  // each with the number, which a phone fault may be noted under
  assert.deepEqual(m.session.orders, [{ app: 'shop', id: 'ORD-B1', number: BASKET }, { app: 'shop', id: 'ORD-B2', number: BASKET }]);
  const second = await gate.find(m.session, 'ord-b2');
  assert.ok(second.ok && second.view.id === 'ORD-B2');
});

test("an app on a shelf is asked under its own path", async () => {
  const m = await apps.match('shelf', 'ORD-1', 'mila@example.com');
  assert.ok(m.match && m.order.id === 'ORD-1');
});

test('wrong email, wrong number and a real order give the same answer after the same minimum time', async () => {
  // four of each: a fifth failure on one order number would slow it down (the next test)
  const run = (order: string, email: string) => Promise.all(Array.from({ length: 4 }, () =>
    timed(() => gate.matchOrder(session.create('shop').session, ip(), order, email))));
  // beside them, a plain timer of the floor's length: a busy machine is as late with it as with the floor's own
  const [wrongEmail, wrongNumber, real, broken, plain] = await Promise.all([
    run('ORD-7', 'someone@example.com'), run('ORD-999', 'ada@example.com'), run('ORD-3', 'ada@example.com'),
    Promise.all([timed(() => gate.matchOrder(session.create('broken').session, ip(), 'ORD-3', 'ada@example.com'))]),
    timed(() => new Promise(r => setTimeout(r, 600))),
  ]);
  for (const x of [...wrongEmail, ...wrongNumber, ...broken]) assert.equal(JSON.stringify(x.r), '{"ok":false,"why":"no-match"}');
  for (const x of real) assert.equal(x.r.ok, true);
  const times = [...wrongEmail, ...wrongNumber, ...real, ...broken].map(x => x.ms);
  assert.ok(Math.min(...times) >= 595, `all at the floor or above: ${Math.min(...times)} ms`);
  const later = Math.max(...times) - plain.ms;
  assert.ok(later < 150, `the real order's slower lookup doesn't show: ${later} ms after the floor`);
});

test('failed matches are limited per IP, and a much-tried order slows down without locking its owner out', async () => {
  const from = ip();
  const tries = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    gate.matchOrder(session.create('shop').session, from, `ORD-X${i}`, 'nobody@example.com')));
  assert.equal(tries.filter(m => !m.ok && m.why === 'no-match').length, 10, 'ten failures an hour from one IP, even in parallel');
  assert.equal(tries.filter(m => !m.ok && m.why === 'limited').length, 2);

  // someone tries order ORD-4 with seven wrong emails from seven addresses; then its owner types it right
  await Promise.all(Array.from({ length: 7 }, (_, i) => gate.matchOrder(session.create('shop').session, ip(), 'ORD-4', `guess${i}@example.com`)));
  const owner = await timed(() => gate.matchOrder(session.create('shop').session, ip(), 'ord-4', 'noor@example.com'));
  assert.equal(owner.r.ok, true, 'never a lockout');
  assert.ok(owner.ms >= 4 * 600, `but slower: ${owner.ms} ms`);
});

test('an order number spelt with other separators keeps the slowdown its other spellings ran up', async () => {
  // an app that reads them all as ORD-9: five wrong emails, each under another spelling, from five addresses
  await Promise.all(['ORD-9', 'ORD 9', 'ORD-é9', 'ORD٣9', 'ORD_9'].map((order, i) =>
    gate.matchOrder(session.create('shop').session, ip(), order, `guess${i}@example.com`)));
  const owner = await timed(() => gate.matchOrder(session.create('shop').session, ip(), 'ORD.9', 'eli@example.com'));
  assert.equal(owner.r.ok, true);
  assert.ok(owner.ms >= 2 * 600, `a sixth spelling is as slow as the sixth try: ${owner.ms} ms`);
});

test('an order number spelt with a letter that upper-cases to the same, or padded past 60 characters, shares the count', async () => {
  // 'ı' is sent to the apps as 'I'; an app reads only the first 60 characters, so whatever follows the padding is the same order
  const fail = (order: string, i: number) => gate.matchOrder(session.create('shop').session, ip(), order, `guess${i}@example.com`);
  await Promise.all(Array.from({ length: 5 }, (_, i) => fail('ORD-ı1', i)));
  await Promise.all(Array.from({ length: 5 }, (_, i) => fail(`ORD-10${' '.repeat(60)}x${i}`, i)));
  const dotless = await timed(() => gate.matchOrder(session.create('shop').session, ip(), 'ORD-I1', 'ida@example.com'));
  const padded = await timed(() => gate.matchOrder(session.create('shop').session, ip(), 'ORD-10', 'tom@example.com'));
  assert.equal(dotless.r.ok, true);
  assert.equal(padded.r.ok, true);
  assert.ok(dotless.ms >= 2 * 600, `the dotted spelling is as slow as the sixth try: ${dotless.ms} ms`);
  assert.ok(padded.ms >= 2 * 600, `the unpadded number is as slow as the sixth try: ${padded.ms} ms`);
});

test('no code without a level-1 match, and a code works only in its own session', async () => {
  assert.deepEqual(gate.sendCode(session.create('shop').session, ip()), { ok: false, why: 'no-match' });
  const a = await matched('ORD-5', 'lev@example.com'), b = await matched('ORD-5', 'lev@example.com');
  const sent = gate.sendCode(a, ip());
  assert.ok(sent.ok);
  assert.equal(sent.to, 'lev@example.com');
  assert.match(sent.code, /^\d{6}$/);
  assert.equal(gate.checkCode(b, sent.code).ok, false, 'another session holding the same order');
  assert.equal(session.level(session.current(b)!), 1);
  // the code survives the rotation the next POST makes (it's usually the code's own POST)
  const rotated = session.rotate({ ...session.current(a)!, rotate: true })!;
  assert.equal(gate.checkCode(rotated.session, sent.code).ok, true);
});

test('the 6th try fails even with the right code; a code lasts 10 minutes; only the latest counts', async (t) => {
  t.after(() => mock.timers.reset());
  const s = await matched('ORD-6', 'ivo@example.com');
  const sent = gate.sendCode(s, ip());
  assert.ok(sent.ok);
  const wrong = sent.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal(gate.checkCode(s, wrong).ok, false);
  assert.deepEqual(gate.checkCode(s, sent.code), { ok: false, why: 'spent' });

  const older = gate.sendCode(s, ip()), latest = gate.sendCode(s, ip());
  assert.ok(older.ok && latest.ok);
  if (older.code !== latest.code) assert.equal(gate.checkCode(s, older.code).ok, false, 'an older code is dead once a new one is sent');
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  mock.timers.tick(10 * 60_000 + 1);
  assert.deepEqual(gate.checkCode(s, latest.code), { ok: false, why: 'spent' });
});

test('at most 3 codes an hour and 10 a day per email: the 11th of the day is refused', async (t) => {
  t.after(() => mock.timers.reset());
  const s = await matched('ORD-2', 'sam@example.com');
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const results: boolean[] = [];
  for (let hour = 0; hour < 4; hour++) {
    for (let i = 0; i < 4; i++) results.push(gate.sendCode(s, ip()).ok);
    mock.timers.tick(HOUR + 1);
  }
  // each hour: 3 sent, the 4th refused; the 4th hour reaches 10 after its first
  assert.deepEqual(results, [true, true, true, false, true, true, true, false, true, true, true, false, true, false, false, false]);
  mock.timers.tick(HOUR);
  assert.deepEqual(gate.sendCode(s, ip()), { ok: false, why: 'limited' }, 'the 11th of the day, in a fresh hour');
});

test('asking whether a code could go changes nothing; a code whose email failed is dropped, and the one before works again', async () => {
  const s = await matched('ORD-8', 'pia@example.com');
  const codes = () => (db.prepare("select count(*) as n from codes where email = 'pia@example.com'").get() as any).n;
  for (let i = 0; i < 5; i++) assert.deepEqual(gate.canSendCode(s, ip()), { ok: true, to: 'pia@example.com' });
  assert.equal(codes(), 0, 'asking made no code');
  const sent = [gate.sendCode(s, ip()), gate.sendCode(s, ip()), gate.sendCode(s, ip())];
  assert.ok(sent.every(x => x.ok), 'and counted none: all 3 of the hour were still there');
  assert.deepEqual(gate.canSendCode(s, ip()), { ok: false, why: 'limited' }, 'the 4th of the hour');
  const [, second, third] = sent as any[];
  gate.dropCode(third.id);        // its email never went
  assert.equal(gate.checkCode(s, second.code).ok, true, 'the code in their inbox is the latest again');
});

test('a signed link works once, on its own app, unexpired and unaltered', async (t) => {
  t.after(() => mock.timers.reset());
  const tok = gate.makeLink('shop', 'Mila@Example.com');
  const s = session.create('shop').session;

  const tampered = tok.slice(0, 5) + (tok[5] === 'A' ? 'B' : 'A') + tok.slice(6);
  assert.deepEqual(gate.redeemLink(s, 'shop', tampered), { ok: false, why: 'invalid' });
  assert.deepEqual(gate.redeemLink(session.create('shop@preview').session, 'shop@preview', tok), { ok: false, why: 'invalid' },
    'the preview twin is another app');

  const r = gate.redeemLink(s, 'shop', tok);
  assert.ok(r.ok);
  assert.equal(session.level(r.session), 2);
  assert.equal(r.session.email, 'mila@example.com');
  assert.equal(r.session.rotate, true);
  assert.deepEqual(gate.redeemLink(session.create('shop').session, 'shop', tok), { ok: false, why: 'used' });

  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const old = gate.makeLink('shop', 'sam@example.com', 30);   // asked for 30 days, held to 7
  mock.timers.tick(7 * 24 * HOUR + 1);
  assert.deepEqual(gate.redeemLink(session.create('shop').session, 'shop', old), { ok: false, why: 'expired' });
});
