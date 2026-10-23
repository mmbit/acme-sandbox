// node --test src/testorder.test.ts
// The shop's test code: a basket holding it checks out for nothing on the live shop, and nothing is paid, printed, mailed
// or counted because of it. (No Stripe key at all, and a local server plays both of Print API's environments.)
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { harness } from './harness.ts';
import { productHeaders } from './fixture.ts';

// Print API and Stripe, which leave the machine in life: whatever reaches them is kept
const reached: string[] = [];
const standIn = (status: number, body: string) =>
  createServer((q, s) => {
    reached.push(`${q.method} ${q.url}`);
    q.resume();
    s.writeHead(status);
    s.end(body);
  }).listen(0);
const printapi = standIn(200, JSON.stringify({ access_token: 'tok', expires_in: 14400 })),
  stripe = standIn(500, '{}');
await Promise.all([printapi, stripe].map(s => new Promise(r => s.once('listening', r))));
const at = (s: typeof stripe) => `http://localhost:${(s.address() as any).port}`;
after(() => {
  printapi.close();
  stripe.close();
});

const CODE = 'Board2026Test';
const h = await harness('testorder', {
  env: {
    PUBLIC_HOST: 'hq.company.test',
    PRINTAPI_TEST_API: `${at(printapi)}/test`,
    PRINTAPI_LIVE_API: `${at(printapi)}/live`,
    STRIPE_API: at(stripe),
  },
  before: repo => {
    const manifest = (slug: string, yaml: string) => {
      mkdirSync(`${repo}/products/${slug}`, { recursive: true });
      writeFileSync(`${repo}/products/${slug}/product.yaml`, yaml);
    };
    manifest(
      'front',
      'name: The shop\nstatus: live\nbasket:\n  countries: [NL, BE]\n  postage_saved: {NL: 400, BE: 400}\n' +
        'codes:\n  months: 3\n  words: words.txt\n  card: true\n  order: {off: 500, minimum: 3000}\n  thanks: {off: 500, minimum: 3000}\n',
    );
    writeFileSync(
      `${repo}/products/front/words.txt`,
      Array.from(
        { length: 120 },
        (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`,
      ).join('\n'),
    );
    manifest('pebblet', 'name: Pebblet\nstatus: live\n');
    manifest('hello', 'name: Hello\nstatus: live\n');
    mkdirSync(process.env.SECRETS_DIR!, { recursive: true });
    // keys for both of Print API's environments, so a call that slipped through would reach the stand-in, not stop at "no keys"
    for (const mode of ['TEST', 'LIVE'])
      for (const k of ['CLIENT_ID', 'CLIENT_SECRET'])
        writeFileSync(`${process.env.SECRETS_DIR}/PRINTAPI_${mode}_${k}`, `${mode}-${k}`);
  },
});
const { db, send: call } = h;
const saveCode = (code: string | null) =>
  code === null
    ? rmSync(`${process.env.SECRETS_DIR}/SHOP_TEST_CODE`, { force: true })
    : writeFileSync(`${process.env.SECRETS_DIR}/SHOP_TEST_CODE`, code);
saveCode(CODE);

const payments = await import('./payments.ts');
const codes = await import('./codes.ts');
const parcels = await import('./parcels.ts');
const basketmail = await import('./basketmail.ts');
const approvals = await import('./approvals.ts');
for (const slug of ['front', 'pebblet', 'hello']) approvals.record(`live:${slug}`, 1);

const as = await productHeaders();
let n = 0;
async function basket(mode = 'live', slugs = ['pebblet', 'hello']) {
  let id: string | undefined;
  const lines = [];
  for (const slug of slugs) {
    const reference = `${slug}-${++n}`;
    const l = await call('/api/pay/line', as(slug, mode), {
      reference,
      amount: 3995,
      description: `${slug} poster`,
      detail: 'For Mila',
      order_url: `https://www.company.test/${slug}/order/${reference}`,
    });
    assert.equal(l.status, 200, l.text);
    const added = await call('/api/pay/basket/add', as('front', mode), {
      basket: id,
      line: l.json.line,
      claim: l.json.claim,
    });
    assert.equal(added.status, 200, added.text);
    id = added.json.basket;
    lines.push({ slug, reference, line: l.json.line as string });
  }
  return { id: id!, lines };
}
const enter = (b: string, code: string, mode = 'live') =>
  call('/api/pay/basket/code', as('front', mode), { basket: b, code, country: 'NL' });
const view = async (b: string, mode = 'live') =>
  (await call(`/api/pay/basket?id=${b}&country=NL`, as('front', mode))).json;
const checkout = (b: string, mode = 'live', over: Record<string, unknown> = {}) =>
  call('/api/pay/basket/checkout', as('front', mode), {
    basket: b,
    deliver_to: { name: 'Sanne de Vries', line1: 'Lindelaan 12', postCode: '1234 AB', city: 'Utrecht', country: 'NL' },
    email: 'sanne@example.com',
    locale: 'nl',
    success_url: 'https://www.company.test/nl/klaar/?session={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://www.company.test/nl/afrekenen/',
    ...over,
  });

test('the live shop: a basket with the test code checks out for nothing, and nothing is paid, printed, mailed or counted', async () => {
  const b = await basket();
  const before = await view(b.id);
  assert.equal(before.total, 7590, 'two posters, the €4 postage once taken off one');
  const marked = await enter(b.id, ' board-2026 test '); // typed in any case, with spaces and dashes
  assert.equal(marked.status, 200, marked.text);
  assert.equal(marked.json.test, true);
  assert.equal(marked.json.code, null, 'the test code is never shown back as a code');
  // the page a customer's basket gets: its prices and ship day as a real order's
  assert.equal(marked.json.total, before.total);
  assert.equal(marked.json.ship_by, before.ship_by);
  assert.deepEqual(
    marked.json.lines.map((l: any) => [l.card, l.saved, l.ship_by]),
    before.lines.map((l: any) => [l.card, l.saved, l.ship_by]),
  );
  assert.notEqual(marked.json.revision, before.revision);

  const paid = await checkout(b.id, 'live', { revision: marked.json.revision });
  assert.equal(paid.status, 200, paid.text);
  assert.match(paid.json.id, /^cs_live_test_[a-f0-9]{24}$/);
  assert.equal(
    paid.json.url,
    `https://www.company.test/nl/klaar/?session=${paid.json.id}`,
    'straight to the order page',
  );

  // the order page: through, a test, its lines as they were, without their stalls' order pages (a cancelled line's says
  // it's no longer in the basket)
  const order = await call(`/api/pay/basket/order?id=${paid.json.id}`, as('front', 'live'));
  assert.equal(order.status, 200, order.text);
  assert.equal(order.json.paid, true);
  assert.equal(order.json.test, true);
  assert.equal(order.json.total, before.total, "what a real order's page says it paid; the session charged nothing");
  assert.ok(order.json.ship_by);
  assert.deepEqual(
    order.json.lines.map((l: any) => [l.description, l.detail, l.card, l.order_url]),
    [
      ['pebblet poster', 'For Mila', before.lines[0].card, null],
      ['hello poster', 'For Mila', before.lines[1].card, null],
    ],
  );
  const closed = await view(b.id);
  assert.equal(closed.status, 'paid', 'the basket is closed: the next thing starts a new one');
  assert.deepEqual(closed.dropped, [], 'its lines went through, so the basket never says they were cancelled');
  assert.deepEqual(
    closed.lines.map((l: any) => l.order_url),
    [null, null],
  );
  assert.equal(codes.codeOf(paid.json.id, 'order'), null, 'no code of its own');
  // a week later, past many a cut-off, the same order says the same ship day, as a real order's fixed paid day does
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 7 * 864e5 });
  try {
    const again = await call(`/api/pay/basket/order?id=${paid.json.id}`, as('front', 'live'));
    assert.equal(again.json.ship_by, order.json.ship_by);
    assert.deepEqual(
      again.json.lines.map((l: any) => l.ship_by),
      order.json.lines.map((l: any) => l.ship_by),
    );
    assert.equal((await view(b.id)).ship_by, order.json.ship_by);
  } finally {
    mock.timers.reset();
  }

  // no product holds a paid line: each is cancelled, as a stall's unpaid order is, so its product lets it go
  for (const l of b.lines) {
    const seen = await call(`/api/pay/line?id=${l.line}`, as(l.slug, 'live'));
    assert.equal(seen.json.status, 'cancelled');
    assert.equal(seen.json.deliver_to, null);
    assert.equal(seen.json.email, null);
    const handed = await call('/api/pay/parcel/items', as(l.slug, 'live'), {
      line: l.line,
      items: [{ productId: 'poster_a3', quantity: 1 }],
    });
    assert.equal(handed.status, 409, 'nothing to hand over: no parcel');
    const mailed = await call('/api/pay/email', as(l.slug, 'live'), {
      order: l.reference,
      kind: 'shipped',
      lang: 'nl',
      slots: { ref: '12345678' },
    });
    assert.notEqual(mailed.status, 200, 'no order email for it');
    const refund = await call('/api/pay/line/refund', as(l.slug, 'live'), { id: l.line });
    assert.notEqual(refund.status, 200, 'nothing to refund');
  }
  // HQ's own rounds: nothing placed or mailed (the rows HQ's shop pages show), no address or email kept
  await payments.tick();
  await parcels.tick();
  await basketmail.sweep();
  const count = (table: string) => (db.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;
  assert.deepEqual([count('parcels'), count('basket_emails')], [0, 0]);
  const row = db.prepare('select * from payments where id = ?').get(paid.json.id) as any;
  assert.deepEqual([row.status, row.amount, row.payer, row.deliver], ['test', 0, null, null]);
  assert.deepEqual(reached, [], 'neither Print API nor Stripe ever heard of it');

  // a day later the lines' words go too
  await payments.tick(Date.now() + 25 * 3600e3);
  const words = db
    .prepare(`select description, detail, order_url from pay_lines where id in (${b.lines.map(() => '?').join(',')})`)
    .all(...b.lines.map(l => l.line))
    .map(w => ({ ...w }));
  assert.deepEqual(words, [
    { description: '', detail: null, order_url: null },
    { description: '', detail: null, order_url: null },
  ]);
});

test('without the test code a live basket still goes to Stripe, which the live shop has no key for', async () => {
  const b = await basket('live', ['pebblet']);
  const r = await checkout(b.id);
  assert.notEqual(r.status, 200, 'no live key: no payment at all, never a free order');
  assert.equal((await view(b.id)).status, 'open');
});

test('another code or removing it makes it a real order again; a wrong guess is a wrong code', async () => {
  const b = await basket('test', ['pebblet']);
  const before = await view(b.id, 'test');
  assert.equal((await enter(b.id, CODE, 'test')).json.test, true);
  const removed = await call('/api/pay/basket/code/remove', as('front', 'test'), { basket: b.id, country: 'NL' });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.json.test, false);
  assert.equal(removed.json.total, before.total);
  assert.equal(removed.json.revision, before.revision);
  // a page that showed the test order can't pay the real one, and the other way round
  const marked = await enter(b.id, CODE, 'test');
  assert.equal((await checkout(b.id, 'test', { revision: before.revision })).json.why, 'basket_changed');
  assert.equal(marked.json.test, true);

  // no key saved, or a key not of the shape: no test code at all
  const other = await basket('test', ['hello']);
  saveCode(null);
  assert.equal((await enter(other.id, CODE, 'test')).json.why, 'code_unknown');
  saveCode('short1');
  assert.equal((await enter(other.id, 'short1', 'test')).json.why, 'code_unknown');
  saveCode(CODE);
  // guesses count as wrong codes: ten in an hour, and the basket takes no code, the right one neither
  for (let i = 0; i < 8; i++)
    assert.equal((await enter(other.id, `GUESS${i}ABCDEFG`, 'test')).json.why, 'code_unknown');
  assert.equal((await enter(other.id, CODE, 'test')).status, 429);
  assert.equal((await view(other.id, 'test')).test, false);
});

