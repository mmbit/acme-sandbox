// node --test src/phonecode.test.ts   (the harness; Stripe is the imitation, test mode renders the email back)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { productFolders, productHeaders } from './fixture.ts';
import { parse as parseYaml } from 'yaml';

const h = await harness('phonecode', {
  env: { PUBLIC_HOST: 'hq.example.test' },
  before: repo => {
    productFolders(repo, ['pinwheel', 'hello'], 'status: preview\n');
    mkdirSync(`${repo}/products/front/care`, { recursive: true });
    // the shop's front, whose basket pays lines of both
    writeFileSync(
      `${repo}/products/front/product.yaml`,
      'name: Front\nstatus: preview\nbasket:\n  countries: [NL, BE, DE]\n  postage_saved: {NL: 0, BE: 0, DE: 0}\n',
    );
    writeFileSync(
      `${repo}/products/front/care/phone-code-email.yaml`,
      `en:
  subject: "Your code for your call"
  body: |
    Your code: {code}

    It works for {minutes} minutes. If you didn't call us, ignore this.
nl:
  subject: "Je code voor je gesprek"
  body: "Je code: {code}, {minutes} minuten."
`,
    );
    writeFileSync(
      `${repo}/products/front/care/phone-answer-email.yaml`,
      `en:
  subject: "Your answer, after your call"
  body: |
    Someone called about an order of yours. Here it is.

    {answer}

    [See your order]: {order_page}

    If it wasn't you, ignore this.
`,
    );
    // the basket's one order page, as the confirmation links it
    writeFileSync(
      `${repo}/products/front/care/basket-email.yaml`,
      `en:
  subject: "Your order {number}"
  body: "See it: {order_page}"
  order_page: https://shop.example.test/en/orders/
  test_order_page: https://front.preview.example.test/en/orders/
`,
    );
  },
});
const as = await productHeaders();
const FORM = { origin: 'https://hq.example.test', 'content-type': 'application/x-www-form-urlencoded' };
async function paidOrder(reference: string, email: string, slug = 'pinwheel') {
  const checkout = await h.send('/api/pay/checkout', as(slug), {
    amount: 3995,
    currency: 'eur',
    reference,
    description: 'A poster',
    success_url: `https://${slug}.preview.example.test/?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `https://${slug}.preview.example.test/`,
  });
  assert.equal(checkout.status, 200, checkout.text);
  const paid = await h.send(`${new URL(checkout.json.url).pathname}/pay`, FORM, `email=${encodeURIComponent(email)}`);
  assert.equal(paid.status, 303);
}
const ask = (body: Record<string, unknown>, slug = 'pinwheel') => h.send('/api/pay/code', as(slug), body);
// one basket with a line of each stall's, paid: [stall, reference] each
async function paidBasket(orders: [string, string][], email: string) {
  let basket: string | undefined;
  for (const [slug, reference] of orders) {
    const line = await h.send('/api/pay/line', as(slug), {
      reference,
      amount: 3995,
      description: 'A poster',
      order_url: `https://${slug}.preview.example.test/order/${reference}`,
    });
    assert.equal(line.status, 200, line.text);
    const added = await h.send('/api/pay/basket/add', as('front'), {
      ...(basket ? { basket } : {}),
      line: line.json.line,
      claim: line.json.claim,
    });
    assert.equal(added.status, 200, added.text);
    basket = added.json.basket;
  }
  const checkout = await h.send('/api/pay/basket/checkout', as('front'), {
    basket,
    email,
    deliver_to: { name: 'Roos Testpersoon', line1: 'Roosstraat 12', postCode: '1234 AB', city: 'Ee', country: 'NL' },
    success_url: 'https://front.preview.example.test/thanks?s={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://front.preview.example.test/basket',
  });
  assert.equal(checkout.status, 200, checkout.text);
  assert.equal((await h.send(`${new URL(checkout.json.url).pathname}/pay`, FORM, '')).status, 303);
}

