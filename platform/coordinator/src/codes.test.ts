// node --test src/codes.test.ts
// The shop's codes: given after an order, taken off a later basket. Stripe is the imitation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { productHeaders } from './fixture.ts';

const manifest = (slug: string, yaml: string) => {
  mkdirSync(`${process.env.REPO_DIR}/products/${slug}`, { recursive: true });
  writeFileSync(`${process.env.REPO_DIR}/products/${slug}/product.yaml`, yaml);
};
const WORDS = ['otter', 'badger', 'maple', 'teapot', 'lantern', 'acorn', 'puffin', 'quilt', 'robin', 'walnut'];
// 100 words or more: these ten, then made-up ones that never look like them
const filler = Array.from(
  { length: 100 },
  (_, i) => `zz${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`,
);
const SHOP = `name: The shop\nstatus: preview\nbasket:\n  countries: [NL, BE]\n  postage_saved: {NL: 400, BE: 400}\n`;
const CODES =
  'codes:\n  months: 3\n  words: words.txt\n  card: false\n  order: {percent: 10}\n  thanks: {percent: 10}\n  flaw: {percent: 10}\n';
const h = await harness('codes', {
  env: { PUBLIC_HOST: 'hq.company.test' },
  before: repo => {
    manifest('front', SHOP + CODES);
    writeFileSync(
      `${repo}/products/front/words.txt`,
      ['# the words', ...WORDS, ...filler, 'not a word', 'x'].join('\n'),
    );
    manifest('pebblet', 'name: Pebblet\nstatus: preview\n');
    manifest('hello', 'name: Hello\nstatus: preview\n');
  },
});
const { db, send: call } = h;
const payments = await import('./payments.ts');
const codes = await import('./codes.ts');
const approvals = await import('./approvals.ts');

const as = await productHeaders();
const front = (mode = 'test') => as('front', mode);
let lineCount = 0;
const line = async (slug: string, over: Record<string, unknown> = {}, mode = 'test') => {
  const reference = `${slug}-${++lineCount}`;
  const r = await call('/api/pay/line', as(slug, mode), {
    reference,
    amount: 3995,
    description: `${slug} poster`,
    order_url: `https://${slug}.preview.company.test/order/${reference}`,
    ...over,
  });
  assert.equal(r.status, 200, r.text);
  return { ...r.json, reference };
};
async function basketOf(lines: { line: string; claim: string }[], mode = 'test') {
  let basket: string | undefined;
  for (const l of lines) {
    const r = await call('/api/pay/basket/add', front(mode), { basket, line: l.line, claim: l.claim });
    assert.equal(r.status, 200, r.text);
    basket = r.json.basket;
  }
  return basket!;
}
const viewOf = async (basket: string) => (await call(`/api/pay/basket?id=${basket}&country=NL`, front())).json;
const enter = (basket: string, code: string) => call('/api/pay/basket/code', front(), { basket, code, country: 'NL' });
const checkout = (basket: string, email = 'sanne@example.com', over: Record<string, unknown> = {}) =>
  call('/api/pay/basket/checkout', front(), {
    basket,
    deliver_to: { name: 'Sanne de Vries', line1: 'Lindelaan 12', postCode: '1234 AB', city: 'Utrecht', country: 'NL' },
    email,
    locale: 'nl',
    success_url: 'https://front.preview.company.test/done/?session={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://front.preview.company.test/checkout/',
    ...over,
  });
const payPage = (url: string) => call(`${new URL(url).pathname}/pay`, { origin: 'https://hq.company.test' }, '');
const expireAtStripe = (session: string) =>
  payments.imitation('POST', `/v1/checkout/sessions/${session}/expire`, new URLSearchParams());

// A paid basket (an order): one line of Pebblet's unless given, paid by `email`. Its session.
async function order(email = 'sanne@example.com', lines?: { line: string; claim: string }[], code?: string) {
  const basket = await basketOf(lines ?? [await line('pebblet')]);
  if (code) assert.equal((await enter(basket, code)).status, 200);
  const opened = await checkout(basket, email);
  assert.equal(opened.status, 200, opened.text);
  await payPage(opened.json.url);
  assert.equal((await viewOf(basket)).status, 'paid');
  return opened.json.id as string;
}
// a code past its end date: time moving on, which no route makes
const setUntil = (code: string, until: string) =>
  db.prepare('update codes set until = ? where code = ?').run(until, code);