test('ten test orders a day in a mode', async () => {
  for (let i = 0; i < 10; i++) {
    // (the live shop's one above counts for the live shop only)
    const b = await basket('test', ['pebblet']);
    assert.equal((await enter(b.id, CODE, 'test')).status, 200);
    assert.equal((await checkout(b.id, 'test')).status, 200);
  }
  const b = await basket('test', ['pebblet']);
  assert.equal((await enter(b.id, CODE, 'test')).status, 200);
  const r = await checkout(b.id, 'test');
  assert.equal(r.status, 429);
  assert.equal(r.json.why, 'test_limit');
  assert.equal((await view(b.id, 'test')).status, 'open', 'the basket stays as it was');
});

test("the board's key card takes a test code of 12 to 24 letters and digits, long enough to be masked", async () => {
  const job = await h.start({ agent: 'bolt' });
  const card = await h.ask(job, { kind: 'credential', secrets: 'SHOP_TEST_CODE' });
  for (const code of ['TEST 1', 'Pippin42Ln', 'Pippin42Lan'])
    assert.equal((await h.answer(card, '', { secrets: { SHOP_TEST_CODE: code } })).status, 400, code);
  assert.equal((await h.answer(card, '', { secrets: { SHOP_TEST_CODE: 'Pippin42Lantern' } })).status, 200);
  // the shop takes it typed any way, and nothing short of it
  const b = await basket('test', ['hello']);
  assert.equal((await enter(b.id, 'Pippin42Lanter', 'test')).json.why, 'code_unknown');
  assert.equal((await enter(b.id, 'pippin42-lantern', 'test')).json.test, true);
  saveCode(CODE);
});