test("the code goes to the address the order was paid with, in the front's words, and names no order", async () => {
  await paidOrder('pin-c-1', 'payer@example.com');
  const r = await ask({ order: 'pin-c-1', code: '042917', lang: 'en', to: 'attacker@example.com' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'sent');
  assert.equal(r.json.test_email.to, 'payer@example.com');
  assert.equal(r.json.test_email.subject, 'Your code for your call');
  assert.match(
    r.json.test_email.text,
    /Your code: 042917\n\nIt works for 10 minutes\. If you didn't call us, ignore this\./,
  );
  assert.doesNotMatch(r.json.test_email.text, /pin-c-1/);
  assert.match(
    (await ask({ order: 'pin-c-1', code: '111111', lang: 'nl' })).json.test_email.text,
    /Je code: 111111, 10 minuten/,
  );
  // a language the words don't have: English
  assert.equal(
    (await ask({ order: 'pin-c-1', code: '222222', lang: 'fr' })).json.test_email.subject,
    'Your code for your call',
  );
});

test('three codes an order a day, then 429; a day later, three more', async () => {
  await paidOrder('pin-c-2', 'payer@example.com');
  for (let i = 0; i < 3; i++) assert.equal((await ask({ order: 'pin-c-2', code: '123456', lang: 'en' })).status, 200);
  const fourth = await ask({ order: 'pin-c-2', code: '123456', lang: 'en' });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.json.why, 'toomany');
  // parallel asks can't all pass the count
  await paidOrder('pin-c-3', 'payer@example.com');
  const all = await Promise.all(Array.from({ length: 6 }, () => ask({ order: 'pin-c-3', code: '123456', lang: 'en' })));
  assert.deepEqual(all.map(r => r.status).sort(), [200, 200, 200, 429, 429, 429]);
  h.db.prepare("update phone_code_emails set ts = ts - ? where reference = 'pin-c-2'").run(24 * 3_600_000 + 1);
  assert.equal((await ask({ order: 'pin-c-2', code: '123456', lang: 'en' })).status, 200);
  assert.equal(
    (h.db.prepare("select count(*) n from phone_code_emails where reference = 'pin-c-2'").get() as { n: number }).n,
    1,
  );
});

test("an order that isn't paid, or isn't the asking product's, gets nothing; nor does a wrong field", async () => {
  await h.send('/api/pay/checkout', as('pinwheel'), {
    amount: 3995,
    currency: 'eur',
    reference: 'pin-unpaid',
    description: 'A poster',
    success_url: 'https://pinwheel.preview.example.test/',
    cancel_url: 'https://pinwheel.preview.example.test/',
  });
  assert.equal((await ask({ order: 'pin-unpaid', code: '123456', lang: 'en' })).status, 409);
  assert.equal((await ask({ order: 'pin-c-1', code: '123456', lang: 'en' }, 'hello')).status, 409);
  assert.equal((await ask({ order: 'nothing-here', code: '123456', lang: 'en' })).status, 409);
  for (const body of [
    { order: 'pin-c-1', code: '12345', lang: 'en' },
    { order: 'pin-c-1', code: '12345a', lang: 'en' },
    { order: 'pin c 1', code: '123456', lang: 'en' },
    { order: 'pin-c-1', code: '123456', lang: 'english' },
  ])
    assert.equal((await ask(body)).status, 400, JSON.stringify(body));
  // the product's own token only
  const stranger = await h.send(
    '/api/pay/code',
    { 'x-product': 'pinwheel', 'x-mode': 'test', 'content-type': 'application/json' },
    { order: 'pin-c-1', code: '123456', lang: 'en' },
  );
  assert.equal(stranger.status, 401);
  assert.equal((await h.send('/api/pay/code', as('pinwheel'), undefined, 'GET')).status, 405);
});

