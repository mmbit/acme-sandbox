// node --test src/history.test.ts   (uses a throwaway DATA_DIR; Stripe is the imitation, the email service a local stand-in)
// The shop's order history: the payer's hash, the code and its token, the list, each line's number, kept lines, and the
// records' end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { fakeLettermint, productHeaders } from './fixture.ts';

// The email service: it refuses the addresses in refusing
const lettermint = await fakeLettermint(),
  { taken, received } = lettermint,
  refusing = new Set<string>();
lettermint.answer = mail => (refusing.has(mail.to[0]) ? 'refuse:to.0' : 'take');

const words = (lang: string, subject: string) => `${lang}:
  subject: "${subject}"
  body: |
    {code}

    It works for {minutes} minutes.
`;
const h = await harness('history', {
  env: { PUBLIC_HOST: 'hq.example.test' },
  before: repo => {
    for (const [slug, name] of [
      ['pinwheel', 'Pinwheel'],
      ['hello', 'Hello Mug'],
    ]) {
      mkdirSync(`${repo}/products/${slug}`, { recursive: true });
      writeFileSync(`${repo}/products/${slug}/product.yaml`, `name: ${name}\nstatus: preview\n`);
    }
    mkdirSync(`${repo}/products/front/care`, { recursive: true });
    writeFileSync(
      `${repo}/products/front/product.yaml`,
      `name: The Stalls\nstatus: preview\nbasket:
  countries: [NL, BE, DE]\n  postage_saved: {NL: 400, BE: 400, DE: 400}\n  kept_years: {NL: 7, DE: 10}\n`,
    );
    writeFileSync(`${repo}/products/front/care/history-email.yaml`, words('en', 'Your code') + words('nl', 'Je code'));
  },
});
lettermint.on();
const payments = await import('./payments.ts');
const history = await import('./history.ts');
const records = await import('./records.ts');
const { db } = h;

const as = await productHeaders();
const call = (path: string, headers: Record<string, string>, body?: unknown, type = 'application/json') =>
  h.send(path, body === undefined ? headers : { ...headers, 'content-type': type }, body);
const front = (path: string, body?: unknown) => call(path, as('front'), body);