test('a code is a word and four digits, typed in any case, with or without the space', () => {
  assert.equal(codes.normalCode('OTTER 4827'), 'OTTER 4827');
  assert.equal(codes.normalCode('otter4827'), 'OTTER 4827');
  assert.equal(codes.normalCode('  Otter - 4827 '), 'OTTER 4827');
  for (const wrong of ['OTTER 482', 'OTTER 48271', '4827 OTTER', 'OTTER', 'OT TER 48 27x', '', null])
    assert.equal(codes.normalCode(wrong), null, String(wrong));
});

test('a code runs to the end of the third month after the day it is given, across month ends and years', () => {
  assert.equal(codes.untilOf('2026-10-17', 3), '2027-01-31');
  assert.equal(codes.untilOf('2026-11-30', 3), '2027-02-28');
  assert.equal(codes.untilOf('2027-11-01', 3), '2028-02-29', 'a leap year');
  assert.equal(codes.untilOf('2026-08-31', 3), '2026-11-30');
  assert.equal(codes.untilOf('2026-12-31', 1), '2027-01-31');
  // given at 23:30 UTC on 30 September: already 1 October in Amsterdam
  assert.equal(codes.untilFor(Date.parse('2026-09-30T23:30:00Z')), '2027-01-31');
});

test('a paid basket gets its own code, once, in its language, and the hooks hear it', async () => {
  const heard: any[] = [];
  codes.codeIssued.push(code => heard.push(code));
  const session = await order();
  const own = codes.codeOf(session, 'order')!;
  assert.match(own.code, /^[A-Z]+ \d{4}$/);
  assert.ok(
    WORDS.map(w => w.toUpperCase())
      .concat(filler.map(w => w.toUpperCase()))
      .includes(own.code.split(' ')[0]),
  );
  assert.deepEqual(
    [own.kind, own.lang, own.percent, own.cap, own.status, own.mode],
    ['order', 'nl', 10, null, 'unused', 'test'],
  );
  assert.equal(own.until, codes.untilFor());
  assert.deepEqual(codes.issueCode('order', session), own, 'asked again, the first answers');
  assert.deepEqual(
    heard.filter(c => c.session === session).map(c => c.id),
    [own.id],
  );
  const flaw = codes.issueCode('flaw', session, { cap: 350 });
  assert.deepEqual([flaw.kind, flaw.cap, flaw.lang], ['flaw', 350, 'nl']);
  assert.equal(codes.issueCode('flaw', session, { cap: 900 }).cap, 350, 'one per order: the first cap stays');
  assert.throws(() => codes.issueCode('flaw', 'cs_test_nothing'), /paid basket/);
  const unpaid = await basketOf([await line('pebblet')]);
  const opened = await checkout(unpaid);
  assert.throws(() => codes.issueCode('order', opened.json.id), /paid basket/, 'an open checkout is no order yet');
});

test('the code takes its percent off each line after its voucher, rounded down, never off an offer, and the postage saving stays', async () => {
  const session = await order();
  const own = codes.codeOf(session, 'order')!;
  const plain = await line('pebblet', { amount: 3995 });
  const offer = await line('hello', { amount: 2495, offer: true });
  const basket = await basketOf([plain, offer]);
  const before = await viewOf(basket);
  const entered = await enter(basket, own.code.toLowerCase().replace(' ', ''));
  assert.equal(entered.status, 200, entered.text);
  const view = entered.json;
  assert.deepEqual(
    view.lines.map((l: any) => [l.offer, l.code_saved, l.saved, l.card]),
    [
      [false, 399, 0, 3596],
      [true, 0, 400, 2095],
    ],
  );
  assert.deepEqual(view.code, {
    code: own.code,
    kind: 'order',
    until: own.until,
    percent: 10,
    off: null,
    minimum: 0,
    cap: null,
    saved: 399,
  });
  assert.equal(view.total, 3596 + 2095);
  assert.notEqual(view.revision, before.revision, 'a checkout sent with the page before the code is refused');
  const stale = await checkout(basket, 'ana@example.com', { revision: before.revision });
  assert.equal(stale.json.why, 'basket_changed');
  const removed = await call('/api/pay/basket/code/remove', front(), { basket, country: 'NL' });
  assert.deepEqual(
    [removed.json.code, removed.json.total, removed.json.revision],
    [null, before.total, before.revision],
  );
});