test("a basket's stalls asked at once email one code; a stall's own new ask, or one a round later, emails again", async () => {
  await paidBasket(
    [
      ['pinwheel', 'pin-b-1'],
      ['hello', 'hel-b-1'],
    ],
    'basket-payer@example.com',
  );
  const [first, second] = await Promise.all([
    ask({ order: 'pin-b-1', code: '111111', lang: 'en' }),
    ask({ order: 'hel-b-1', code: '222222', lang: 'en' }, 'hello'),
  ]);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.deepEqual(
    [first, second].filter(r => r.json.test_email).map(r => r.json.test_email.to),
    ['basket-payer@example.com'],
    'one email',
  );
  assert.equal(second.json.status, 'sent', 'the stall hears the same');
  const sent = first.json.test_email ? ['pin-b-1', 'pinwheel'] : ['hel-b-1', 'hello'];
  const again = await ask({ order: sent[0], code: '333333', lang: 'en' }, sent[1]);
  assert.match(again.json.test_email.text, /333333/, "the stall's own new ask");
  // a new round, asked again a little later: both stalls at once, one email again
  h.db.prepare("update phone_code_emails set ts = ts - 10001 where reference in ('pin-b-1', 'hel-b-1')").run();
  const round = await Promise.all([
    ask({ order: 'pin-b-1', code: '444444', lang: 'en' }),
    ask({ order: 'hel-b-1', code: '555555', lang: 'en' }, 'hello'),
  ]);
  assert.equal(round.filter(r => r.json.test_email).length, 1, 'one email in the new round');
});

// each its own key (care's: the call's and the order's), unless the body has one
let keys = 0;
const answer = (body: Record<string, unknown>, slug = 'pinwheel') =>
  h.send('/api/pay/answer', as(slug), { key: `40${++keys}:ORDER`, ...body });
const ANSWER = 'The question was how to cancel it.\n\nOn your order page, until it goes to print.';

