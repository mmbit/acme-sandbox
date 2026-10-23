// node --test src/ordermail.test.ts   (the harness; Stripe is the imitation, the email service a local stand-in)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { harness, until } from './harness.ts';
import { fakeLettermint, productHeaders } from './fixture.ts';

const h = await harness('ordermail', { env: { PUBLIC_HOST: 'hq.example.test' }, before: repo => {
  for (const slug of ['pinwheel', 'hello']) {
    mkdirSync(`${repo}/products/${slug}/care`, { recursive: true });
    writeFileSync(`${repo}/products/${slug}/product.yaml`, `name: ${slug}\nstatus: preview\n`);
  }
  // the shop's front, whose basket pays lines of both
  mkdirSync(`${repo}/products/front`, { recursive: true });
  writeFileSync(`${repo}/products/front/product.yaml`, 'name: Front\nstatus: preview\nbasket:\n  countries: [NL, BE, DE]\n  postage_saved: {NL: 0, BE: 0, DE: 0}\n');
} });
const { db, dataDir: DATA, repo: REPO } = h;
// a shop's order emails, written here (a product's own live in products/<slug>/care/order-emails.yaml)
writeFileSync(`${REPO}/products/pinwheel/care/order-emails.yaml`, `paid:
  en:
    subject: "Your Pinwheel order {ref}"
    confirmation: &confirmation |
      Confirmed: {date}.
      Your order page: {link}
    body:
      - |
        Thank you! We have your order {ref} for "{name}", {total} in all.
      - *confirmation
  nl:
    subject: "Je Pinwheel-bestelling {ref}"
    body: |
      Bedankt! Bestelling {ref} voor "{name}", {total} in totaal.

      Je bestelpagina: {link}
paid_2:
  en:
    subject: "Your Pinwheel order {ref}"
    body: "The words of our second terms. {link}"
typo:
  en:
    subject: "Your order {ref}"
    body: "It comes on {arrival}."
shipped:
  en:
    subject: "Your Pinwheel order {ref} is on its way"
    body: |
      {carrier} has it: {tracking}

      Your order page: {link}
boxed:
  en:
    subject: "Your Pinwheel order {ref}"
    body: |
      The guarantee notice and our terms are attached. Help: {site}/help.html
    attachments:
      Legal guarantee.pdf: legal/notice-en.pdf
      Terms of sale.pdf: legal/terms-en.pdf
gone:
  en: { subject: "{ref}", body: "{link}", attachments: { Terms of sale.pdf: legal/terms-xx.pdf } }
svg:
  en: { subject: "{ref}", body: "{link}", attachments: { Notice.svg: legal/notice.svg } }
fake:
  en: { subject: "{ref}", body: "{link}", attachments: { Notice.pdf: legal/fake.pdf } }
escape:
  en: { subject: "{ref}", body: "{link}", attachments: { Notice.pdf: ../hello/secret.pdf } }
linked:
  en: { subject: "{ref}", body: "{link}", attachments: { Notice.pdf: legal/linked.pdf } }
listed:
  en: { subject: "{ref}", body: "{link}", attachments: [legal/notice-en.pdf] }
people:
  en: { subject: "{ref}", body: "We'll hide {list}." }
  nl: { subject: "{ref}", body: "We verstoppen {list}." }
draft:
  en:
    subject: "Your Pinwheel order {ref}"
    body: |
      Pinwheel is run by <<the company's address>>. Your order page: {link}
bought:
  en:
    subject: "Your Pinwheel order {ref}"
    body: |
      Total paid: {total}, including {vat_rate} VAT ({vat}).
      Edition: {fact:edition}. Sold by {fact:seller}.
      {fact:limits}
      Your order page: {link}
  nl:
    subject: "Je Pinwheel-bestelling {ref}"
    body: "Totaal {total}, inclusief {vat_rate} btw ({vat}). {fact:edition} {link}"
capital:
  en: { subject: "{ref}", body: "{fact:Edition} {link}" }
`);
// the files the boxed email names, and some it mustn't take
mkdirSync(`${REPO}/products/pinwheel/legal`, { recursive: true });
writeFileSync(`${REPO}/products/pinwheel/legal/notice-en.pdf`, '%PDF-1.4 the notice');
writeFileSync(`${REPO}/products/pinwheel/legal/terms-en.pdf`, '%PDF-1.4 the terms');
writeFileSync(`${REPO}/products/pinwheel/legal/notice.svg`, '<svg/>');
writeFileSync(`${REPO}/products/pinwheel/legal/fake.pdf`, '<svg/>');
writeFileSync(`${REPO}/products/hello/secret.pdf`, '%PDF-1.4 hello\'s');
symlinkSync(`${REPO}/products/hello/secret.pdf`, `${REPO}/products/pinwheel/legal/linked.pdf`);