test('a code with a cap stops at it, in basket order', async () => {
  const session = await order();
  const flaw = codes.issueCode('flaw', session, { cap: 500 });
  const basket = await basketOf([await line('pebblet', { amount: 3995 }), await line('hello', { amount: 2495 })]);
  const view = (await enter(basket, flaw.code)).json;
  assert.deepEqual(
    view.lines.map((l: any) => l.code_saved),
    [399, 101],
  );
  assert.equal(view.code.saved, 500);
});

test('an amount off from a minimum: spread over the lines not on offer by what they cost, refused under it, and gone when a line goes out', async () => {
  manifest('front', SHOP + CODES.replace('order: {percent: 10}', 'order: {off: 500, minimum: 3000}'));
  let own;
  try {
    own = codes.codeOf(await order(), 'order')!;
  } finally {
    manifest('front', SHOP + CODES);
  }
  assert.deepEqual([own.percent, own.off, own.minimum], [null, 500, 3000], 'a code keeps the size it was given with');
  const two = [await line('pebblet', { amount: 2000 }), await line('hello', { amount: 1500 })];
  const offer = await line('hello', { amount: 4000, offer: true });
  const basket = await basketOf([...two, offer]);
  const view = (await enter(basket, own.code)).json;
  assert.deepEqual(
    view.lines.map((l: any) => l.code_saved),
    [286, 214, 0],
    '500 by cost (285.7 and 214.3), the cent rounding left on the first',
  );
  assert.deepEqual([view.code.off, view.code.minimum, view.code.saved], [500, 3000, 500]);
  const small = await basketOf([
    await line('pebblet', { amount: 2900 }),
    await line('hello', { amount: 4000, offer: true }),
  ]);
  const refused = await enter(small, own.code);
  // (the refusal's minimum)
  assert.deepEqual(
    [refused.status, refused.json.why, refused.json.minimum],
    [409, 'code_minimum', 3000],
    "an offer never counts towards the minimum; the refusal carries the code's own, for the shop's words",
  );
  const out = await call('/api/pay/basket/remove', front(), { basket, line: two[1].line });
  const after = (await call(`/api/pay/basket?id=${out.json.basket}&country=NL`, front())).json;
  assert.deepEqual([after.code, after.code_dropped], [null, { code: own.code, why: 'code_minimum' }]);
  assert.equal(after.lines[0].code_saved, 0);
  const cleared = await call('/api/pay/basket/code/remove', front(), { basket, country: 'NL' });
  assert.equal(cleared.json.code_dropped, null);
});

test("a checkout refused under the code's minimum carries the minimum too, for the shop's words", async () => {
  manifest('front', SHOP + CODES.replace('order: {percent: 10}', 'order: {off: 500, minimum: 3000}'));
  let own;
  try {
    own = codes.codeOf(await order(), 'order')!;
  } finally {
    manifest('front', SHOP + CODES);
  }
  const one = await line('pebblet', { amount: 3500 });
  const basket = await basketOf([one]);
  assert.equal((await enter(basket, own.code)).status, 200);
  // the product changed the line in another tab
  const changed = await call('/api/pay/line', as('pebblet'), {
    reference: one.reference,
    amount: 2900,
    description: 'pebblet poster',
    order_url: `https://pebblet.preview.company.test/order/${one.reference}`,
  });
  assert.equal(changed.status, 200, changed.text);
  const refused = await checkout(basket);
  assert.deepEqual([refused.status, refused.json.why, refused.json.minimum], [409, 'code_minimum', 3000]);
});