test("an answer after a call goes to the address the order was paid with, in the front's words, with the basket's order page", async () => {
  await paidBasket([['pinwheel', 'pin-a-1']], 'basket-payer@example.com');
  const r = await answer({ order: 'pin-a-1', answer: ANSWER, lang: 'en', email: 'attacker@example.com' });
  assert.equal(r.status, 200, r.text);
  const mail = r.json.test_email;
  assert.equal(mail.to, 'basket-payer@example.com');
  assert.equal(mail.subject, 'Your answer, after your call');
  assert.match(
    mail.text,
    /Here it is\.\n\nThe question was how to cancel it\.\n\nOn your order page, until it goes to print\./,
  );
  assert.match(mail.text, /https:\/\/front\.preview\.example\.test\/en\/orders\/#\d{7}\.\S+/);
  assert.equal(mail.replyTo?.split('@')[0], 'hello', 'a reply reaches the inbox, where a person reads it');
  // an order paid on its own has no basket page: its line goes
  await paidOrder('pin-a-2', 'payer@example.com');
  const own = (await answer({ order: 'pin-a-2', answer: ANSWER, lang: 'en' })).json.test_email;
  assert.equal(own.to, 'payer@example.com');
  assert.doesNotMatch(own.text, /See your order|orders\//);
});

test('three answers an order a day, apart from its codes; an unpaid order or a wrong field gets nothing', async () => {
  await paidOrder('pin-a-3', 'payer@example.com');
  assert.equal((await ask({ order: 'pin-a-3', code: '123456', lang: 'en' })).status, 200);
  for (let i = 0; i < 3; i++)
    assert.equal((await answer({ order: 'pin-a-3', answer: ANSWER, lang: 'en' })).status, 200);
  const fourth = await answer({ order: 'pin-a-3', answer: ANSWER, lang: 'en' });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.json.why, 'toomany');
  assert.equal((await ask({ order: 'pin-a-3', code: '123456', lang: 'en' })).status, 200, 'its codes count apart');
  assert.equal((await answer({ order: 'nothing-here', answer: ANSWER, lang: 'en' })).status, 409);
  for (const body of [
    { key: '', order: 'pin-a-3', answer: ANSWER, lang: 'en' },
    { key: 'a key with spaces', order: 'pin-a-3', answer: ANSWER, lang: 'en' },
    { order: 'pin-a-3', answer: '', lang: 'en' },
    { order: 'pin-a-3', answer: 'x'.repeat(8001), lang: 'en' },
    { order: 'pin a 3', answer: ANSWER, lang: 'en' },
    { order: 'pin-a-3', answer: ANSWER, lang: 'english' },
  ])
    assert.equal((await answer(body)).status, 400, JSON.stringify(body).slice(0, 80));
});

test("the same key again (care's reply lost on the way) sends nothing, and answers what the first did", async () => {
  await paidOrder('pin-a-5', 'payer@example.com');
  const first = await answer({ key: '77:PINA5', order: 'pin-a-5', answer: ANSWER, lang: 'en' });
  assert.equal(first.status, 200, first.text);
  assert.ok(first.json.test_email);
  const rows = () =>
    (h.db.prepare("select count(*) as n from phone_code_emails where reference = 'pin-a-5'").get() as { n: number }).n;
  assert.equal(rows(), 1);
  const again = await answer({ key: '77:PINA5', order: 'pin-a-5', answer: ANSWER, lang: 'en' });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.json, { order: 'pin-a-5', status: 'sent' }, 'nothing rendered: nothing sent');
  assert.equal(rows(), 1, "not counted again in the day's three");
  // one HQ stopped halfway through (no outcome kept): not sent again either, and said
  h.db.prepare("update phone_code_emails set outcome = null where ask = '77:PINA5'").run();
  const halfway = await answer({ key: '77:PINA5', order: 'pin-a-5', answer: ANSWER, lang: 'en' });
  assert.equal(halfway.status, 502);
  assert.match(halfway.json.error, /asked before, and whether it went isn't known: not sent again/);
  // another key for the same order is a new answer
  assert.ok((await answer({ key: '78:PINA5', order: 'pin-a-5', answer: ANSWER, lang: 'en' })).json.test_email);
});

// (the company's own words, where it has them: every language of them renders whole, in its look)
const own = new URL('../../../products/front/care/', import.meta.url).pathname;
test(
  "the shop's own words render in each language, with its look",
  {
    skip: ['phone-code-email.yaml', 'phone-answer-email.yaml', 'email-look.yaml'].some(f => !existsSync(`${own}${f}`)),
  },
  async () => {
    for (const file of ['phone-code-email.yaml', 'phone-answer-email.yaml', 'email-look.yaml'])
      writeFileSync(`${h.repo}/products/front/care/${file}`, readFileSync(`${own}${file}`));
    await paidOrder('pin-c-4', 'payer@example.com');
    const langs = Object.keys(parseYaml(readFileSync(`${own}phone-code-email.yaml`, 'utf8')));
    assert.ok(langs.length);
    for (const lang of langs) {
      const r = await ask({ order: 'pin-c-4', code: '314159', lang });
      assert.equal(r.status, 200, r.text);
      assert.match(r.json.test_email.text, /314159/, lang);
      assert.match(r.json.test_email.text, /\b10\b/, lang);
      assert.match(r.json.test_email.html, /314159/, lang);
      assert.doesNotMatch(r.json.test_email.text + r.json.test_email.subject, /pin-c-4|<<|\{/, lang);
      const a = await answer({ order: 'pin-c-4', answer: 'The answer, in its words.', lang });
      assert.equal(a.status, 200, a.text);
      assert.match(a.json.test_email.text, /The answer, in its words\./, lang);
      assert.match(a.json.test_email.html, /The answer, in its words\./, lang);
      assert.doesNotMatch(a.json.test_email.text + a.json.test_email.subject, /pin-c-4|<<|\{/, lang);
    }
  },
);
