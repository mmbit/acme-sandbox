// node --test src/closures.test.ts   (the harness, a local server playing Stripe, and the real desk phone)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { harness } from './harness.ts';
import { productHeaders } from './fixture.ts';

// Each product names its own closure reasons: Plum names none
const products = {
  pebblet:
    'name: Pebblet\nclosure_reasons:\n  paid-use: can no longer use their purchase\n  restoration: can no longer restore it\n',
  hello: 'name: Hello\nclosure_reasons:\n  support: no longer get the support they paid for\n',
  plum: 'name: Plum\n',
};
const h = await harness('closures', {
  env: { PUBLIC_HOST: 'hq.company.test' },
  before: repo => {
    for (const [slug, manifest] of Object.entries(products)) {
      mkdirSync(`${repo}/products/${slug}`, { recursive: true });
      writeFileSync(`${repo}/products/${slug}/product.yaml`, manifest);
    }
    mkdirSync(`${process.env.SECRETS_DIR}`, { recursive: true });
    writeFileSync(`${process.env.SECRETS_DIR}/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  },
});
const payments = await import('./payments.ts');

// Stripe's stand-in answers with the imitation's objects and keeps each refund it makes, by its id
const refunds = new Map<string, { payment_intent: string; amount: number }>();
const stripe = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const idempotency = req.headers['idempotency-key'] as string | undefined;
    const answer = payments.imitation(req.method!, req.url!, new URLSearchParams(body), idempotency);
    if (req.method === 'POST' && req.url === '/v1/refunds')
      refunds.set(answer.id, { payment_intent: answer.payment_intent, amount: answer.amount });
    res.end(JSON.stringify(answer));
  } catch (err: any) {
    res.writeHead(err.status ?? 500);
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
});
await new Promise<void>(r => stripe.listen(0, '127.0.0.1', r));
process.env.STRIPE_API = `http://127.0.0.1:${(stripe.address() as any).port}`;
test.after(() => stripe.close());

const as = await productHeaders();
const call = (path: string, headers: Record<string, string>, body?: unknown) => h.send(path, headers, body);
// The board's answer on a closure's card: Approve, or Not now
const decide = async (decision: number, approve: boolean) =>
  assert.equal((await h.answer((await cardOf(decision)).id, '', { approve })).status, 200);
let orders = 0;
async function paidSession(slug: string, amount: number) {
  const reference = `order-${++orders}`;
  const site = `https://${slug}.preview.company.test/`;
  const checkout = await call('/api/pay/checkout', as(slug), {
    amount,
    currency: 'eur',
    reference,
    description: 'A purchase',
    success_url: site,
    cancel_url: site,
  });
  assert.equal(checkout.status, 200);
  const paid = await call(`/pay/imitation/${checkout.json.id}/pay`, { origin: 'https://hq.company.test' }, '');
  assert.equal(paid.status, 303);
  return checkout.json.id as string;
}
const cardOf = async (decision: number) =>
  (await h.board('/api/requests')).body.find((card: any) => card.approves === `closure:${decision}`);
const refundsOf = async (session: string) => {
  const intent = payments.imitation('GET', `/v1/checkout/sessions/${session}`, new URLSearchParams()).payment_intent;
  return [...refunds.values()].filter(r => r.payment_intent === intent);
};

test('the board approves a closure on its own card, and only then is each named purchase refunded once in full', async () => {
  const first = await paidSession('pebblet', 3995);
  const second = await paidSession('pebblet', 2500);
  const unnamed = await paidSession('pebblet', 1200);
  const asked = await call('/api/pay/closures', as('pebblet'), {
    claims: [
      { id: first, reason: 'paid-use' },
      { id: second, reason: 'restoration' },
    ],
  });
  assert.equal(asked.status, 200);
  assert.equal(asked.json.status, 'asked');
  assert.equal(asked.json.total, 6495);
  const card = await cardOf(asked.json.id);
  assert.equal(card.kind, 'closure', 'the engine files the card itself, of its own kind');
  assert.match(card.grants, /€64\.95/, 'the board reads the whole amount it approves');
  assert.match(
    card.body,
    /can no longer use their purchase \(1\), can no longer restore it \(1\)/,
    "in the product's words",
  );

  const early = await call('/api/pay/closures/refund', as('pebblet'), { decision: asked.json.id, id: first });
  assert.equal(early.status, 403, 'an asked decision moves no money');
  await decide(asked.json.id, true);
  assert.equal((await call(`/api/pay/closures?id=${asked.json.id}`, as('pebblet'))).json.status, 'approved');
  assert.deepEqual(await refundsOf(first), [], 'approval alone starts no refund');
  assert.deepEqual(await refundsOf(second), [], 'the product must apply the approved decision');

  const unnamedRefund = await call('/api/pay/closures/refund', as('pebblet'), { decision: asked.json.id, id: unnamed });
  assert.equal(unnamedRefund.status, 403, 'an approved decision refunds only what it names');
  for (let attempt = 0; attempt < 2; attempt++) {
    const refunded = await call('/api/pay/closures/refund', as('pebblet'), { decision: asked.json.id, id: first });
    assert.equal(refunded.status, 200);
    assert.equal(refunded.json.refunded, true);
  }
  assert.deepEqual(
    (await refundsOf(first)).map(r => r.amount),
    [3995],
    'one refund at the original price',
  );
  assert.deepEqual(await refundsOf(second), []);
  assert.deepEqual(await refundsOf(unnamed), []);
  const decision = (await call(`/api/pay/closures?id=${asked.json.id}`, as('pebblet'))).json;
  assert.deepEqual(
    decision.claims.map((claim: any) => [claim.reason, claim.amount, claim.refund_status]),
    [
      ['paid-use', 3995, 'succeeded'],
      ['restoration', 2500, null],
    ],
  );
});

test('missing, fabricated, unrelated, declined and replayed records refund nothing', async () => {
  const session = await paidSession('pebblet', 1500);
  const theirs = await paidSession('hello', 1500);
  const refundsBefore = refunds.size;
  for (const decision of [undefined, 999_999, 'request:1', 0])
    assert.equal(
      (await call('/api/pay/closures/refund', as('pebblet'), { decision, id: session })).status,
      404,
      String(decision),
    );

  const theirDecision = await call('/api/pay/closures', as('hello'), { claims: [{ id: theirs, reason: 'support' }] });
  await decide(theirDecision.json.id, true);
  assert.equal((await call(`/api/pay/closures?id=${theirDecision.json.id}`, as('pebblet'))).status, 404);
  const borrowed = await call('/api/pay/closures/refund', as('pebblet'), {
    decision: theirDecision.json.id,
    id: theirs,
  });
  assert.equal(borrowed.status, 404, "another product's approval is not this product's");

  const asked = await call('/api/pay/closures', as('pebblet'), { claims: [{ id: session, reason: 'restoration' }] });
  const again = await call('/api/pay/closures', as('pebblet'), { claims: [{ id: session, reason: 'paid-use' }] });
  assert.equal(again.status, 409, 'one asked decision per product and mode on the desk phone');
  await decide(asked.json.id, false);
  const declined = await call(`/api/pay/closures?id=${asked.json.id}`, as('pebblet'));
  assert.equal(declined.json.status, 'declined');
  const refused = await call('/api/pay/closures/refund', as('pebblet'), { decision: asked.json.id, id: session });
  assert.equal(refused.status, 403, 'Not now moves no money');
  const job = await h.start({ agent: 'bolt' }); // pebblet launched: the board's Approve on its card
  await h.answer(await h.ask(job, { kind: 'approval', approves: 'live:pebblet' }), '', { approve: true });
  await h.finish(job);
  const otherMode = await call('/api/pay/closures/refund', as('pebblet', 'live'), {
    decision: asked.json.id,
    id: session,
  });
  assert.equal(otherMode.status, 404, "a test decision is not the live product's");
  assert.equal(refunds.size, refundsBefore);
});

test('a closure asks only about paid purchases of its own product that are not refunded, for a reason the product names', async () => {
  const unpaid = await call('/api/pay/checkout', as('pebblet'), {
    amount: 900,
    currency: 'eur',
    reference: 'unpaid-order',
    description: 'A purchase',
    success_url: 'https://pebblet.preview.company.test/',
    cancel_url: 'https://pebblet.preview.company.test/',
  });
  const refunded = await paidSession('pebblet', 900);
  assert.equal((await call('/api/pay/refund', as('pebblet'), { id: refunded })).status, 200);
  const theirs = await paidSession('hello', 900);
  const paid = await paidSession('pebblet', 900);
  const ask = (claims: unknown) => call('/api/pay/closures', as('pebblet'), { claims });
  assert.equal((await ask([{ id: unpaid.json.id, reason: 'paid-use' }])).status, 409);
  assert.equal((await ask([{ id: refunded, reason: 'paid-use' }])).status, 409);
  assert.equal((await ask([{ id: theirs, reason: 'paid-use' }])).status, 404);
  assert.equal((await ask([{ id: paid, reason: 'unhappy' }])).status, 400);
  assert.equal(
    (await ask([{ id: paid, reason: 'support' }])).status,
    400,
    "another product's reason is not this one's",
  );
  const plums = await paidSession('plum', 900);
  const unnamed = await call('/api/pay/closures', as('plum'), { claims: [{ id: plums, reason: 'paid-use' }] });
  assert.equal(unnamed.status, 503, 'a product that names no reasons asks nothing');
  assert.equal((await ask([])).status, 400);
  assert.equal((await ask(Array.from({ length: 2 }, () => ({ id: paid, reason: 'paid-use' })))).status, 400);
});