const ordermail = await import('./ordermail.ts');
// The board's Approve of Pinwheel's launch, on an agent's card
{
  const job = await h.start({ agent: 'bolt' }), card = await h.ask(job, { kind: 'approval', approves: 'live:pinwheel' });
  assert.equal((await h.answer(card, '', { approve: true })).status, 200);
  await h.finish(job);
}

// The email service: every email it was sent, whatever its answer
const lettermint = await fakeLettermint(), { received } = lettermint;

// A product's server, with the token it gets in life
const as = await productHeaders();
const call = h.send;
const FORM = { origin: 'https://hq.example.test', 'content-type': 'application/x-www-form-urlencoded' };
// A paid order: a checkout, paid on the imitation's page with this address. Returns its session id.
async function paidOrder(reference: string, email: string, slug = 'pinwheel') {
  const c = await call('/api/pay/checkout', as(slug), { amount: 3995, currency: 'eur', reference, description: 'A poster',
    success_url: `https://${slug}.preview.example.test/?paid={CHECKOUT_SESSION_ID}`, cancel_url: `https://${slug}.preview.example.test/` });
  assert.equal(c.status, 200, c.text);
  const p = await call(`${new URL(c.json.url).pathname}/pay`, FORM, `email=${encodeURIComponent(email)}`);
  assert.equal(p.status, 303);
  return c.json.id as string;
}
const KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';   // the order's key, in the order page link's fragment
const ask = (order: string, over: Record<string, unknown> = {}, slots: Record<string, unknown> = {}, slug = 'pinwheel', mode = 'test') =>
  call('/api/pay/email', as(slug, mode), { order, kind: 'paid', lang: 'en', ...over,
    slots: { ref: '12345678', name: "Mila's fern", date: '11 October 2026, 15:00', total: 3995, link: `https://${slug}.preview.example.test/order/${order}#t=${KEY}`, ...slots } });