test("a voucher pays for a line, so the minimum counts the line's price before it; the amount off comes off what's due", async () => {
  manifest('front', SHOP + CODES.replace('order: {percent: 10}', 'order: {off: 500, minimum: 3000}'));
  let own;
  try {
    own = codes.codeOf(await order(), 'order')!;
  } finally {
    manifest('front', SHOP + CODES);
  }
  const worth = () => 1000; // every voucher in this test is worth €10
  payments.lineVoucher.unshift(worth); // (before the vouchers kit's own hook, which knows no V9)
  try {
    const paidPart = await line('pebblet', { amount: 3500, voucher: 9 });
    assert.equal(paidPart.voucher_value, 1000);
    const view = (await enter(await basketOf([paidPart]), own.code)).json;
    assert.deepEqual(
      [view.lines[0].code_saved, view.code.saved],
      [500, 500],
      '€35 with €10 of it by voucher is an order from €30',
    );
  } finally {
    payments.lineVoucher.splice(payments.lineVoucher.indexOf(worth), 1);
  }
});

test('a checkout holds the code; the payment uses it; a session that ends unpaid frees it', async () => {
  const own = codes.codeOf(await order(), 'order')!;
  const first = await basketOf([await line('pebblet')]);
  const theirs = await line('hello');
  const second = await basketOf([theirs]);
  assert.equal((await enter(first, own.code)).status, 200);
  assert.equal((await enter(second, own.code)).status, 200, 'a code can sit in two baskets');
  const held = await checkout(first);
  assert.equal(codes.codeOf(own.session, 'order')!.status, 'held');
  const refused = await enter(second, own.code);
  assert.deepEqual([refused.status, refused.json.why], [409, 'code_in_use']);
  const blocked = await checkout(second);
  assert.equal(blocked.json.why, 'code_in_use', "the other basket's checkout can't use it either");
  assert.equal((await viewOf(second)).code, null, 'and it left that basket');
  expireAtStripe(held.json.id);
  assert.equal((await enter(second, own.code)).status, 200, 'the first session ended unpaid: free again');
  const paid = await checkout(second, 'nieuw@example.com');
  await payPage(paid.json.url);
  const after = await viewOf(second);
  assert.deepEqual([after.status, after.code.code, after.code.saved], ['paid', own.code, 399]);
  const used = codes.codeOf(own.session, 'order')!;
  assert.equal(used.status, 'used');
  const again = await enter(first, own.code);
  assert.deepEqual([again.status, again.json.why], [409, 'code_used']);
  const kept = await call(`/api/pay/line?id=${theirs.line}`, as('hello'));
  assert.equal(kept.json.code_saved, 399, "the line keeps what the code took off, for its product's remedies");
  const done = await call(`/api/pay/basket/order?id=${paid.json.id}`, front());
  assert.deepEqual([done.json.code.code, done.json.lines[0].code_saved], [own.code, 399]);
});

test('changing the code ends the open checkout first, like any change', async () => {
  const one = codes.codeOf(await order(), 'order')!;
  const two = codes.codeOf(await order(), 'order')!;
  const basket = await basketOf([await line('pebblet')]);
  await enter(basket, one.code);
  const opened = await checkout(basket);
  assert.equal((await enter(basket, two.code)).json.code.code, two.code, 'a new code replaces the old');
  assert.equal(
    (payments.imitation('GET', `/v1/checkout/sessions/${opened.json.id}`, new URLSearchParams()) as any).status,
    'expired',
  );
  assert.equal(codes.codeOf(one.session, 'order')!.status, 'unused');
});

test('an expired code is refused, but one that expired while its session held it still goes through', async () => {
  const late = codes.codeOf(await order(), 'order')!;
  setUntil(late.code, '2020-01-31');
  const basket = await basketOf([await line('pebblet')]);
  assert.deepEqual([(await enter(basket, late.code)).json.why], ['code_expired']);
  const held = codes.codeOf(await order(), 'order')!;
  const other = await basketOf([await line('pebblet')]);
  await enter(other, held.code);
  const opened = await checkout(other, 'ander@example.com');
  setUntil(held.code, '2020-01-31');
  assert.equal((await viewOf(other)).code.code, held.code, 'its checkout shows what it charges');
  const again = await checkout(other, 'ander@example.nl');
  assert.deepEqual(
    [again.status, again.json.why],
    [409, 'code_expired'],
    'a new session never takes it past its end date',
  );
  await payPage(opened.json.url);
  assert.equal((await viewOf(other)).status, 'paid');
  assert.equal(codes.codeOf(held.session, 'order')!.status, 'used');
});