// A basket of two stalls' lines (the first with its order number), paid on the imitation's page and seen paid by the
// shop. Returns its session and lines.
let orders = 0;
async function paidBasket(email: string, country = 'NL') {
  const lines: { line: string; claim: string }[] = [];
  for (const [slug, number] of [
    ['pinwheel', `1000${++orders}`],
    ['hello', null],
  ] as const) {
    const ref = `${slug}-${orders}`;
    const l = await call('/api/pay/line', as(slug), {
      reference: ref,
      amount: 2995,
      description: 'Textile poster',
      detail: 'For Mila',
      order_url: `https://${slug}.preview.example.test/order/${ref}`,
      ...(number ? { number } : {}),
    });
    assert.equal(l.status, 200, l.text);
    lines.push(l.json);
  }
  let basket: string | undefined;
  for (const l of lines)
    basket = (await front('/api/pay/basket/add', { ...(basket ? { basket } : {}), line: l.line, claim: l.claim })).json
      .basket;
  const c = await front('/api/pay/basket/checkout', {
    basket,
    email,
    locale: 'nl',
    deliver_to: { name: 'Ada Lovelace', line1: 'Keizersgracht 1', postCode: '1015 AA', city: 'Amsterdam', country },
    success_url: 'https://front.preview.example.test/done/?session={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://front.preview.example.test/basket/',
  });
  assert.equal(c.status, 200, c.text);
  const p = await call(
    `${new URL(c.json.url).pathname}/pay`,
    { origin: 'https://hq.example.test' },
    '',
    'application/x-www-form-urlencoded',
  );
  assert.equal(p.status, 303, p.text);
  assert.equal((await front(`/api/pay/basket/order?id=${c.json.id}`)).json.paid, true);
  return { session: c.json.id as string, lines: lines.map(l => l.line) };
}
const mailsTo = (to: string) => taken.filter(m => m.to[0] === to);
async function codeSentTo(to: string, n: number) {
  for (let i = 0; i < 50 && mailsTo(to).length < n; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(mailsTo(to).length, n, `email ${n} to ${to}`);
  return mailsTo(to)
    .at(-1)
    .text.match(/^(\d{6})$/m)[1] as string;
}
async function signIn(email: string, n = 1) {
  assert.deepEqual((await front('/api/pay/history/code', { email, lang: 'nl' })).json, { ok: true });
  const code = await codeSentTo(email, n);
  const checked = await front('/api/pay/history/check', { email, code });
  assert.equal(checked.status, 200, checked.text);
  return checked.json.token as string;
}
const list = (token: string) => front(`/api/pay/history?token=${encodeURIComponent(token)}`);
const DAY_MS = 864e5;

test('an address with paid baskets gets a code by email, and its token lists them newest first, without its email or address', async () => {
  const first = await paidBasket('Ada@Example.nl'),
    second = await paidBasket('ada@example.nl ');
  const token = await signIn('ada@example.nl');
  assert.equal(mailsTo('ada@example.nl')[0].subject, 'Je code');
  assert.match(mailsTo('ada@example.nl')[0].text, /10 minutes/);
  const shown = await list(token);
  assert.equal(shown.status, 200, shown.text);
  assert.deepEqual(
    shown.json.orders.map((o: any) => o.session),
    [second.session, first.session],
  );
  const order = shown.json.orders[1];
  assert.equal(order.country, 'NL');
  assert.equal(order.refunded, false);
  assert.equal(order.total, 2995 + 2995 - 400);
  assert.deepEqual(
    order.lines.map((l: any) => [l.line, l.shop, l.number, l.amount, l.description, l.detail, l.kept_until]),
    [
      [first.lines[0], 'Pinwheel', `1000${orders - 1}`, 2995, 'Textile poster', 'For Mila', null],
      [first.lines[1], 'Hello Mug', null, 2595, 'Textile poster', 'For Mila', null],
    ],
  );
  assert.match(order.lines[0].order_url, /^https:\/\/pinwheel\.preview\.example\.test\/order\//);
  assert.doesNotMatch(shown.text, /ada@|Keizersgracht|Lovelace/i);
});

test("one order by its number and its email link's key, without signing in: the same 404 for anything wrong", async () => {
  const { session, lines } = await paidBasket('quinn@example.nl');
  const number = payments.orderNumber(session)!;
  assert.match(number, /^\d{7}$/, 'a paid basket has its 7-digit number');
  const key = history.orderKey(session);
  assert.match(key, /^[A-Za-z0-9_-]{16}$/);
  const one = (n: string, k: string) =>
    front(`/api/pay/history/order?number=${encodeURIComponent(n)}&key=${encodeURIComponent(k)}&lang=nl`);
  const shown = await one(`${number.slice(0, 3)} ${number.slice(3)}`, key);
  assert.equal(shown.status, 200, shown.text);
  assert.equal(shown.json.order.session, session);
  assert.equal(shown.json.order.number, number);
  assert.deepEqual(
    shown.json.order.lines.map((l: any) => l.line),
    lines,
  );
  assert.doesNotMatch(shown.text, /quinn@|Keizersgracht|Lovelace/i);
  const flipped = key[0] === 'A' ? `B${key.slice(1)}` : `A${key.slice(1)}`;
  const wrongDigit = number.slice(0, 6) + String((Number(number[6]) + 1) % 10);
  for (const [n, k] of [
    [number, flipped],
    [number, key.slice(0, 15)],
    [wrongDigit, key],
    [number, ''],
  ]) {
    const r = await one(n, k);
    assert.equal(r.status, 404, `${n} ${k}`);
    assert.equal(r.json.why, 'no_order');
  }
  assert.equal(
    (await call(`/api/pay/history/order?number=${number}&key=${key}`, as('pinwheel'))).status,
    403,
    "the shop's only",
  );
  // the list carries the number too
  const listed = await list(await signIn('quinn@example.nl'));
  assert.equal(listed.json.orders[0].number, number);
});

test('a basket paid before order numbers gets one as HQ starts, and keeps it after', async () => {
  const { session } = await paidBasket('pat@example.nl');
  assert.match(payments.orderNumber(session) ?? '', /^\d{7}$/, 'given as it was paid');
  db.prepare('update payments set number = null where id = ?').run(session);
  // HQ started again: the same database, the module fresh in memory
  // @ts-expect-error the query makes a fresh copy of the module, a path TypeScript can't resolve
  const restarted: typeof payments = await import('./payments.ts?numbers');
  const given = restarted.orderNumber(session);
  assert.match(given ?? '', /^\d{7}$/);
  // @ts-expect-error (as above)
  await import('./payments.ts?numbers-again');
  assert.equal(payments.orderNumber(session), given, 'given once');
});

test("an address without paid baskets gets the same answer and no email, and a code typed for it doesn't open anything", async () => {
  const before = taken.length;
  const asked = await front('/api/pay/history/code', { email: 'nobody@example.nl', lang: 'en' });
  assert.deepEqual([asked.status, asked.json], [200, { ok: true }]);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(taken.length, before);
  const checked = await front('/api/pay/history/check', { email: 'nobody@example.nl', code: '123456' });
  assert.deepEqual([checked.status, checked.json.why], [401, 'wrong']);
});

test('three codes an hour per address, with or without orders; only the newest counts, for five tries', async () => {
  await paidBasket('noor@example.de', 'DE');
  for (const email of ['noor@example.de', 'none@example.de']) {
    for (let i = 0; i < 3; i++) assert.equal((await front('/api/pay/history/code', { email })).status, 200);
    const refused = await front('/api/pay/history/code', { email });
    assert.deepEqual([refused.status, refused.json.why], [429, 'toomany']);
  }
  const newest = await codeSentTo('noor@example.de', 3),
    first = mailsTo('noor@example.de')[0].text.match(/^(\d{6})$/m)[1];
  const check = async (code: string) =>
    (await front('/api/pay/history/check', { email: 'noor@example.de', code })).json.why;
  let tries = 0;
  if (first !== newest) {
    assert.equal(await check(first), 'wrong');
    tries++;
  }
  const wrong = newest === '000000' ? '000001' : '000000';
  for (; tries < 4; tries++) assert.equal(await check(wrong), 'wrong');
  assert.equal(await check(wrong), 'spent', 'the fifth try spends it');
  assert.equal(await check(newest), 'spent', 'the right one too, after that');
});

test('a code the email service refused still counts, so the limit answers the same with or without orders', async () => {
  await paidBasket('sem@example.nl');
  refusing.add('sem@example.nl');
  const answers = async (email: string) => {
    const got = [];
    for (let i = 0; i < 4; i++) {
      const r = await front('/api/pay/history/code', { email });
      got.push([r.status, r.json.why ?? 'ok']);
    }
    return got;
  };
  const withOrders = await answers('sem@example.nl');
  const refused = () => received.filter(m => refusing.has(m.to[0]));
  for (let i = 0; i < 50 && refused().length < 3; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(refused().length, 3, 'three sends refused');
  assert.deepEqual(withOrders, await answers('nobody-sem@example.nl'));
  assert.deepEqual(withOrders.at(-1), [429, 'toomany']);
  const checked = await front('/api/pay/history/check', { email: 'sem@example.nl', code: '123456' });
  assert.equal(
    checked.json.why,
    (await front('/api/pay/history/check', { email: 'nobody-sem@example.nl', code: '123456' })).json.why,
  );
});

test("the history is the shop's alone, and a token only opens its own mode for an hour", async () => {
  await paidBasket('mila@example.be', 'BE');
  const token = await signIn('mila@example.be');
  for (const path of ['/api/pay/history/code', '/api/pay/history/check'])
    assert.equal((await call(path, as('pinwheel'), { email: 'mila@example.be' })).status, 403);
  assert.equal((await call(`/api/pay/history?token=${token}`, as('pinwheel'))).status, 403);
  assert.equal(
    (await call(`/api/pay/history?token=${token}`, as('front', 'live'))).status,
    403,
    'live needs its launch approval',
  );
  const forged = `${token.split('.')[0]}.${'A'.repeat(43)}`;
  assert.equal((await list(forged)).json.why, 'invalid');
  const now = Date.now;
  Date.now = () => now() + 61 * 60_000;
  try {
    const late = await list(token);
    assert.deepEqual([late.status, late.json.why], [401, 'expired']);
  } finally {
    Date.now = now;
  }
});

test("a line's order number is set once, with the line or after it", async () => {
  const { lines } = await paidBasket('sam@example.nl');
  const set = await call('/api/pay/line/number', as('hello'), { id: lines[1], number: '20000001' });
  assert.deepEqual(set.json, { line: lines[1], number: '20000001' });
  assert.equal(
    (await call('/api/pay/line/number', as('hello'), { id: lines[1], number: '20000001' })).status,
    200,
    'the same again',
  );
  const other = await call('/api/pay/line/number', as('hello'), { id: lines[1], number: '20000002' });
  assert.deepEqual([other.status, other.json.why], [409, 'number_set']);
  assert.equal(
    (await call('/api/pay/line/number', as('pinwheel'), { id: lines[1], number: '1' })).status,
    404,
    "another stall's line",
  );
  const token = await signIn('sam@example.nl');
  assert.deepEqual(
    (await list(token)).json.orders[0].lines.map((l: any) => l.number),
    [`1000${orders}`, '20000001'],
  );
});

test('a kept line keeps its words past the 90 days until its time, and a deletion asked ends the keeping', async () => {
  const { lines } = await paidBasket('kim@example.nl');
  const until = new Date(Date.now() + 200 * DAY_MS).toISOString();
  const kept = await call('/api/pay/line/keep', as('pinwheel'), { id: lines[0], until });
  assert.deepEqual(kept.json, { line: lines[0], kept_until: until });
  await payments.tick(Date.now() + 100 * DAY_MS);
  const words = (id: string) =>
    db.prepare('select description, order_url, kept_until from pay_lines where id = ?').get(id) as any;
  assert.equal(words(lines[0]).description, 'Textile poster');
  assert.equal(words(lines[1]).description, '', 'the line nobody kept goes');
  const gone = await call('/api/pay/line/keep', as('hello'), { id: lines[1], until });
  assert.deepEqual([gone.status, gone.json.why], [409, 'gone']);
  await payments.tick(Date.now() + 201 * DAY_MS);
  assert.equal(words(lines[0]).description, '', 'its time passed');

  const again = await paidBasket('kim@example.nl');
  await call('/api/pay/line/keep', as('pinwheel'), { id: again.lines[0], until });
  assert.equal((await call('/api/pay/line/forget', as('pinwheel'), { id: again.lines[0] })).status, 200);
  assert.equal(words(again.lines[0]).kept_until, null);
  const token = await signIn('kim@example.nl');
  assert.equal(
    (await list(token)).json.orders.length,
    1,
    'a basket whose customer asked us to delete their details is no longer found by the email',
  );
});

test("a paid basket's records end 7 years after the end of its year, 10 for Germany, with its parcel and email marks", async () => {
  const dutch = await paidBasket('end@example.nl', 'NL'),
    german = await paidBasket('end@example.de', 'DE');
  const year = new Date().getUTCFullYear();
  const has = (session: string) => !!db.prepare('select 1 from payments where id = ?').get(session);
  const lineCount = (session: string) =>
    (db.prepare('select count(*) n from pay_lines where session = ?').get(session) as any).n;
  records.endRecords(Date.parse(`${year + 7}-12-31T12:00:00Z`));
  assert.ok(has(dutch.session) && lineCount(dutch.session) === 2, 'kept through the 7th year after');
  records.endRecords(Date.parse(`${year + 8}-01-01T12:00:00Z`));
  assert.ok(!has(dutch.session));
  assert.equal(lineCount(dutch.session), 0);
  assert.ok(!db.prepare('select 1 from parcels where session = ?').get(dutch.session));
  assert.ok(!db.prepare('select 1 from session_lines where session = ?').get(dutch.session));
  assert.ok(!db.prepare('select 1 from basket_emails where session = ?').get(dutch.session));
  assert.ok(has(german.session));
  records.endRecords(Date.parse(`${year + 11}-01-01T12:00:00Z`));
  assert.ok(!has(german.session));
});