test("an order's email goes to the address it was paid with, never to one the product names", async () => {
  await paidOrder('pin-a-1', 'payer@example.com');
  const r = await ask('pin-a-1', { email: 'someone-else@example.com', to: 'attacker@example.com' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'sent');
  assert.equal(r.json.test_email.to, 'payer@example.com');
  // test mode renders it, in the product's words with HQ's formatting
  assert.equal(r.json.test_email.subject, 'Your Pinwheel order 12345678');
  assert.match(r.json.test_email.text, /"Mila's fern", €39\.95 in all/);
  assert.ok(r.json.test_email.text.includes(`#t=${KEY}`));
  assert.ok(r.json.test_email.text.includes('in all.\n\nConfirmed: 11 October 2026, 15:00.'));
  const nl = await ask('pin-a-1', { lang: 'nl', kind: 'paid' });
  assert.match(nl.json.test_email.text, /€ 39,95 in totaal/);
  // a kind with its words' version keeps the words the order was sold under
  assert.match((await ask('pin-a-1', { kind: 'paid_2' })).json.test_email.text, /our second terms/);
  assert.equal((await ask('pin-a-1', { kind: '2_paid' })).status, 400);
  // an order that isn't paid, or isn't this product's, gets nothing
  await call('/api/pay/checkout', as('pinwheel'), { amount: 3995, currency: 'eur', reference: 'pin-unpaid', description: 'A poster',
    success_url: 'https://pinwheel.preview.example.test/', cancel_url: 'https://pinwheel.preview.example.test/' });
  assert.equal((await ask('pin-unpaid')).status, 409);
  assert.equal((await ask('pin-a-1', {}, { link: 'https://hello.preview.example.test/order/x' }, 'hello')).status, 400, 'hello has no order emails');
  writeFileSync(`${REPO}/products/hello/care/order-emails.yaml`, 'paid:\n  en:\n    subject: "Hello {ref}"\n    body: "{link}"\n');
  assert.equal((await ask('pin-a-1', {}, {}, 'hello')).status, 409, "pinwheel's order is no order of hello's");
});

test('the slots are checked: a link off the product\'s own address, or a missing one, sends nothing', async () => {
  lettermint.on();
  try {
    await paidOrder('pin-s-1', 'payer@example.com');
    const before = received.length;
    for (const [slots, kind] of [[{ link: 'https://evil.example/order#t=1' }], [{ link: 'http://pinwheel.preview.example.test/order' }],
      [{ link: 'https://hello.preview.example.test/order' }], [{ link: 'https://user:pw@pinwheel.preview.example.test/' }],
      [{ ref: 'call me on +31 6 00000000' }], [{ name: 'x'.repeat(61) }], [{ date: 'x'.repeat(61) }], [{ date: undefined }], [{ total: 39.95 }], [{ total: '3995' }], [{ link: undefined }],
      [{}, 'shipped'], [{ tracking: 'http://track.example/1', carrier: 'PostNL' }, 'shipped'], [{ tracking: 'https://track.example/1', carrier: 'PostNL\nClick here' }, 'shipped']] as const) {
      const r = await ask('pin-s-1', kind ? { kind } : {}, slots);
      assert.equal(r.status, 400, JSON.stringify(slots));
    }
    assert.equal((await ask('pin-s-1', { kind: 'refund' })).status, 400, 'a kind the product has no words for');
    assert.equal((await ask('pin-s-1', { kind: 'typo' })).status, 400, 'words with a slot HQ does not fill');
    assert.equal(received.length, before);
    // the name can't break the subject or the lines: control characters are spaces
    const r = await ask('pin-s-1', {}, { name: 'Fern\r\nBcc: x@example.com\u0007' });
    assert.equal(r.json.status, 'sent', r.text);
    assert.match(received.at(-1).text, /"Fern Bcc: x@example\.com"/);
    const shipped = await ask('pin-s-1', { kind: 'shipped' }, { tracking: 'https://track.example/3S123', carrier: 'PostNL' });
    assert.equal(shipped.json.status, 'sent');
    assert.match(received.at(-1).text, /^PostNL has it: https:\/\/track\.example\/3S123/);
  } finally { lettermint.off(); }
});

test('a list slot is written the way the language lists, and refused when empty, too long or not a list', async () => {
  await paidOrder('pin-l-1', 'payer@example.com');
  const people = (lang: string, list: unknown) => ask('pin-l-1', { kind: 'people', lang }, { list });
  assert.equal((await people('en', ['Oma Lies', 'Mila', 'Sem'])).json.test_email.text, "We'll hide Oma Lies, Mila, and Sem.\n");
  assert.equal((await people('nl', ['Oma Lies', ' Mila\n', 'Sem'])).json.test_email.text, 'We verstoppen Oma Lies, Mila en Sem.\n');
  assert.equal((await people('en', ['Opa Henk'])).json.test_email.text, "We'll hide Opa Henk.\n");
  for (const list of [[], ['Mila', ''], Array(21).fill('Mila'), ['x'.repeat(41)], 'Oma Lies, Mila', [3], undefined]) {
    const r = await people('en', list);
    assert.equal(r.status, 400, JSON.stringify(list));
  }
});

test('once per order and kind: asking again answers how it went and never sends a second copy', async () => {
  lettermint.on();
  try {
    await paidOrder('pin-o-1', 'payer@example.com');
    const before = received.length;
    const first = await ask('pin-o-1');
    assert.equal(first.json.status, 'sent');
    assert.equal(received.length, before + 1);
    assert.deepEqual(received.at(-1).to, ['payer@example.com']);
    assert.equal(first.json.test_email, undefined, 'with the service, test mode sends for real');
    for (let i = 0; i < 3; i++) assert.equal((await ask('pin-o-1')).json.status, 'sent');
    assert.equal(received.length, before + 1);
    // two asks at once: one email
    await paidOrder('pin-o-2', 'payer@example.com');
    lettermint.script = ['slow'];
    const both = await Promise.all([ask('pin-o-2'), ask('pin-o-2')]);
    assert.deepEqual(both.map(r => r.json.status), ['sent', 'sent'], 'the second waits its turn, and finds it went');
    assert.equal(received.length, before + 2);
    // another kind is another email
    assert.equal((await ask('pin-o-1', { kind: 'shipped' }, { tracking: 'https://track.example/1', carrier: 'DHL' })).json.status, 'sent');
    assert.equal(received.length, before + 3);
  } finally { lettermint.off(); }
});

test('an email asked for with a delivery goes once per delivery: the same one never twice, a new one again', async () => {
  lettermint.on();
  try {
    await paidOrder('pin-d-1', 'payer@example.com');
    const before = received.length, again = (delivery?: string) => ask('pin-d-1', delivery ? { kind: 'shipped', delivery } : { kind: 'shipped' },
      { tracking: 'https://track.example/1', carrier: 'PostNL' });
    const first = await again('3b241101-e2bb-4255-8caf-4136c566a962');
    assert.equal(first.status, 200, first.text);
    assert.deepEqual([first.json.status, first.json.delivery], ['sent', '3b241101-e2bb-4255-8caf-4136c566a962']);
    assert.deepEqual(received.at(-1).to, ['payer@example.com']);
    assert.equal((await again('3b241101-e2bb-4255-8caf-4136c566a962')).json.status, 'sent');
    assert.equal(received.length, before + 1, 'the same delivery asked again sends nothing');
    assert.equal((await again('second-ask')).json.delivery, 'second-ask');
    assert.equal(received.length, before + 2, 'another delivery is another email');
    // without one it's once per order and kind, as before, and none of the deliveries counts as it
    const plain = await again();
    assert.equal(plain.json.delivery, undefined);
    await again();
    assert.equal(received.length, before + 3);
    // a delivery the service refused is sent again on its next ask
    lettermint.script = ['refuse'];
    assert.equal((await again('third-ask')).status, 502);
    assert.equal((await again('third-ask')).json.status, 'sent');
    assert.equal(received.length, before + 5);
  } finally { lettermint.off(); }
});

test('a delivery is refused unless it is 8-64 letters, digits, _ or -; an unpaid order or another product\'s gets nothing kept', async () => {
  await paidOrder('pin-d-2', 'payer@example.com');
  for (const delivery of ['', 'short', 'has a space', 'x'.repeat(65), 12345678, ['abcdefgh'], { id: 'abcdefgh' }]) {
    const r = await ask('pin-d-2', { delivery });
    assert.equal(r.status, 400, JSON.stringify(delivery));
  }
  writeFileSync(`${REPO}/products/hello/care/order-emails.yaml`, 'paid:\n  en:\n    subject: "Hello {ref}"\n    body: "{link}"\n');
  assert.equal((await ask('pin-d-2', { delivery: 'from-hello-1' }, {}, 'hello')).status, 409, "pinwheel's order is no order of hello's");
  assert.equal((await ask('pin-d-unpaid', { delivery: 'unpaid-ask-1' })).status, 409);
  assert.equal((db.prepare("select count(*) as n from order_emails where reference in ('pin-d-2', 'pin-d-unpaid')").get() as { n: number }).n, 0);
});

test('new deliveries are capped per order and kind, three in ten minutes and ten in a day; asking again with a known one never counts', async () => {
  lettermint.on();
  try {
    await paidOrder('pin-d-3', 'payer@example.com');
    const before = received.length, deliver = (delivery: string, order = 'pin-d-3') => ask(order, { delivery });
    for (const delivery of ['ask-0001', 'ask-0002', 'ask-0003']) assert.equal((await deliver(delivery)).json.status, 'sent');
    const fourth = await deliver('ask-0004');
    assert.equal(fourth.status, 429, fourth.text);
    assert.match(fourth.json.error, /within 10 minutes/);
    assert.equal(fourth.json.why, 'delivery_quota');
    assert.equal(received.length, before + 3);
    assert.equal((db.prepare("select count(*) as n from order_emails where reference = 'pin-d-3'").get() as { n: number }).n, 3, 'a refused one is not kept');
    assert.equal((await deliver('ask-0002')).json.status, 'sent', 'a known delivery still answers');
    assert.equal((await ask('pin-d-3', { kind: 'shipped', delivery: 'ask-0004' }, { tracking: 'https://track.example/1', carrier: 'PostNL' })).json.status, 'sent', 'another kind has its own caps');
    // ten minutes on, three more, and so on up to ten a day (time moving on, in the table)
    const ago = (minutes: number) => db.prepare("update order_emails set created = ? where reference = 'pin-d-3' and kind = 'paid'")
      .run(new Date(Date.now() - minutes * 60_000).toISOString());
    ago(11);
    for (const delivery of ['ask-0004', 'ask-0005', 'ask-0006']) assert.equal((await deliver(delivery)).json.status, 'sent');
    ago(11);
    for (const delivery of ['ask-0007', 'ask-0008', 'ask-0009']) assert.equal((await deliver(delivery)).json.status, 'sent');
    ago(11);
    assert.equal((await deliver('ask-0010')).json.status, 'sent');
    const eleventh = await deliver('ask-0011');
    assert.equal(eleventh.status, 429, eleventh.text);
    assert.match(eleventh.json.error, /had 10 new deliveries within a day/);
    assert.equal(eleventh.json.why, 'delivery_quota');
    ago(25 * 60);
    assert.equal((await deliver('ask-0011')).json.status, 'sent', 'a day on, the next one goes');
    // two new ones at once with one place left: one goes
    await paidOrder('pin-d-4', 'payer@example.com');
    for (const delivery of ['race-0001', 'race-0002']) await deliver(delivery, 'pin-d-4');
    lettermint.script = ['slow'];
    const both = await Promise.all([deliver('race-0003', 'pin-d-4'), deliver('race-0004', 'pin-d-4')]);
    assert.deepEqual(both.map(r => r.status).sort(), [200, 429]);
  } finally { lettermint.off(); }
});

// Stripe for live orders, a local stand-in: every session it's asked about is `id`, paid. It answers 429 while busy.
async function liveStripe(id: string) {
  const stripe = { lookups: 0, busy: false, close: () => {} };
  const server = createServer((q, s) => {
    stripe.lookups++;
    if (stripe.busy) {
      s.writeHead(429, { 'content-type': 'application/json' });
      return s.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Too many requests' } }));
    }
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end(JSON.stringify({ id, object: 'checkout.session', livemode: true, status: 'complete', payment_status: 'paid', url: 'https://checkout.stripe.test/x',
      currency: 'eur', metadata: { product: 'pinwheel' }, customer_details: { email: 'payer@example.com' } }));
  });
  await new Promise<void>(r => server.listen(0, r));
  process.env.STRIPE_API = `http://localhost:${(server.address() as any).port}`;
  mkdirSync(`${DATA}/secrets`, { recursive: true });
  writeFileSync(`${DATA}/secrets/STRIPE_LIVE_RESTRICTED_KEY`, 'rk_live_abc123');
  stripe.close = () => { server.close(); delete process.env.STRIPE_API; rmSync(`${DATA}/secrets/STRIPE_LIVE_RESTRICTED_KEY`, { force: true }); };
  return stripe;
}
// A live order: its checkout, made through the route on that Stripe
async function liveOrder(reference: string) {
  const c = await call('/api/pay/checkout', as('pinwheel', 'live'), { amount: 3995, currency: 'eur', reference, description: 'A poster',
    success_url: 'https://pinwheel.example.test/?paid={CHECKOUT_SESSION_ID}', cancel_url: 'https://pinwheel.example.test/' });
  assert.equal(c.status, 200, c.text);
}

test("a quota refusal carries why delivery_quota before Stripe is asked; Stripe's own 429 carries none and keeps nothing", async () => {
  const stripe = await liveStripe('cs_live_q1');
  await liveOrder('pin-q-1');
  stripe.lookups = 0;
  lettermint.on();
  const deliver = (delivery: string) => ask('pin-q-1', { delivery }, { link: 'https://pinwheel.example.test/order/pin-q-1' }, 'pinwheel', 'live');
  const kept = () => db.prepare("select delivery, tries from order_emails where reference = 'pin-q-1' order by delivery").all()
    .map(r => `${r.delivery}:${r.tries}`);
  try {
    const before = received.length;
    // Stripe throttling: its 429, without the why, and the same delivery goes once Stripe answers
    stripe.busy = true;
    const throttled = await deliver('quota-0001');
    assert.equal(throttled.status, 429, throttled.text);
    assert.equal(throttled.json.why, undefined);
    assert.deepEqual(kept(), [], 'no row and no try');
    stripe.busy = false;
    assert.equal((await deliver('quota-0001')).json.status, 'sent');
    assert.equal((await deliver('quota-0002')).json.status, 'sent');
    // two new deliveries for the last place at once: they take turns in the order's queue, one goes, and the other is
    // refused before Stripe is asked
    const both = await Promise.all([deliver('quota-0003'), deliver('quota-0004')]);
    assert.deepEqual(both.map(r => [r.status, r.json.why]), [[200, undefined], [429, 'delivery_quota']]);
    assert.equal(stripe.lookups, 4);
    assert.equal(kept().length, 3, "the refused one has no row");
    assert.ok(kept().every(k => k.endsWith(':1')), kept().join());
    // past the cap with Stripe busy: the quota refusal comes first, and Stripe is never asked
    stripe.busy = true;
    const refused = await deliver('quota-0005');
    assert.deepEqual([refused.status, refused.json.why], [429, 'delivery_quota'], refused.text);
    assert.equal(stripe.lookups, 4);
    assert.equal(kept().length, 3);
    assert.equal(received.length, before + 3);
  } finally {
    lettermint.off(); stripe.close();
  }
});

test('a hook hears each email that really went, once, with the payment behind it; never one test mode rendered back', async () => {
  const heard: any[] = [], hook = (m: any) => { heard.push(m); }, shipped = { tracking: 'https://track.example/1', carrier: 'PostNL' };
  ordermail.sentHooks.push(hook);
  try {
    await paidOrder('pin-h-1', 'payer@example.com');
    await ask('pin-h-1', { kind: 'shipped' }, shipped);
    assert.equal(heard.length, 0, 'rendered back without the service: nothing went');
    lettermint.on();
    try {
      const session = await paidOrder('pin-h-2', 'payer@example.com');
      assert.equal((await ask('pin-h-2', { kind: 'shipped' }, shipped)).json.status, 'sent');
      await ask('pin-h-2', { kind: 'shipped' }, shipped);
      assert.deepEqual(heard, [{ slug: 'pinwheel', mode: 'test', order: 'pin-h-2', kind: 'shipped', delivery: null, lang: 'en', to: 'payer@example.com', payment: session, ref: '12345678' }]);
      await ask('pin-h-2', { kind: 'shipped', delivery: 'hook-delivery-1' }, shipped);
      assert.equal(heard.at(-1)?.delivery, 'hook-delivery-1');
    } finally { lettermint.off(); }
  } finally { ordermail.sentHooks.splice(ordermail.sentHooks.indexOf(hook), 1); }
});

test('a refused email is sent again on the next ask; one that may have gone too, up to three tries, then a person is told', async () => {
  lettermint.on();
  try {
    await paidOrder('pin-r-1', 'payer@example.com');
    const before = received.length;
    lettermint.script = ['refuse'];
    assert.equal((await ask('pin-r-1')).status, 502);
    assert.equal((await ask('pin-r-1')).json.status, 'sent');
    assert.equal(received.length, before + 2);

    await paidOrder('pin-r-2', 'payer@example.com');
    lettermint.script = ['lose', 'lose', 'lose'];
    for (let i = 0; i < 3; i++) assert.equal((await ask('pin-r-2')).status, 502);
    const last = await ask('pin-r-2');
    assert.equal(last.status, 200);
    assert.equal(last.json.status, 'unsure');
    assert.equal(received.length, before + 5, 'three tries, then no more');
    const told = db.prepare("select text from events where text like '%NEEDS A PERSON%pin-r-2%'").all();
    assert.equal(told.length, 1);
    // a send cut off by a restart (still marked after two minutes) counts as one that may have gone
    // (in the table: no route can stop HQ mid-send)
    const cutOff = (reference: string, tries: number) => db.prepare(`insert into order_emails (product, mode, reference, kind, status, tries,
      rendered, created, updated) values ('pinwheel', 'test', ?, 'paid', 'sending', ?, 0, ?3, ?3)`).run(reference, tries, new Date(Date.now() - 5 * 60_000).toISOString());
    await paidOrder('pin-r-3', 'payer@example.com');
    cutOff('pin-r-3', 1);
    assert.equal((await ask('pin-r-3')).json.status, 'sent');
    // ...and one cut off on its last try sends nothing more: the next ask marks it unsure and asks a person, once
    await paidOrder('pin-r-4', 'payer@example.com');
    cutOff('pin-r-4', 3);
    const sent = received.length;
    for (let i = 0; i < 3; i++) assert.equal((await ask('pin-r-4')).json.status, 'unsure');
    assert.equal(received.length, sent);
    assert.equal(db.prepare("select text from events where text like '%NEEDS A PERSON%pin-r-4%'").all().length, 1);
  } finally { lettermint.off(); }
});

test('live mode refuses without the email service', async () => {
  const r = await ask('pin-l-1', {}, { link: 'https://pinwheel.example.test/order/pin-l-1' }, 'pinwheel', 'live');
  assert.equal(r.status, 503);
});

test('neither the link with its key nor the address reaches the log or the table', async () => {
  const logged = db.prepare('select text from events').all().map((e: any) => String(e.text)).join('\n');
  assert.ok(logged.includes('paid email for pin-a-1'), 'the sends are logged');
  assert.ok(!logged.includes(KEY) && !logged.includes('payer@example.com'));
  assert.ok(!JSON.stringify(db.prepare('select * from order_emails').all()).includes(KEY));
});

test("the files a kind names go with it, and only those; a missing one stops the email", async () => {
  await paidOrder('pin-f-1', 'payer@example.com');
  const site = 'https://pinwheel.preview.example.test/';
  const r = await ask('pin-f-1', { kind: 'boxed', attachments: [{ filename: 'x.pdf', content: 'JVBERi0=' }] }, { site });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.test_email.attachments, ['Legal guarantee.pdf', 'Terms of sale.pdf'], 'test mode names them');
  assert.match(r.json.test_email.text, /Help: https:\/\/pinwheel\.preview\.example\.test\/help\.html/);
  // {site} is the shop's own address and nothing more
  for (const bad of ['https://evil.example', 'http://pinwheel.preview.example.test', 'https://pinwheel.preview.example.test/shop',
    'https://pinwheel.preview.example.test/?x=1', 'https://hello.preview.example.test', undefined,
    'https://front.preview.example.test/', 'https://front.preview.example.test/pinwheel/shop/', 'https://front.preview.example.test/hello/'])
    assert.equal((await ask('pin-f-1', { kind: 'boxed' }, { site: bad })).status, 400, String(bad));
  // or its shelf's top
  const shelf = await ask('pin-f-1', { kind: 'boxed' }, { site: 'https://front.preview.example.test/pinwheel/' });
  assert.match(shelf.json.test_email.text, /Help: https:\/\/front\.preview\.example\.test\/pinwheel\/help\.html/);
  for (const kind of ['gone', 'svg', 'fake', 'escape', 'linked', 'listed'])
    assert.equal((await ask('pin-f-1', { kind })).status, 400, kind);
  lettermint.on();
  try {
    const before = received.length;
    for (const kind of ['gone', 'fake', 'linked']) assert.equal((await ask('pin-f-1', { kind })).status, 400, kind);
    assert.equal(received.length, before, 'nothing goes without its files');
    await paidOrder('pin-f-2', 'payer@example.com');
    assert.equal((await ask('pin-f-2', { kind: 'boxed' }, { site })).json.status, 'sent');
    assert.deepEqual(received.at(-1).attachments, [
      { filename: 'Legal guarantee.pdf', content: Buffer.from('%PDF-1.4 the notice').toString('base64'), content_type: 'application/pdf' },
      { filename: 'Terms of sale.pdf', content: Buffer.from('%PDF-1.4 the terms').toString('base64'), content_type: 'application/pdf' }]);
    assert.equal((await ask('pin-f-2')).json.status, 'sent');
    assert.equal(received.at(-1).attachments, undefined, 'a kind that names none sends none');
  } finally { lettermint.off(); }
});