test('wrong codes are limited per basket and hour, and then even a right one waits', async () => {
  const own = codes.codeOf(await order(), 'order')!;
  const basket = await basketOf([await line('pebblet')]);
  for (let i = 0; i < 10; i++)
    assert.equal((await enter(basket, `OTTER ${String(i).padStart(4, '0')}x`)).json.why, 'code_unknown');
  const stopped = await enter(basket, own.code);
  assert.deepEqual([stopped.status, stopped.json.why], [429, 'code_tries']);
  assert.equal(
    (await enter(await basketOf([await line('pebblet')]), own.code)).status,
    200,
    'another basket still can',
  );
  await codes.tick(Date.now() + 3_700_000);
});

test('a test code never works in a live basket', async () => {
  const own = codes.codeOf(await order(), 'order')!;
  approvals.record('live:front', 701);
  approvals.record('live:pebblet', 702);
  const live = await line('pebblet', { order_url: 'https://pebblet.company.test/order/live-1' }, 'live');
  const basket = await basketOf([live], 'live');
  const r = await call('/api/pay/basket/code', front('live'), { basket, code: own.code });
  assert.deepEqual([r.status, r.json.why], [404, 'code_unknown']);
  assert.equal(
    (await call('/api/pay/basket/code', as('pebblet'), { basket, code: own.code })).status,
    403,
    "baskets are the front's",
  );
});

test("a newcomer paying with an order's code earns that order's buyer one thank-you code", async () => {
  const referrer = await order('gever@example.com');
  const own = codes.codeOf(referrer, 'order')!;
  const friend = await order('vriend@example.com', undefined, own.code);
  const thanks = codes.codeOf(referrer, 'thanks')!;
  assert.deepEqual([thanks.kind, thanks.lang, thanks.status], ['thanks', 'nl', 'unused']);
  assert.equal(codes.codeOf(friend, 'thanks'), null);
  // the buyer's own code, used by the buyer again: no newcomer, no thank-you
  const self = await order('zelf@example.com');
  await order('Zelf@Example.com', undefined, codes.codeOf(self, 'order')!.code);
  assert.equal(codes.codeOf(self, 'thanks'), null);
  // someone who has ordered before is no newcomer either
  const other = await order('weer@example.com');
  await order('vriend@example.com', undefined, codes.codeOf(other, 'order')!.code);
  assert.equal(codes.codeOf(other, 'thanks'), null);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(Date.now());
  const counted = codes.usedByDay('test', today, today).find(d => d.kind === 'order')!;
  assert.ok(counted.all >= 3 && counted.newcomer >= 1, JSON.stringify(counted));
});

test('a buyer key lasts 12 months after the last order: after that, the same payer is a newcomer again', async () => {
  const referrer = await order('oud@example.com');
  const first = await order('terug@example.com');
  // (a year on: time moving on, which no route makes)
  db.prepare(
    "update code_buyers set first = '2025-01-01', last = '2025-01-01' where last = (select paid from code_orders where session = ?)",
  ).run(first);
  await order('terug@example.com', undefined, codes.codeOf(referrer, 'order')!.code);
  assert.ok(codes.codeOf(referrer, 'thanks'), 'no order from that email in the 12 months before: a newcomer');
  const keys = () => (db.prepare('select count(*) n from code_buyers').get() as any).n;
  const before = keys();
  db.prepare("update code_buyers set last = '2025-01-01'").run();
  await codes.tick();
  assert.ok(before > 0);
  assert.equal(keys(), 0, 'deleted 12 months after the last order');
});