test("live words that still hold a <<…>> mark aren't final: nothing goes until they're filled in, test mode shows the gap", async () => {
  await paidOrder('pin-m-1', 'payer@example.com');
  const shown = await ask('pin-m-1', { kind: 'draft' });
  assert.equal(shown.status, 200, shown.text);
  assert.match(shown.json.test_email.text, /run by <<the company's address>>\./);
  // a paid live order
  const stripe = await liveStripe('cs_live_m1');
  await liveOrder('pin-m-2');
  lettermint.on();
  const yaml = `${REPO}/products/pinwheel/care/order-emails.yaml`, words = readFileSync(yaml, 'utf8');
  try {
    const before = received.length, live = () => ask('pin-m-2', { kind: 'draft' }, { link: 'https://pinwheel.example.test/order/pin-m-2' }, 'pinwheel', 'live');
    for (let i = 0; i < 4; i++) {
      const r = await live();
      assert.equal(r.status, 409, r.text);
      assert.match(r.json.error, /order-emails\.yaml, draft\.en, still holds <<the company's address>>/);
    }
    assert.equal(received.length, before, 'nothing reaches the email service');
    assert.equal(db.prepare("select text from events where text like '%NEEDS A PERSON%draft email for pin-m-2%'").all().length, 1, 'a person is told once');
    // filled in on main: the next ask sends it (the refusals were no tries)
    writeFileSync(yaml, words.replace("<<the company's address>>", 'Pinwheel BV, Kerkstraat 1, Utrecht'));
    const sent = await live();
    assert.equal(sent.json.status, 'sent', sent.text);
    assert.equal(received.length, before + 1);
    assert.match(received.at(-1).text, /run by Pinwheel BV, Kerkstraat 1, Utrecht\./);
    assert.deepEqual(received.at(-1).to, ['payer@example.com']);
    // an order's fact that isn't final is held back the same way
    const facts = { edition: 'pinwheel-1', seller: '<<Invented private buyer fact>>', limits: 'Prints on paper only.' };
    const factual = () => ask('pin-m-2', { kind: 'bought' }, { link: 'https://pinwheel.example.test/order/pin-m-2', total: 499, vat: 87, vat_rate: 21, facts }, 'pinwheel', 'live');
    const held = await factual();
    assert.equal(held.status, 409, held.text);
    assert.match(held.json.error, /the order's facts for its bought email contain unfinished fields/);
    assert.ok(!held.json.error.includes('Invented private buyer fact'));
    assert.ok(!JSON.stringify(db.prepare('select text from events').all()).includes('Invented private buyer fact'));
    assert.equal(received.length, before + 1);
    facts.seller = 'Pinwheel BV';
    assert.equal((await factual()).json.status, 'sent');
    assert.match(received.at(-1).text, /Sold by Pinwheel BV\./);
    const people = await ask('pin-m-2', { kind: 'people' }, { list: ['<<Mila>>', 'Sem'] }, 'pinwheel', 'live');
    assert.equal(people.json.status, 'sent', people.text);
    assert.match(received.at(-1).text, /<<Mila>>/);
    const named = await ask('pin-m-2', { kind: 'paid' }, {
      ref: 'pin-m-2', name: '<<Mila>>', total: 499, date: '12 October 2026', link: 'https://pinwheel.example.test/order/pin-m-2',
    }, 'pinwheel', 'live');
    assert.equal(named.json.status, 'sent', named.text);
    assert.match(received.at(-1).text, /<<Mila>>/);
    assert.ok(!JSON.stringify(db.prepare('select text from events').all()).includes('<<Mila>>'));
  } finally {
    writeFileSync(yaml, words);
    lettermint.off(); stripe.close();
  }
});

test("an order's email carries its own facts and the VAT it was charged, as plain text, each order its own", async () => {
  await paidOrder('pin-v-1', 'payer@example.com');
  await paidOrder('pin-v-2', 'payer@example.com');
  const first = { edition: 'pinwheel-1', seller: 'Pinwheel BV, Kerkstraat 1', limits: 'Prints on paper only.\nShips within the EU.' };
  const second = { edition: 'pinwheel-2', seller: 'Pinwheel BV, Dorpsstraat 9', limits: 'Prints on paper or canvas.' };
  const bought = (order: string, facts: Record<string, unknown>, over: Record<string, unknown> = {}, slots: Record<string, unknown> = {}) =>
    ask(order, { kind: 'bought', ...over }, { total: 499, vat: 87, vat_rate: 21, facts, ...slots });
  const one = await bought('pin-v-1', first), two = await bought('pin-v-2', second);
  assert.equal(one.status, 200, one.text);
  assert.match(one.json.test_email.text, /Total paid: €4\.99, including 21% VAT \(€0\.87\)\.\nEdition: pinwheel-1\. Sold by Pinwheel BV, Kerkstraat 1\.\nPrints on paper only\.\nShips within the EU\.\n/);
  assert.match(two.json.test_email.text, /Edition: pinwheel-2\. Sold by Pinwheel BV, Dorpsstraat 9\.\nPrints on paper or canvas\./);
  assert.match((await bought('pin-v-1', first, { lang: 'nl' }, { vat_rate: 5.5 })).json.test_email.text, /Totaal € 4,99, inclusief 5,5% btw \(€ 0,87\)/);
  assert.match((await bought('pin-v-1', first, {}, { vat: 0, vat_rate: 0 })).json.test_email.text, /including 0% VAT \(€0\.00\)/);
  // a fact is filled once, in the same pass as the slots: one that reads like a slot stays as it is
  assert.match((await bought('pin-v-1', { ...first, edition: '{link}' })).json.test_email.text, /Edition: \{link\}\./);
  const refusals: [Record<string, unknown>, Record<string, unknown>, RegExp][] = [
    [{ ...first, limits: undefined }, {}, /slots\.facts\.limits/],
    [{ ...first, limits: 'Help: https://evil.example/' }, {}, /slots\.facts\.limits: plain text without a link/],
    [{ ...first, seller: 'see www.evil.example' }, {}, /slots\.facts\.seller/],
    [{ ...first, limits: 'x'.repeat(2001) }, {}, /slots\.facts\.limits/],
    [{ ...first, edition: 2 }, {}, /slots\.facts\.edition/],
    [first, { vat: -1 }, /slots\.vat: whole cents/],
    [first, { vat_rate: 101 }, /slots\.vat_rate/],
    [first, { vat_rate: '21%' }, /slots\.vat_rate/],
  ];
  for (const [facts, slots, why] of refusals) {
    const r = await bought('pin-v-1', facts, {}, slots);
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error, why);
  }
  const capital = await ask('pin-v-1', { kind: 'capital' }, { facts: { Edition: 'x' } });
  assert.equal(capital.status, 400);
  assert.match(capital.json.error, /\{fact:Edition\} in products\/pinwheel\/care\/order-emails\.yaml/);
});

test("an order that is a line of a basket: its email goes to the address the basket was paid with", async () => {
  const lines: string[] = [];
  let basket: string | undefined;
  for (const [slug, reference] of [['pinwheel', 'pin-ln-1'], ['hello', 'hel-ln-1']]) {
    const l = await call('/api/pay/line', as(slug), { reference, amount: 3995, description: 'A poster',
      order_url: `https://${slug}.preview.example.test/order/${reference}` });
    assert.equal(l.status, 200, l.text);
    const b = await call('/api/pay/basket/add', as('front'), { ...(basket ? { basket } : {}), line: l.json.line, claim: l.json.claim });
    assert.equal(b.status, 200, b.text);
    basket = b.json.basket;
    lines.push(l.json.line);
  }
  assert.equal((await ask('pin-ln-1')).status, 409, 'not paid yet');
  const c = await call('/api/pay/basket/checkout', as('front'), { basket, email: 'basket-payer@example.com',
    deliver_to: { name: 'Roos Testpersoon', line1: 'Roosstraat 12', postCode: '1234 AB', city: 'Ee', country: 'NL' },
    success_url: 'https://front.preview.example.test/thanks?s={CHECKOUT_SESSION_ID}', cancel_url: 'https://front.preview.example.test/basket' });
  assert.equal(c.status, 200, c.text);
  assert.equal((await call(`${new URL(c.json.url).pathname}/pay`, FORM, '')).status, 303);
  const r = await ask('pin-ln-1', { email: 'someone-else@example.com' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.test_email.to, 'basket-payer@example.com');
  assert.equal((await ask('hel-ln-1', {}, {}, 'pinwheel')).status, 409, "hello's line is no order of pinwheel's");
});

test('a retirement waits for an email on its way, then leaves no record of it, and no email goes after', async () => {
  lettermint.on();
  try {
    const session = await paidOrder('pin-ret-1', 'payer@example.com');
    assert.equal((await call('/api/pay/refund', as('pinwheel'), { id: session })).json.refunded, true);
    const before = received.length, done: string[] = [];
    lettermint.script = ['slow'];
    const sending = ask('pin-ret-1').then(r => { done.push('email'); return r; });
    await until(() => received.length > before, 'the email service has it');   // its answer a second off
    const retiring = call('/api/pay/retire', as('pinwheel'), { reference: 'pin-ret-1' }).then(r => { done.push('retire'); return r; });
    const [sent, retired] = await Promise.all([sending, retiring]);
    assert.deepEqual([sent.json.status, retired.status, done], ['sent', 200, ['email', 'retire']]);
    assert.equal(db.prepare("select 1 from order_emails where reference = 'pin-ret-1'").get(), undefined, 'no record of the email is left');
    const after = await ask('pin-ret-1', { kind: 'shipped' }, { tracking: 'https://track.example/1', carrier: 'DHL' });
    assert.equal(after.status, 409, after.text);
    assert.equal(received.length, before + 1, 'nothing more went');
    assert.equal(db.prepare("select 1 from order_emails where reference = 'pin-ret-1'").get(), undefined);
  } finally { lettermint.off(); }
});