test("a paid order whose codes weren't done (a stop, a failed hook) gets them at the next tick", async () => {
  const hooks = payments.basketPaid.splice(0);
  try {
    const session = await order('later@example.com');
    assert.equal(codes.codeOf(session, 'order'), null);
    await codes.tick();
    assert.equal(codes.codeOf(session, 'order')!.lang, 'nl');
  } finally {
    payments.basketPaid.push(...hooks);
  }
});

test('a shop without codes in its manifest gives none', async () => {
  manifest('front', SHOP);
  try {
    const session = await order();
    assert.equal(codes.codeOf(session, 'order'), null);
    const basket = await basketOf([await line('pebblet')]);
    assert.equal((await enter(basket, 'OTTER 1234')).json.why, 'code_unknown');
    assert.equal(codes.codeSettings(), null);
  } finally {
    manifest('front', SHOP + CODES);
  }
});

test("Numbers counts the shop's paid baskets per day: with more than one thing, and from a buyer who came back", async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(Date.now());
  const count = () => payments.basketsByDay('test', today, today)[0] ?? { paid: 0, several: 0, returning: 0, known: 0 };
  const before = count();
  const since = () => {
    const now = count();
    return {
      paid: now.paid - before.paid,
      several: now.several - before.several,
      returning: now.returning - before.returning,
      known: now.known - before.known,
    };
  };
  await order('eerst@example.com');
  await order('Eerst@example.com', [await line('pebblet'), await line('hello')]);
  assert.deepEqual(since(), { paid: 2, several: 1, returning: 1, known: 2 });
  // a line of the shop's own going with the one thing isn't a second thing
  payments.ownLines.price = (_basket, _things, own) => own.map(() => 999);
  try {
    const thing = await line('pebblet');
    const basket = await basketOf([thing]);
    await payments.changeBasket(
      { slug: 'front', mode: 'test' },
      basket,
      id =>
        payments.addOwnLine(id, {
          goes_with: thing.line,
          description: 'Fridge magnet',
          amount: 999,
          ships_in: 1,
          cutoff: 12,
        }) ?? undefined,
    );
    const opened = await checkout(basket, 'magneet@example.com');
    assert.equal(opened.status, 200, opened.text);
    await payPage(opened.json.url);
    assert.equal((await viewOf(basket)).status, 'paid');
  } finally {
    delete payments.ownLines.price;
  }
  assert.deepEqual(since(), { paid: 3, several: 1, returning: 1, known: 3 });
  // a test order (the shop's test code) is never paid, and a basket its vouchers paid in full is a replacement
  writeFileSync(`${process.env.SECRETS_DIR}/SHOP_TEST_CODE`, 'Board2026Test');
  try {
    const basket = await basketOf([await line('pebblet'), await line('hello')]);
    assert.equal((await enter(basket, 'Board2026Test')).status, 200);
    assert.equal((await checkout(basket, 'eerst@example.com')).status, 200);
  } finally {
    rmSync(`${process.env.SECRETS_DIR}/SHOP_TEST_CODE`);
  }
  const full = (_: unknown, reference: string) => (reference.startsWith('vouched-') ? 3995 : undefined);
  payments.lineVoucher.unshift(full as (typeof payments.lineVoucher)[number]);
  try {
    const vouched = [
      await line('pebblet', { reference: 'vouched-1', voucher: 1 }),
      await line('hello', { reference: 'vouched-2', voucher: 2 }),
    ];
    const basket = await basketOf(vouched);
    assert.equal((await checkout(basket, 'eerst@example.com')).status, 200);
    assert.equal((await viewOf(basket)).status, 'paid');
  } finally {
    payments.lineVoucher.splice(payments.lineVoucher.indexOf(full as any), 1);
  }
  assert.deepEqual(since(), { paid: 3, several: 1, returning: 1, known: 3 });
  // without codes the shop keeps no buyer key: the basket counts, and its buyer isn't known
  manifest('front', SHOP);
  try {
    await order('zonder@example.com');
  } finally {
    manifest('front', SHOP + CODES);
  }
  assert.deepEqual(since(), { paid: 4, several: 1, returning: 1, known: 3 });
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(payments.basketsByDay('test', tomorrow, tomorrow), []);
});
