// node --test src/payments.test.ts   (the harness; Stripe is the imitation, then a local server playing Stripe)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { harness, until } from './harness.ts';
import { productHeaders } from './fixture.ts';

// (the test company has no kits of its own: none of ours hooks into its payments)
const h = await harness('payments', { env: { PUBLIC_HOST: 'hq.company.test' } });
const { db, dataDir: DATA, repo, send: call } = h;
const payments = await import('./payments.ts');
const manifest = (slug: string, yaml: string) => { mkdirSync(`${repo}/products/${slug}`, { recursive: true }); writeFileSync(`${repo}/products/${slug}/product.yaml`, yaml); };
// The board's Approve on an agent's card for a grant (live:<slug>, site:<slug>)
const approve = async (grant: string) => {
  const job = await h.start({ agent: 'bolt' }), card = await h.ask(job, { kind: 'approval', approves: grant });
  assert.equal((await h.answer(card, '', { approve: true })).status, 200);
  await h.finish(job);
};

// A stand-in for api.stripe.com: checks the key and the form encoding, answers with the imitation's objects. A refund can
// be scripted to go through Stripe's other statuses: `refundScript = ['pending', 'failed']` makes the next one pending,
// then failed when it's read again.
const seen: { auth: string; path: string; idem?: string; body: string }[] = [];
let refundScript: string[] | null = null, slowCreate = 0, slowExpire = 0, loseCreate = false, lostId = '';
let payerListReply: unknown;
let chargesEnabled = false;   // the live account, as Stripe has it: activated or not
let printerBusy = false;   // Print API answering 429
let addedMethod = '';   // a method Stripe switched on after EXCLUDABLE was read: the next session offers it too
let droppedMethod = '';   // a method Stripe took out of the next session, the shop's setting naming it
let feeLookup: 'unsettled' | 'refused' | 'held' | null = null;   // a charge whose balance transaction isn't in yet, a key that may not read it, or a lookup Stripe sits on
const heldFees: (() => void)[] = [];   // the held lookups: each answers when called
const scripted = new Map<string, string[]>();
const stripe = createServer(async (q, s) => {
  let body = ''; for await (const c of q) body += c;
  seen.push({ auth: String(q.headers.authorization), path: q.url!, idem: q.headers['idempotency-key'] as string | undefined, body });
  // the live account: rk_live_mayread1 may read it, rk_live_noread1 may not (Stripe's 403); any other key is wrong
  if (q.url === '/v1/account' && q.headers.authorization === 'Bearer rk_live_mayread1') return s.end(JSON.stringify({ id: 'acct_1', object: 'account', charges_enabled: chargesEnabled }));
  if (q.url === '/v1/account' && q.headers.authorization === 'Bearer rk_live_noread1') { s.writeHead(403); return s.end(JSON.stringify({ error: { message: 'The provided key does not have the required permissions' } })); }
  // Print API's token for the live keys: only LIVE-ID with LIVE-SECRET or NEW-SECRET
  if (q.url === '/printapi/oauth') {
    if (printerBusy) { s.writeHead(429); return s.end(JSON.stringify({ error: 'slow_down' })); }
    const keys = new URLSearchParams(body), takes = keys.get('client_id') === 'LIVE-ID' && ['LIVE-SECRET', 'NEW-SECRET'].includes(keys.get('client_secret')!);
    s.writeHead(takes ? 200 : 400); return s.end(JSON.stringify(takes ? { access_token: 'pa1', expires_in: 3600 } : { error: 'invalid_client' }));
  }
  if (q.headers.authorization !== 'Bearer rk_test_abc123') { s.writeHead(401); return s.end(JSON.stringify({ error: { message: 'Invalid API Key provided' } })); }
  if (q.url!.startsWith('/v1/checkout/sessions?') && payerListReply !== undefined) return s.end(JSON.stringify(payerListReply));
  if (q.url === '/v1/checkout/sessions') await new Promise(r => setTimeout(r, slowCreate));
  if (q.url!.endsWith('/expire')) await new Promise(r => setTimeout(r, slowExpire));
  if (refundScript && q.method === 'POST' && q.url === '/v1/refunds') {
    const id = `re_script${scripted.size}`; scripted.set(id, refundScript); refundScript = null;
    return s.end(JSON.stringify({ id, object: 'refund', status: scripted.get(id)!.shift() }));
  }
  const sr = scripted.get(q.url!.replace('/v1/refunds/', ''));
  if (sr) return s.end(JSON.stringify({ id: q.url!.replace('/v1/refunds/', ''), object: 'refund', status: sr.length > 1 ? sr.shift() : sr[0] }));
  if (feeLookup === 'held' && q.url!.startsWith('/v1/payment_intents/')) await new Promise<void>(r => heldFees.push(r));
  if (feeLookup === 'refused' && q.url!.startsWith('/v1/payment_intents/')) { s.writeHead(403); return s.end(JSON.stringify({ error: { message: 'The provided key does not have the required permissions' } })); }
  try {
    const out = payments.imitation(q.method!, q.url!, new URLSearchParams(body), q.headers['idempotency-key'] as string | undefined);
    if (feeLookup === 'unsettled' && q.url!.startsWith('/v1/payment_intents/')) out.latest_charge.balance_transaction = null;
    if (loseCreate && q.url === '/v1/checkout/sessions') { loseCreate = false; lostId = out.id; return s.destroy(); } // made, answer lost
    if (addedMethod && q.url === '/v1/checkout/sessions') out.payment_method_types.push(addedMethod);
    if (droppedMethod && q.url === '/v1/checkout/sessions') out.payment_method_types = out.payment_method_types.filter((m: string) => m !== droppedMethod);
    s.end(JSON.stringify(out));
  } catch (e: any) { s.writeHead(e.status ?? 500); s.end(JSON.stringify({ error: { message: e.message.replace(/^Stripe: /, '') } })); }
});
await new Promise<void>(r => stripe.listen(0, r));
test.after(() => stripe.close());
process.env.STRIPE_API = `http://localhost:${(stripe.address() as any).port}`;
process.env.PRINTAPI_LIVE_API = `${process.env.STRIPE_API}/printapi`;
const as = await productHeaders();
// Stripe's side (the imitation, which the stand-in answers with too): a session, and the refunds made on its payment
const stripeSession = (id: string) => payments.imitation('GET', `/v1/checkout/sessions/${id}`, new URLSearchParams()) as any;
const refundsAt = (session: string) => (payments.imitation('GET', `/v1/refunds?payment_intent=${stripeSession(session).payment_intent}`, new URLSearchParams()) as any).data;
const order = (over: Record<string, unknown> = {}) => ({ amount: 3995, currency: 'eur', reference: 'bud-abc123-0badcafe', description: 'Pebblet poster',
  success_url: 'https://pebblet.preview.company.test/?order=bud-abc123-0badcafe&paid={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://pebblet.preview.company.test/?order=bud-abc123-0badcafe', ...over });

test('a product needs its own token for its own slug and mode', async () => {
  assert.equal((await call('/api/pay/checkout', {}, order())).status, 401);
  assert.equal((await call('/api/pay/checkout', as('pebblet', 'test', payments.tokenFor('hello', 'test')), order())).status, 401);
  assert.equal((await call('/api/pay/checkout', as('pebblet', 'test', payments.tokenFor('pebblet', 'live')), order())).status, 401);
  assert.equal((await call('/api/pay/checkout', { ...as('pebblet'), 'x-mode': 'staging' }, order())).status, 401);
});

test('checkout checks what it is asked to charge and where it sends the customer', async () => {
  for (const bad of [{ amount: 39.95 }, { amount: 10 }, { amount: 50_001 }, { currency: 'usd' }, { reference: 'a b' }, { description: '' },
    { success_url: 'https://evil.example/' }, { cancel_url: 'http://pebblet.preview.company.test/' }, { success_url: 'https://hello.preview.company.test/' }]) {
    const r = await call('/api/pay/checkout', as('pebblet'), order(bad));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('/api/pay/checkout', as('pebblet'), '{not json')).status, 400);
});

test('test mode without a key: the imitation, end to end (open → pay → paid → refund once)', async () => {
  const c = await call('/api/pay/checkout', as('pebblet'), order());
  assert.equal(c.status, 200, c.text);
  assert.match(c.json.id, /^cs_test_/);
  assert.equal(c.json.url, `https://hq.company.test/pay/imitation/${c.json.id}`);
  let s = await call(`/api/pay/session?id=${c.json.id}`, as('pebblet'));
  assert.deepEqual({ status: s.json.status, paid: s.json.paid, amount: s.json.amount, reference: s.json.reference }, { status: 'open', paid: false, amount: 3995, reference: 'bud-abc123-0badcafe' });
  // refunding an unpaid session is refused
  assert.equal((await call('/api/pay/refund', as('pebblet'), { id: c.json.id })).status, 409);
  // another product can't see it, nor can live mode
  assert.equal((await call(`/api/pay/session?id=${c.json.id}`, as('hello'))).status, 404);
  // the imitation's page: shows the amount, pays only from HQ's own origin, then returns to the product
  const path = new URL(c.json.url).pathname;
  assert.match((await call(path, {})).text, /€39\.95/);
  assert.equal((await call(`${path}/pay`, { origin: 'https://pebblet.preview.company.test' }, '')).status, 403);
  const paid = await call(`${path}/pay`, { origin: 'https://hq.company.test' }, '');
  assert.equal(paid.status, 303);
  assert.equal(paid.headers.location, `https://pebblet.preview.company.test/?order=bud-abc123-0badcafe&paid=${c.json.id}`);
  s = await call(`/api/pay/session?id=${c.json.id}`, as('pebblet'));
  assert.equal(s.json.paid, true);
  const r1 = await call('/api/pay/refund', as('pebblet'), { id: c.json.id });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.refunded, true);
  const r2 = await call('/api/pay/refund', as('pebblet'), { id: c.json.id });
  assert.equal(r2.json.refunded, true);
  assert.equal(refundsAt(c.json.id).length, 1, 'refunded once');
});

test('one order, one payment: the same checkout again reuses it, a new amount replaces it, a paid order refuses', async () => {
  const o = order({ reference: 'bud-once-1' });
  const a = await call('/api/pay/checkout', as('pebblet'), o), b = await call('/api/pay/checkout', as('pebblet'), o);
  assert.equal(b.json.id, a.json.id);
  const c = await call('/api/pay/checkout', as('pebblet'), { ...o, amount: 4595 });
  assert.notEqual(c.json.id, a.json.id);
  assert.equal((await call(`/api/pay/session?id=${a.json.id}`, as('pebblet'))).json.status, 'expired');
  await call(`${new URL(c.json.url).pathname}/pay`, { origin: 'https://hq.company.test' }, '');
  assert.equal((await call('/api/pay/checkout', as('pebblet'), o)).status, 409);
});

test('expire: an unpaid session can no longer be paid', async () => {
  const c = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-x-1' }));
  const e = await call('/api/pay/expire', as('pebblet'), { id: c.json.id });
  assert.equal(e.json.status, 'expired');
  assert.equal((await call(`${new URL(c.json.url).pathname}/pay`, { origin: 'https://hq.company.test' }, '')).status, 409);
});

test('live mode refuses without the board\'s approval, and without a live key', async () => {
  const live = as('pebblet', 'live');
  let r = await call('/api/pay/checkout', live, order({ success_url: 'https://pebblet.company.test/ok', cancel_url: 'https://pebblet.company.test/' }));
  assert.equal(r.status, 403);
  assert.match(r.json.error, /approval/);
  await approve('site:pebblet');
  r = await call('/api/pay/checkout', live, order({ success_url: 'https://pebblet.company.test/ok', cancel_url: 'https://pebblet.company.test/' }));
  assert.equal(r.status, 403, 'a site-only approval takes no money');
  await approve('live:pebblet');
  r = await call('/api/pay/checkout', live, order({ success_url: 'https://pebblet.company.test/ok', cancel_url: 'https://pebblet.company.test/' }));
  assert.equal(r.status, 503, 'approved but no live key: no imitation in live mode');
  // a test key in the live slot is not a live key
  writeFileSync(`${DATA}/secrets/STRIPE_LIVE_RESTRICTED_KEY`, 'rk_test_abc123');
  r = await call('/api/pay/checkout', live, order({ success_url: 'https://pebblet.company.test/ok', cancel_url: 'https://pebblet.company.test/' }));
  assert.equal(r.status, 503);
  // approval for one product isn't approval for another
  assert.equal((await call('/api/pay/checkout', as('hello', 'live'), order())).status, 403);
});

test('with a test key: real HTTP to Stripe, the key only in the Authorization header, one refund per session', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const c = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-http-1' }));
  assert.equal(c.status, 200, c.text);
  assert.ok(seen.some(x => x.path === '/v1/checkout/sessions'));
  assert.ok(seen.every(x => x.auth === 'Bearer rk_test_abc123'));
  assert.ok(!c.text.includes('rk_test'), 'the key never goes back to the product');
  await call(`${new URL(c.json.url).pathname}/pay`, { origin: 'https://hq.company.test' }, '');
  const r = await call('/api/pay/refund', as('pebblet'), { id: c.json.id });
  assert.equal(r.json.refunded, true);
  // Stripe's errors come back as Stripe's message, never with the key
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_wrong999');
  const bad = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-http-2' }));
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'Stripe: Invalid API Key provided');
  // a live key in the test slot is refused before anything is sent
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_live_abc123');
  const n = seen.length;
  assert.equal((await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-http-3' }))).status, 503);
  assert.equal(seen.length, n);
  // ... and agents don't get it either (house rule 8: test keys only)
  const { testSecrets } = await import('./secrets.ts');
  assert.equal(testSecrets().STRIPE_RESTRICTED_KEY, undefined);
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  assert.equal(testSecrets().STRIPE_RESTRICTED_KEY, 'rk_test_abc123');
});

// A session's fee lookup runs on the side of its answer: a read after that lookup is answered, either the one that
// starts the next lookup (the last one found no fee) or the one with the fee kept
const feeAsks = () => seen.filter(x => x.path.startsWith('/v1/payment_intents/')).length;
const settlementOf = async (id: string) => {
  const s = (await call(`/api/pay/session?id=${id}`, as('pebblet'))).json;
  return [s.paid, s.fee, s.fee_currency, s.country];
};
async function settledRead(id: string) {
  const asks = feeAsks();
  for (let i = 0; i < 200; i++) {
    const read = await settlementOf(id);
    if (read[1] !== null || feeAsks() > asks + 1) return read;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`The fee lookup of ${id} never finished`);
}

test("a paid session reports Stripe's actual fee once its balance transaction has it, and the payer's country", async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const c = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-fee-1', amount: 499 }));
  assert.deepEqual(await settlementOf(c.json.id), [false, null, null, null]);
  await call(`${new URL(c.json.url).pathname}/pay`, { origin: 'https://hq.company.test' }, 'country=DE');
  feeLookup = 'refused';
  assert.deepEqual(await settledRead(c.json.id), [true, null, null, 'DE'], 'a refused lookup is an unknown fee, never a guess');
  feeLookup = 'unsettled';
  assert.deepEqual(await settledRead(c.json.id), [true, null, null, 'DE'], 'no balance transaction yet: unknown');
  feeLookup = null;
  assert.deepEqual(await settledRead(c.json.id), [true, 32, 'eur', 'DE'], "the imitation's 1.5% + €0.25 of €4.99");
  assert.deepEqual(await settlementOf(c.json.id), [true, 32, 'eur', 'DE'], 'a known fee is kept');
});

test("a territory's sale is charged only when the billing and card countries agree inside it, and released uncharged otherwise", async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  for (const countries of [[], ['nl'], ['NL', 'NL'], 'NL', ['NLD'], Array.from({ length: 31 }, (_, i) => `A${String.fromCharCode(65 + (i % 26))}`)]) {
    const refused = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-land-bad', countries }));
    assert.equal(refused.status, 400, JSON.stringify(countries));
  }
  const pay = (id: string, form: string) => call(`/pay/imitation/${id}/pay`, { origin: 'https://hq.company.test' }, form);
  const read = async (id: string) => (await call(`/api/pay/session?id=${id}`, as('pebblet'))).json;
  const decided = (id: string) => seen.filter(r => /^\/v1\/payment_intents\/[^/]+\/(capture|cancel)$/.test(r.path) && r.path.includes(intentOf(id))).map(r => r.path.split('/').at(-1));
  const intentOf = (id: string) => stripeSession(id).payment_intent;
  const sale = async (reference: string, countries: string[], form: string) => {
    const c = await call('/api/pay/checkout', as('pebblet'), order({ reference, amount: 499, countries }));
    assert.equal(c.status, 200, c.text);
    await pay(c.json.id, form);
    return c.json;
  };

  const nl = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-land-nl', amount: 499, countries: ['NL'] }));
  assert.deepEqual(nl.json.countries, ['NL']);
  const asked = new URLSearchParams(seen.filter(r => r.path === '/v1/checkout/sessions').at(-1)!.body);
  assert.equal(asked.get('payment_intent_data[capture_method]'), 'manual', 'Stripe only holds the payment');
  assert.equal(asked.get('billing_address_collection'), 'required');
  assert.deepEqual(stripeSession(nl.json.id).payment_method_types, ['card', 'link'],
    'cards alone (and Link, which no checkout can leave out): an iDEAL payment settles at once and could not be held');
  assert.match((await call(`/pay/imitation/${nl.json.id}`, {})).text, /name="country"[\s\S]*name="card_country"/);
  assert.equal((await read(nl.json.id)).status, 'open');
  await pay(nl.json.id, 'country=NL');
  const [first, second] = await Promise.all([read(nl.json.id), read(nl.json.id)]);
  assert.deepEqual([first.paid, second.paid, first.status, first.country], [true, true, 'complete', 'NL']);
  assert.deepEqual(decided(nl.json.id), ['capture'], 'two reads at once charge the hold once');
  const retry = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-land-nl', amount: 499, countries: ['NL'] }));
  assert.equal(retry.json.why, 'already_paid', retry.text);
  assert.equal((await call('/api/pay/refund', as('pebblet'), { id: nl.json.id })).json.refunded, true, 'a charged hold refunds as any payment');

  const outside = [
    ['bud-land-de', ['NL'], 'country=DE'],
    ['bud-land-card', ['NL'], 'country=NL&card_country=DE'],
    ['bud-land-uk', ['BE', 'NL'], 'country=GB'],
  ] as const;
  for (const [reference, countries, form] of outside) {
    const c = await sale(reference, [...countries], form);
    const released = await read(c.id);
    assert.deepEqual([released.paid, released.status, released.fee], [false, 'released', null], form);
    assert.deepEqual(decided(c.id), ['cancel'], form);
    assert.equal(payments.imitation('GET', `/v1/payment_intents/${intentOf(c.id)}`, new URLSearchParams()).status, 'canceled', 'nothing was charged');
    assert.equal((await call('/api/pay/refund', as('pebblet'), { id: c.id })).status, 409);
    assert.equal((await read(c.id)).status, 'released', 'a released hold stays released');
    assert.deepEqual(decided(c.id), ['cancel']);
  }
  const link = await sale('bud-land-link', ['NL'], 'country=NL&method=link');
  const linkDetails = payments.imitation('GET', `/v1/payment_intents/${intentOf(link.id)}`, new URLSearchParams()).latest_charge.payment_method_details;
  assert.deepEqual(linkDetails, { type: 'link', link: { country: 'NL' } });
  assert.equal((await read(link.id)).paid, true, 'Link uses its funding country');
  assert.deepEqual(decided(link.id), ['capture']);
  const be = await sale('bud-land-be', ['BE', 'NL'], 'country=BE&card_country=BE');
  assert.deepEqual([(await read(be.id)).paid, (await read(be.id)).country], [true, 'BE'], 'any country of the territory');

  // Stripe charged the hold, but the answer never came back: the next read records it without charging again
  const lost = await sale('bud-land-lost', ['NL'], 'country=NL');
  payments.imitation('POST', `/v1/payment_intents/${intentOf(lost.id)}/capture`, new URLSearchParams());
  assert.equal((await read(lost.id)).paid, true);
  assert.deepEqual(decided(lost.id), []);
});

test('a fee lookup Stripe sits on never holds up the paid session', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const c = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-fee-2', amount: 499 }));
  await call(`${new URL(c.json.url).pathname}/pay`, { origin: 'https://hq.company.test' }, '');
  feeLookup = 'held';
  const stalled = new Promise(r => setTimeout(() => r('stalled'), 2000).unref());
  const first = await Promise.race([settlementOf(c.json.id), stalled]);
  await until(() => heldFees.length, 'Stripe holds the fee lookup');
  const second = await Promise.race([settlementOf(c.json.id), stalled]);
  feeLookup = null;
  heldFees.splice(0).forEach(answer => answer());
  assert.deepEqual([first, second], [[true, null, null, 'NL'], [true, null, null, 'NL']], 'paid, answered while Stripe holds the fee');
  assert.deepEqual(await settledRead(c.json.id), [true, 32, 'eur', 'NL']);
});

const readyOf = async (slug: string, mode: string) => { const r = await call('/api/pay/ready', as(slug, mode)); return r.status === 200 ? r.json.ready : r.status; };
const ready = (mode: string) => readyOf('readyshop', mode);
const liveKey = (key: string) => writeFileSync(`${DATA}/secrets/STRIPE_LIVE_RESTRICTED_KEY`, key);
const printerKeys = (id: string, key: string) => { writeFileSync(`${DATA}/secrets/PRINTAPI_LIVE_CLIENT_ID`, id); writeFileSync(`${DATA}/secrets/PRINTAPI_LIVE_CLIENT_SECRET`, key); };
const noPrinterKeys = () => { for (const k of ['CLIENT_ID', 'CLIENT_SECRET']) rmSync(`${DATA}/secrets/PRINTAPI_LIVE_${k}`, { force: true }); };

test('ready: test mode always; live mode with a usable live key whose account takes charges, asked of Stripe once a while', async () => {
  assert.equal(await ready('test'), true, 'test mode: Stripe\'s test mode or the imitation');
  assert.equal(await ready('live'), 403, "live: the board's launch approval first");
  await approve('live:readyshop');
  printerKeys('LIVE-ID', 'LIVE-SECRET'); // Print API's side is in (its own test below)
  rmSync(`${DATA}/secrets/STRIPE_LIVE_RESTRICTED_KEY`, { force: true });
  assert.equal(await ready('live'), false, 'no live key');
  liveKey('rk_test_abc123');
  assert.equal(await ready('live'), false, 'a test key in the live slot');
  liveKey('rk_live_mayread1');
  assert.equal(await ready('live'), false, "Stripe hasn't activated the account yet");
  chargesEnabled = true;
  assert.equal(await ready('live'), false, 'the same key within a few minutes: the answer Stripe gave');
  liveKey('rk_live_noread1');
  assert.equal(await ready('live'), false, "a key that may not read the account: no word that it takes charges");
  liveKey('rk_live_mayread1');
  assert.equal(await ready('live'), true, 'the account takes charges');
  liveKey('rk_live_revoked1');
  assert.equal(await ready('live'), false, "a key Stripe doesn't take");
  rmSync(`${DATA}/secrets/STRIPE_LIVE_RESTRICTED_KEY`, { force: true });
});

test('ready: live mode also needs live Print API keys that Print API takes', async () => {
  liveKey('rk_live_mayread1'); // Stripe's side is in (the test above)
  noPrinterKeys();
  assert.equal(await ready('live'), false, 'no live Print API keys: a paid basket could never go to the printer');
  printerKeys('LIVE-ID', 'MISTYPED');
  assert.equal(await ready('live'), false, "keys Print API refuses");
  printerBusy = true;
  printerKeys('LIVE-ID', 'NEW-SECRET');
  assert.equal(await ready('live'), 500, 'Print API busy: no answer, not a no');
  printerBusy = false;
  assert.equal(await ready('live'), true, 'asked again at once, and Print API takes them');
  rmSync(`${DATA}/secrets/STRIPE_LIVE_RESTRICTED_KEY`, { force: true });
  noPrinterKeys();
});

test('an approval card grants live:<slug> or site:<slug>, for one product or several, shown with their shelves, and only Approve records it', async () => {
  const job = await h.start({ agent: 'bolt' });
  for (const bad of [{ kind: 'decision', approves: 'live:hello' }, { approves: 'live:../x' }, { approves: 'shop:hello' }, { approves: 'site:../x' }])
    assert.equal((await h.agent('request', job.token, { kind: 'approval', title: 't', body: 'b', ...bad })).status, 400, JSON.stringify(bad));
  const shown = async (id: number) => (await h.board('/api/requests')).body.find((c: any) => c.id === id);
  const launch = await h.ask(job, { kind: 'approval', approves: 'live:hello' });
  assert.ok((await shown(launch)).grants.includes('www.company.test/hello/'), 'its shelf');
  await h.answer(launch, 'yes, go');
  assert.equal(await readyOf('hello', 'live'), 403, 'a typed yes is not an approval');
  await h.answer(await h.ask(job, { kind: 'approval', approves: 'live:hello' }), '', { approve: true });
  assert.notEqual(await readyOf('hello', 'live'), 403);
  // site:<slug>: the public site alone, ordering closed; described as such, and it grants nothing else
  const site = await h.ask(job, { kind: 'approval', approves: 'site:plum' });
  assert.ok((await shown(site)).grants.includes('www.company.test/plum/'), 'its shelf');
  assert.match((await shown(site)).grants, /no orders and no money/);
  await h.answer(site, '', { approve: true });
  assert.equal(await readyOf('plum', 'live'), 403, 'the site approval is not a launch');
  // several products on one card: each one's shelf, and Approve records each one's grant alone
  for (const bad of ['site:fig,../x', 'site:fig,', 'site:fig,pear,live:x'])
    assert.equal((await h.agent('request', job.token, { kind: 'approval', title: 't', body: 'b', approves: bad })).status, 400, bad);
  const four = await h.ask(job, { kind: 'approval', approves: 'site:fig,pear,quince' });
  assert.match((await shown(four)).grants, /the websites of fig, pear and quince up for the public at www\.company\.test\/fig\/, www\.company\.test\/pear\/ and www\.company\.test\/quince\/,/);
  await h.answer(four, '', { approve: true });
  const { approved } = await import('./approvals.ts');
  for (const slug of ['fig', 'pear', 'quince']) assert.equal(approved(`site:${slug}`)?.request, four, slug);
  assert.equal(approved('site:fig,pear,quince'), null, 'no record under the card\'s own grant');
  assert.equal(approved('live:fig'), null);
  await h.finish(job);
});

// a paid line out of the shop's parcel, before it is refunded (parcels.ts)
const outOfParcel = async (slug: string, line: string) => assert.equal((await call('/api/pay/parcel/cancel', as(slug), { line })).status, 200);
const payPage = (url: string) => call(`${new URL(url).pathname}/pay`, { origin: 'https://hq.company.test' }, '');

test('one order, one payment, also for two checkouts at the same moment (a double click)', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const o = order({ reference: 'bud-double-1' });
  slowCreate = 150;   // Stripe takes its time, so the second click arrives while the first is still opening the session
  const [a, b] = await Promise.all([call('/api/pay/checkout', as('pebblet'), o), call('/api/pay/checkout', as('pebblet'), o)]);
  slowCreate = 0;
  assert.equal(a.status, 200, a.text);
  assert.equal(b.json.id, a.json.id);
  assert.equal(seen.filter(x => x.path === '/v1/checkout/sessions' && x.body.includes('bud-double-1')).length, 1, 'one session at Stripe');
});

test('a create whose answer got lost comes back as the same session, also when the retry is in the next minute', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const o = order({ reference: 'bud-lost-1' }), realNow = Date.now;
  loseCreate = true;
  assert.notEqual((await call('/api/pay/checkout', as('pebblet'), o)).status, 200);
  assert.ok(lostId, 'Stripe made a session');
  Date.now = () => realNow() + 90_000;
  try {
    const c = await call('/api/pay/checkout', as('pebblet'), o);
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.id, lostId);
  } finally { Date.now = realNow; }
});

test('a session Stripe no longer knows (a new key, or a restart of the imitation before it kept them) counts as expired, not as an error', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  // (made before the imitation restarted: no route makes a session Stripe then forgets)
  const now = new Date().toISOString();
  db.prepare("insert into payments (id, created, product, mode, reference, amount, currency, status, updated) values ('cs_test_gone1', ?, 'pebblet', 'test', 'bud-gone-1', 3995, 'eur', 'open', ?)").run(now, now);
  const c = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-gone-1' }));
  assert.equal(c.status, 200, c.text);
  assert.notEqual(c.json.id, 'cs_test_gone1');
  assert.equal(db.prepare("select status from payments where id = 'cs_test_gone1'").get()?.status, 'expired', "HQ's record of it");
});

test('a refund counts only once Stripe says it succeeded; a failed one is reported and can be tried again', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const c = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-refund-1' }));
  await payPage(c.json.url);
  refundScript = ['pending', 'failed'];
  const r1 = await call('/api/pay/refund', as('pebblet'), { id: c.json.id });
  assert.deepEqual([r1.status, r1.json.refunded, r1.json.refund_status], [200, false, 'pending']);
  const s1 = await call(`/api/pay/session?id=${c.json.id}`, as('pebblet'));
  assert.deepEqual([s1.json.refunded, s1.json.refund_status], [false, 'failed'], 'the session check reads the refund again');
  const r2 = await call('/api/pay/refund', as('pebblet'), { id: c.json.id });
  assert.deepEqual([r2.json.refunded, r2.json.refund_status], [true, 'succeeded']);
  const posts = seen.filter(x => x.path === '/v1/refunds');
  assert.notEqual(posts.at(-1)!.idem, posts.at(-2)!.idem, 'a new idempotency key after the failed refund');
  const r3 = await call('/api/pay/refund', as('pebblet'), { id: c.json.id });
  assert.equal(r3.json.refunded, true);
  assert.equal(seen.filter(x => x.path === '/v1/refunds').length, posts.length, 'no third refund');
});

test("a product's own domain is a return address only while it's live, and never HQ's or another product's", async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const to = (host: string, ref: string) => order({ reference: ref, success_url: `https://${host}/ok`, cancel_url: `https://${host}/` });
  await approve('live:pebblet');
  let n = 0;
  for (const domain of ['hq.company.test', 'hello.preview.company.test', 'hello.company.test', 'company.test', 'a.b.company.test']) {
    manifest('pebblet', `status: live\npartner_env: live\ndomain: ${domain}\n`);
    assert.equal((await call('/api/pay/checkout', as('pebblet'), to(domain, `bud-dom-${n++}`))).status, 400, domain);
  }
  manifest('pebblet', 'status: live\npartner_env: live\ndomain: pebblet.shop\n');
  assert.equal((await call('/api/pay/checkout', as('pebblet'), to('pebblet.shop', 'bud-dom-ok'))).status, 200);
  manifest('pebblet', 'status: live\npartner_env: test\ndomain: pebblet.shop\n');
  assert.equal((await call('/api/pay/checkout', as('pebblet'), to('pebblet.shop', 'bud-dom-testp'))).status, 400, 'not live on test partners');
  manifest('pebblet', 'status: preview\ndomain: pebblet.shop\n');
  assert.equal((await call('/api/pay/checkout', as('pebblet'), to('pebblet.shop', 'bud-dom-prev'))).status, 400);
  manifest('plum', 'status: live\npartner_env: live\ndomain: plum.shop\n');
  assert.equal((await call('/api/pay/checkout', as('plum'), to('plum.shop', 'plum-dom-1'))).status, 400, 'not approved (site:plum, recorded above, takes no orders)');
  // two manifests naming one domain: products.py serves it for neither, so neither may return there
  manifest('pebblet', 'status: live\npartner_env: live\ndomain: pebblet.shop\n');
  manifest('plum', 'status: preview\ndomain: pebblet.shop\n');
  assert.equal((await call('/api/pay/checkout', as('pebblet'), to('pebblet.shop', 'bud-dom-claimed'))).status, 400, 'claimed twice');
  manifest('plum', 'status: preview\ndomain: null\n');
});

test("a shelf is a return address on its own path only, read as Caddy routes it, and on www only while the product is public", async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  let n = 0;
  const status = async (slug: string, url: string) =>
    (await call('/api/pay/checkout', as(slug), order({ reference: `shelf-${n++}`, success_url: url, cancel_url: url }))).status;
  manifest('pebblet', 'status: live\npartner_env: live\n');   // live:pebblet is recorded above
  manifest('plum', 'status: preview\n');
  for (const url of ['https://www.company.test/pebblet/', 'https://www.company.test/pebblet/ok?order=1',
                     'https://front.preview.company.test/pebblet/ok', 'https://www.company.test/pebblet/a/../b'])
    assert.equal(await status('pebblet', url), 200, url);
  for (const url of ['https://www.company.test/', 'https://www.company.test/pebblet', 'https://www.company.test/pebbletx/',
                     'https://www.company.test/plum/', 'https://www.company.test/pebblet/../plum/', 'https://www.company.test/pebblet/%2e%2e/plum/',
                     'https://www.company.test/pebblet/..%2fplum/', 'https://www.company.test/pebblet/%2E%2E%2Fplum/', 'https://www.company.test/pebblet/x/..%2f..%2fplum/',
                     'https://www.company.test/pebblet/%zz', 'https://www.company.test/PEBBLET/', 'https://www.company.test/pebblet\\..\\plum/',
                     'http://www.company.test/pebblet/', 'https://front.company.test/pebblet/', 'https://hq.company.test/pebblet/'])
    assert.equal(await status('pebblet', url), 400, url);
  assert.equal(await status('plum', 'https://www.company.test/plum/'), 400, 'a preview has no shelf on www');
  assert.equal(await status('plum', 'https://front.preview.company.test/plum/ok'), 200, "but one on the front's preview door");
  await approve('site:plum');
  manifest('plum', 'status: live\n');
  assert.equal(await status('plum', 'https://www.company.test/plum/ok'), 200, 'public with the site record');
  manifest('plum', 'status: preview\nplatform: true\n');
  assert.equal(await status('plum', 'https://front.preview.company.test/plum/ok'), 400, "the platform's own pieces are no shelf");
  manifest('plum', 'status: preview\ndomain: null\n');
  // the front's own domain carries the shelves too, while the front is public there
  manifest('front', 'status: preview\ndomain: front.shop\n');
  assert.equal(await status('pebblet', 'https://front.shop/pebblet/ok'), 400, 'not while the front is a preview');
  manifest('front', 'status: live\ndomain: front.shop\n');
  assert.equal(await status('pebblet', 'https://front.shop/pebblet/ok'), 400, 'not before the board approves the front');
  await approve('site:front');
  assert.equal(await status('pebblet', 'https://front.shop/pebblet/ok'), 200, "a shelf on the front's own domain");
  assert.equal(await status('pebblet', 'https://front.shop/plum/'), 400, 'on its own path only');
  rmSync(`${repo}/products/front`, { recursive: true });
});

// ---- what a checkout offers, in which language, for which email
const created = (ref: string) => seen.filter(x => x.path === '/v1/checkout/sessions' && x.body.includes(ref)).map(x => new URLSearchParams(x.body));
const offered = (p: URLSearchParams) => [...p].filter(([k]) => k.startsWith('payment_method_types[')).map(([, v]) => v);
const excluded = (p: URLSearchParams) => [...p].filter(([k]) => k.startsWith('excluded_payment_method_types[')).map(([, v]) => v);
const settings = (methods: string | null) => {
  mkdirSync(`${repo}/company`, { recursive: true });
  writeFileSync(`${repo}/company/infra.env`, methods === null ? '' : `# test\nPAYMENT_METHODS=${methods}\n`);
};
const logged = (like: string) => (db.prepare("select count(*) n from events where type = 'log' and text like ?").get(`%${like}%`) as any).n;

test("a checkout leaves out every method it can but the setting's immediate ones, and the shop names those", async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  manifest('pebblet', 'status: preview\n');
  settings('ideal, Bancontact,sepa_debit,card,sofort,ideal');
  const c = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-pm-1' }));
  assert.equal(c.status, 200, c.text);   // Stripe refuses payment_method_types now (its 400, 2026-10-06), and so does the stand-in
  const p = created('bud-pm-1')[0];
  assert.deepEqual(offered(p), []);
  assert.deepEqual(excluded(p), payments.EXCLUDABLE.filter(m => !['card', 'ideal', 'bancontact'].includes(m)));
  assert.ok(excluded(p).includes('klarna') && excluded(p).includes('sepa_debit') && !excluded(p).includes('link'));
  const s = stripeSession(c.json.id);
  assert.deepEqual(s.payment_method_types, ['card', 'ideal', 'bancontact', 'link'], 'the dashboard had klarna, eps and more on');
  assert.equal(logged('checkout offered'), 0, 'link is the dashboard\'s: not reported');
  const named = async (slug = 'pebblet', mode = 'test') => { const r = await call('/api/pay/methods', as(slug, mode)); assert.equal(r.status, 200, r.text); return r.json.methods; };
  assert.equal((await call('/api/pay/methods', as('pebblet', 'test', payments.tokenFor('hello', 'test')))).status, 401);
  assert.equal((await call('/api/pay/methods', as('unlaunched', 'live'))).status, 403, "live: the board's launch approval first");
  assert.deepEqual(await named(), ['card', 'ideal', 'bancontact']);
  assert.equal(logged('"sepa_debit", which doesn'), 1);
  await named();
  assert.equal(logged('"sepa_debit", which doesn'), 1, 'logged once, not on every ask');
  // a product's own list replaces the company's ([]: cards only)
  for (const [own, methods] of [['[eps, customer_balance]', ['card', 'eps']], ['wero', ['card', 'wero']], ['[]', ['card']]] as const) {
    manifest('pebblet', `status: preview\npayment_methods: ${own}\n`);
    assert.deepEqual(await named(), methods, own);
  }
  manifest('pebblet', 'status: preview\n');
  settings(null);
  assert.deepEqual(await named(), ['card'], 'no setting: cards only');
  const cards = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-pm-2' }));
  assert.equal(cards.status, 200, cards.text);
  assert.ok(excluded(created('bud-pm-2')[0]).includes('ideal'), "cards only: iDEAL left out too, card isn't");
  assert.ok(!excluded(created('bud-pm-2')[0]).includes('card'));
  const again = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-pm-1' }));
  assert.equal(again.status, 200, again.text);
  assert.notEqual(again.json.id, c.json.id, 'the session opened with iDEAL is closed, not handed out again');
  // and the other way: a cards-only session isn't handed out once the shop names iDEAL and Bancontact
  settings('ideal,bancontact');
  const wider = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-pm-2' }));
  assert.equal(wider.status, 200, wider.text);
  assert.notEqual(wider.json.id, cards.json.id, 'the cards-only session is closed');
  const w = stripeSession(wider.json.id);
  assert.deepEqual(w.payment_method_types, ['card', 'ideal', 'bancontact', 'link']);
  assert.equal((await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-pm-2' }))).json.id, wider.json.id, 'unchanged: handed out again');
});

test('a method Stripe switches on after the list was read is reported once, and the checkout goes on', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  settings('ideal,bancontact');
  addedMethod = 'new_pay';
  try {
    for (const ref of ['bud-new-1', 'bud-new-2']) {
      const c = await call('/api/pay/checkout', as('pebblet'), order({ reference: ref }));
      assert.equal(c.status, 200, c.text);
    }
  } finally { addedMethod = ''; }
  assert.equal(logged('checkout offered "new_pay"'), 1, 'once per method, for the owner');
});

test("a named method Stripe takes out of a session is logged for each checkout, and the session says what HQ named", async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  settings('ideal,bancontact');
  const ok = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-drop-0', locale: 'nl' }));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(stripeSession(ok.json.id).metadata.named, 'card ideal bancontact', "what the status report shows beside Stripe's offer");
  assert.equal(logged('without '), 0, 'every named method offered: nothing logged');
  droppedMethod = 'ideal';
  try {
    for (const ref of ['bud-drop-1', 'bud-drop-2']) {
      const c = await call('/api/pay/checkout', as('pebblet'), order({ reference: ref, locale: 'en' }));
      assert.equal(c.status, 200, c.text);
    }
  } finally { droppedMethod = ''; }
  assert.equal(logged('(locale en) offers card, bancontact, link, without ideal, which its settings name'), 2, 'once per checkout: each is a buyer without iDEAL');
});

test("the imitation takes the methods to leave out as Stripe does: never link, nor a name it doesn't know", () => {
  const ask = (...out: string[]) => {
    const p = new URLSearchParams({ mode: 'payment', success_url: 'https://x.test/ok', cancel_url: 'https://x.test/no', 'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'eur', 'line_items[0][price_data][unit_amount]': '500', 'line_items[0][price_data][product_data][name]': 'x' });
    out.forEach((m, i) => p.append(`excluded_payment_method_types[${i}]`, m));
    return payments.imitation('POST', '/v1/checkout/sessions', p);
  };
  for (const bad of ['link', 'wero', 'nope'])
    assert.throws(() => ask('klarna', bad), (e: any) => e.status === 400, bad);
  assert.deepEqual(ask().payment_method_types, ['card', 'ideal', 'bancontact', 'eps', 'klarna', 'link', 'mb_way', 'amazon_pay', 'satispay']);
  assert.deepEqual(ask('klarna', 'mb_way', 'card').payment_method_types, ['ideal', 'bancontact', 'eps', 'link', 'amazon_pay', 'satispay']);
});

test('the page in the language asked, with the email typed once; a changed one opens a new session', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  settings('ideal,bancontact');
  for (const bad of [{ locale: 'xx' }, { locale: 'NL' }, { locale: 3 }, { customer_email: 'not an address' }, { customer_email: 'a@b' }]) {
    const r = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-loc-bad', ...bad }));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const o = order({ reference: 'bud-loc-1', locale: 'nl', customer_email: ' ouder@example.nl ' });
  const a = await call('/api/pay/checkout', as('pebblet'), o);
  assert.equal(a.status, 200, a.text);
  const p = created('bud-loc-1')[0];
  assert.deepEqual([p.get('locale'), p.get('customer_email')], ['nl', 'ouder@example.nl']);
  assert.equal((await call('/api/pay/checkout', as('pebblet'), o)).json.id, a.json.id, 'the same again: the same session');
  const b = await call('/api/pay/checkout', as('pebblet'), { ...o, locale: 'de' });
  assert.notEqual(b.json.id, a.json.id);
  assert.equal((await call(`/api/pay/session?id=${a.json.id}`, as('pebblet'))).json.status, 'expired');
  const e = await call('/api/pay/checkout', as('pebblet'), { ...o, locale: 'de', customer_email: 'other@example.nl' });
  assert.notEqual(e.json.id, b.json.id);
  // without either: Stripe's own default (auto), and no email
  await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-loc-2' }));
  const q = created('bud-loc-2')[0];
  assert.deepEqual([q.get('locale'), q.has('customer_email')], ['auto', false]);
});

test('the imitation offers the same methods, in the language asked, with the email filled in; refunds work the same', async () => {
  rmSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, { force: true });
  settings('ideal,bancontact');
  try {
    const c = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-imi-nl', locale: 'nl', customer_email: 'ouder@example.nl' }));
    assert.equal(c.status, 200, c.text);
    const page = (await call(new URL(c.json.url).pathname, {})).text;
    assert.match(page, /<html lang="nl">/);
    for (const m of ['card', 'ideal', 'bancontact']) assert.match(page, new RegExp(`name="method" value="${m}"`));
    assert.match(page, /value="ouder@example\.nl" readonly/);
    const paid = await call(`${new URL(c.json.url).pathname}/pay`, { origin: 'https://hq.company.test' }, 'method=ideal&email=someone-else@example.com');
    assert.equal(paid.status, 303);
    const s = stripeSession(c.json.id);
    assert.equal(s.customer_details.email, 'ouder@example.nl', "the shop's address is the one paid with");
    assert.equal((await call(`/api/pay/session?id=${c.json.id}`, as('pebblet'))).json.paid, true);
    const r = await call('/api/pay/refund', as('pebblet'), { id: c.json.id });
    assert.deepEqual([r.json.refunded, r.json.refund_status], [true, 'succeeded']);
    // auto: the browser's language; one we have no words for: English
    const d = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-imi-auto' }));
    assert.match((await call(new URL(d.json.url).pathname, { 'accept-language': 'de-DE,de;q=0.9' })).text, /<html lang="de">/);
    assert.match((await call(new URL(d.json.url).pathname, { 'accept-language': 'fi' })).text, /<html lang="en">/);
  } finally { writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123'); }
});

// ---- one basket
const shopUrl = (path: string) => `https://front.preview.company.test${path}`;
const ADDRESS = { name: 'Sanne de Vries', line1: 'Lindelaan 12', postCode: '1234 ab', city: 'Utrecht', country: 'NL' };
const front = () => as('front');
function shop(saved = 400) {
  manifest('front', `name: The shop\nstatus: preview\nbasket:\n  countries: [NL, BE]\n  postage_saved: {NL: ${saved}, BE: 600}\n`);
  manifest('pebblet', 'name: Pebblet\nstatus: preview\n');
  manifest('hello', 'name: Hello\nstatus: preview\n');
}
const line = (slug: string, reference: string, over: Record<string, unknown> = {}) =>
  call('/api/pay/line', as(slug), { reference, amount: 3995, description: `${slug} poster`, order_url: `https://${slug}.preview.company.test/order/${reference}`, ...over });
async function basketOf(...lines: { line: string; claim: string }[]) {
  let basket: string | undefined;
  for (const l of lines) {
    const r = await call('/api/pay/basket/add', front(), { basket, line: l.line, claim: l.claim });
    assert.equal(r.status, 200, r.text);
    basket = r.json.basket;
  }
  return basket!;
}
const checkoutOf = (basket: string, over: Record<string, unknown> = {}) => call('/api/pay/basket/checkout', front(),
  { basket, deliver_to: ADDRESS, email: 'sanne@example.com', locale: 'nl', success_url: shopUrl('/order-done/?session={CHECKOUT_SESSION_ID}'),
    cancel_url: shopUrl('/checkout/'), ...over });
const sessionStatus = (id: string) => stripeSession(id).status;

test('one basket, two products: one session, each product sees its own line paid, with the address once', async () => {
  shop();
  const a = await line('pebblet', 'peb-basket-1'), b = await line('hello', 'hel-basket-1', { amount: 2495 });
  assert.equal(a.status, 200, a.text);
  assert.equal((await line('hello', 'hel-basket-2', { order_url: null })).status, 400, 'the confirmation email links every line\'s order page');
  assert.deepEqual([a.json.status, a.json.deliver_to, a.json.email], ['open', null, null]);
  const basket = await basketOf(a.json, b.json);
  const view = await call(`/api/pay/basket?id=${basket}&country=NL`, front());
  assert.deepEqual(view.json.lines.map((l: any) => [l.shop, l.card, l.saved]), [['Pebblet', 3995, 0], ['Hello', 2095, 400]]);
  assert.deepEqual([view.json.total, view.json.saved], [6090, 400]);
  const c = await checkoutOf(basket);
  assert.equal(c.status, 200, c.text);
  assert.equal((await checkoutOf(basket)).json.id, c.json.id, 'the same basket and address: the same session');
  assert.match((await call(new URL(c.json.url).pathname, {})).text, /€60\.90/);
  assert.equal((await line('pebblet', 'peb-basket-1')).json.status, 'checkout');
  assert.equal((await payPage(c.json.url)).status, 303);
  const paidA = await call(`/api/pay/line?id=${a.json.line}`, as('pebblet')), paidB = await call(`/api/pay/line?id=${b.json.line}`, as('hello'));
  assert.deepEqual([paidA.json.status, paidA.json.card, paidB.json.status, paidB.json.card], ['paid', 3995, 'paid', 2095]);
  assert.deepEqual(paidA.json.deliver_to, { ...ADDRESS, postCode: '1234 AB' });
  assert.deepEqual(paidB.json.deliver_to, paidA.json.deliver_to);
  assert.deepEqual([paidA.json.email, paidA.json.lang], ['sanne@example.com', 'nl']);
  assert.equal((await call(`/api/pay/line?id=${a.json.line}`, as('hello'))).status, 404, 'a product sees only its own lines');
  assert.equal((await call(`/api/pay/basket?id=${basket}`, as('pebblet'))).status, 403, "baskets are the front's");
  const done = await call(`/api/pay/basket/order?id=${c.json.id}`, front());
  assert.deepEqual([done.json.paid, done.json.total, done.json.country, done.json.lines.length], [true, 6090, 'NL', 2]);
  assert.equal((await call('/api/pay/basket/add', front(), { basket, line: a.json.line, claim: a.json.claim })).status, 409, 'a paid line goes in no basket again');
  assert.equal((await line('pebblet', 'peb-basket-1', { amount: 4595 })).status, 409, 'a paid line keeps its price');
});

test("copies of a thing: each copy after the basket's first is €4 off as any extra thing, one item at Stripe, 20 things a basket", async () => {
  shop();
  manifest('front', 'name: The shop\nstatus: preview\nbasket:\n  countries: [NL, BE]\n  postage_saved: {NL: 400, BE: 600}\n  copies: 10\n');
  const a = await line('pebblet', 'peb-copies-1'), b = await line('hello', 'hel-copies-1', { amount: 2495 });
  const basket = await basketOf(a.json, b.json);
  const before = await call(`/api/pay/basket?id=${basket}&country=NL`, front());
  assert.deepEqual([before.json.copies, before.json.lines.map((l: any) => l.quantity)], [10, [1, 1]]);
  const two = await call('/api/pay/basket/quantity', front(), { basket, line: a.json.line, quantity: 2, country: 'NL' });
  assert.equal(two.status, 200, two.text);
  assert.deepEqual(two.json.lines.map((l: any) => [l.shop, l.quantity, l.amount, l.card, l.saved]),
    [['Pebblet', 2, 3995, 7590, 400], ['Hello', 1, 2495, 2095, 400]], 'three things: two of them €4 off');
  assert.deepEqual([two.json.total, two.json.saved], [9685, 800]);
  const stale = await checkoutOf(basket, { revision: before.json.revision });
  assert.deepEqual([stale.status, stale.json.why], [409, 'basket_changed'], 'a page that showed one copy never pays for two');
  for (const quantity of [0, 11, 1.5, '2'])
    assert.equal((await call('/api/pay/basket/quantity', front(), { basket, line: a.json.line, quantity })).status, 400);
  assert.equal((await call('/api/pay/basket/quantity', front(), { basket: 'bk_' + '0'.repeat(32), line: a.json.line, quantity: 2 })).json.why, 'basket_gone');

  // 20 things a basket, each copy counted
  assert.equal((await call('/api/pay/basket/quantity', front(), { basket, line: a.json.line, quantity: 10 })).status, 200);
  assert.equal((await call('/api/pay/basket/quantity', front(), { basket, line: b.json.line, quantity: 10 })).status, 200);
  const c = await line('hello', 'hel-copies-2');
  const full = await call('/api/pay/basket/add', front(), { basket, line: c.json.line, claim: c.json.claim });
  assert.deepEqual([full.status, full.json.why], [409, 'basket_full']);
  assert.equal((await call('/api/pay/basket/quantity', front(), { basket, line: b.json.line, quantity: 1 })).status, 200);
  assert.equal((await call('/api/pay/basket/add', front(), { basket, line: c.json.line, claim: c.json.claim })).status, 200);
  const over = await call('/api/pay/basket/quantity', front(), { basket, line: b.json.line, quantity: 10 });
  assert.deepEqual([over.status, over.json.why], [409, 'basket_full']);
  await call('/api/pay/basket/remove', front(), { basket, line: c.json.line });
  assert.equal((await call('/api/pay/basket/quantity', front(), { basket, line: a.json.line, quantity: 2 })).status, 200);

  const paying = await checkoutOf(basket);
  assert.equal(paying.status, 200, paying.text);
  assert.deepEqual(stripeSession(paying.json.id).items.map((i: any) => [i.name, i.amount]),
    [['2 × Pebblet: pebblet poster', 7590], ['Hello: hello poster', 2095]], 'a line of copies is one item at its whole price');
  assert.equal((await payPage(paying.json.url)).status, 303);
  const paid = await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'));
  assert.deepEqual([paid.json.status, paid.json.quantity, paid.json.card], ['paid', 2, 7590], 'the stall sees its copies');
  const done = await call(`/api/pay/basket/order?id=${paying.json.id}`, front());
  assert.deepEqual(done.json.lines.map((l: any) => [l.quantity, l.card]), [[2, 7590], [1, 2095]]);
  const late = await call('/api/pay/basket/quantity', front(), { basket, line: a.json.line, quantity: 3 });
  assert.deepEqual(late.json.lines.map((l: any) => l.quantity), [2, 1], 'a paid basket keeps its copies');
});

test("the copy that goes without the €4 is the one that loses least by it, so the basket's order never changes its saving", async () => {
  shop();
  manifest('front', 'name: The shop\nstatus: preview\nbasket:\n  countries: [NL, BE]\n  postage_saved: {NL: 400, BE: 600}\n  copies: 10\n');
  const seen = [];
  // 2 × 7.89 and 1 × 7.89: the single one keeps only half its price (3.94), so the pair's copy goes without
  for (const [tag, copies] of [['a', [2, 1]], ['b', [1, 2]]] as const) {
    const lines = [await line('pebblet', `peb-without-${tag}`, { amount: 789 }), await line('hello', `hel-without-${tag}`, { amount: 789 })];
    const basket = await basketOf(...lines.map(l => l.json));
    for (const [i, quantity] of copies.entries())
      if (quantity > 1) assert.equal((await call('/api/pay/basket/quantity', front(), { basket, line: lines[i].json.line, quantity })).status, 200);
    const view = (await call(`/api/pay/basket?id=${basket}&country=NL`, front())).json;
    seen.push([view.saved, view.lines.map((l: any) => [l.quantity, l.saved])]);
  }
  assert.deepEqual(seen, [[794, [[2, 400], [1, 394]]], [794, [[1, 394], [2, 400]]]]);
});

test("a line whose voucher pays more than one copy keeps its copies out of the basket: back in, or in another, with its voucher", async () => {
  shop();
  manifest('front', 'name: The shop\nstatus: preview\nbasket:\n  countries: [NL, BE]\n  postage_saved: {NL: 400, BE: 600}\n  copies: 10\n');
  payments.lineVoucher.push((_, reference) => (reference === 'peb-kept-1' ? 7590 : 'no such voucher'));
  try {
    const a = (await line('pebblet', 'peb-kept-1')).json, b = (await line('hello', 'hel-kept-1')).json;
    const basket = await basketOf(a, b);
    assert.equal((await call('/api/pay/basket/quantity', front(), { basket, line: a.line, quantity: 2 })).status, 200);
    const spent = await line('pebblet', 'peb-kept-1', { voucher: 31 });
    assert.equal(spent.json.voucher_value, 7590, spent.text);
    const lines = async (id: string) => (await call(`/api/pay/basket?id=${id}&country=NL`, front())).json.lines
      .map((l: any) => [l.shop, l.quantity, l.voucher_value, l.card]).sort();
    // two copies less the voucher leave 400, half of it the most saved; the tile saves the €4
    const before = [['Hello', 1, null, 3595], ['Pebblet', 2, 7590, 200]];
    assert.deepEqual(await lines(basket), before);
    await call('/api/pay/basket/remove', front(), { basket, line: a.line });
    const out = (await call(`/api/pay/line?id=${a.line}`, as('pebblet'))).json;
    assert.deepEqual([out.in_basket, out.quantity, out.voucher_value], [false, 2, 7590], 'out of the basket with the copies its voucher was spent on');
    assert.equal((await line('pebblet', 'peb-kept-1', { voucher: 31 })).json.voucher_value, 7590, 'registered again: the voucher stays');
    // a basket of 19 things has no room for its two
    const full = (await line('hello', 'hel-kept-2')).json, nine = (await line('hello', 'hel-kept-3')).json;
    const other = await basketOf(full, nine);
    for (const [l, quantity] of [[full, 10], [nine, 9]] as const)
      assert.equal((await call('/api/pay/basket/quantity', front(), { basket: other, line: l.line, quantity })).status, 200);
    const over = await call('/api/pay/basket/add', front(), { basket: other, line: a.line, claim: a.claim });
    assert.deepEqual([over.status, over.json.why], [409, 'basket_full']);
    // nor in the place of a one-copy line of its stall that has no voucher to pay it: refused, both as they were
    const one = (await line('pebblet', 'peb-kept-2')).json;
    assert.equal((await call('/api/pay/basket/add', front(), { basket, line: one.line, claim: one.claim })).status, 200);
    const instead = await call('/api/pay/basket/add', front(), { basket, line: a.line, claim: a.claim, replaces: one.line });
    assert.deepEqual([instead.status, instead.json.why], [409, 'voucher_copies'], instead.text);
    const kept = (await call(`/api/pay/line?id=${a.line}`, as('pebblet'))).json;
    assert.deepEqual([kept.in_basket, kept.quantity, kept.voucher_value], [false, 2, 7590]);
    assert.deepEqual(await lines(basket), [['Hello', 1, null, 3995], ['Pebblet', 1, null, 3595]]);
    await call('/api/pay/basket/remove', front(), { basket, line: one.line });
    assert.equal((await call('/api/pay/basket/add', front(), { basket, line: a.line, claim: a.claim })).status, 200);
    assert.deepEqual(await lines(basket), before, 'back in: its copies and its voucher, the card the rest');
    const moved = await call('/api/pay/basket/add', front(), { line: a.line, claim: a.claim });
    assert.equal(moved.status, 200, moved.text);
    assert.deepEqual(await lines(moved.json.basket), [['Pebblet', 2, 7590, 200]], 'in another basket too');
  } finally { payments.lineVoucher.pop(); }
});

test('a line goes in a basket only with its claim, and only in its own mode', async () => {
  shop();
  const a = await line('pebblet', 'peb-claim-1');
  assert.equal((await call('/api/pay/basket/add', front(), { line: a.json.line, claim: a.json.claim.replace(/^./, c => (c === '0' ? '1' : '0')) })).status, 404);
  assert.equal((await call('/api/pay/basket/add', front(), { line: a.json.line })).status, 404);
  await approve('live:front');
  assert.equal((await call('/api/pay/basket/add', as('front', 'live'), { line: a.json.line, claim: a.json.claim })).status, 404, 'a test line never joins a live basket');
});

test('a line that changes while its session is open ends that session; a cancelled or removed one too', async () => {
  shop();
  const a = await line('pebblet', 'peb-change-1'), b = await line('hello', 'hel-change-1');
  const basket = await basketOf(a.json, b.json);
  const first = await checkoutOf(basket);
  const changed = await line('pebblet', 'peb-change-1', { amount: 4595 });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(sessionStatus(first.json.id), 'expired');
  const second = await checkoutOf(basket);
  assert.notEqual(second.json.id, first.json.id);
  assert.equal((await call(`/api/pay/basket?id=${basket}`, front())).json.total, 4595 + 3995 - 400);
  assert.equal((await call('/api/pay/line/cancel', as('hello'), { id: b.json.line })).json.status, 'cancelled');
  assert.equal(sessionStatus(second.json.id), 'expired');
  const left = await call(`/api/pay/basket?id=${basket}&country=NL`, front());
  assert.deepEqual([left.json.lines.length, left.json.dropped[0].why, left.json.total], [1, 'cancelled', 4595]);
  const third = await checkoutOf(basket);
  assert.equal((await call('/api/pay/basket/remove', front(), { basket, line: a.json.line })).json.lines.length, 0);
  assert.equal(sessionStatus(third.json.id), 'expired');
  assert.equal((await checkoutOf(basket)).status, 409, 'an empty basket has nothing to pay');
});

test("a product closing its ordering ends its open sessions, its basket's too; a paid one stays paid, another product's stays open", async () => {
  shop();
  const unpaid = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-close-1' }));
  const paid = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-close-2' }));
  await payPage(paid.json.url);
  const a = await line('pebblet', 'peb-close-1'), b = await line('hello', 'hel-close-1');
  const basket = await checkoutOf(await basketOf(a.json, b.json));
  const ended = await call('/api/pay/expire/open', as('pebblet'), {});
  assert.equal(ended.status, 200, ended.text);
  assert.ok(ended.json.expired >= 1);
  assert.equal(sessionStatus(unpaid.json.id), 'expired');
  assert.equal((await payPage(unpaid.json.url)).status, 409, 'it can no longer be paid');
  assert.equal((await call(`/api/pay/session?id=${paid.json.id}`, as('pebblet'))).json.paid, true);
  assert.equal(sessionStatus(basket.json.id), 'open', "the shop's basket is the front's to close");
  assert.ok((await call('/api/pay/expire/open', front(), {})).json.expired >= 1);
  assert.equal(sessionStatus(basket.json.id), 'expired');
  assert.equal((await payPage(basket.json.url)).status, 409);
  assert.equal((await line('pebblet', 'peb-close-1')).json.status, 'open', 'its lines are open again, for when ordering opens');
  assert.deepEqual((await call('/api/pay/expire/open', front(), {})).json, { expired: 0 });
  // (to the test's end)
  assert.equal(payments.orderingClosed('pebblet'), false, "a test-mode closing isn't the live product's word");
  await approve('live:pebblet');
  assert.equal((await call('/api/pay/expire/open', as('pebblet', 'live'), {})).status, 200);
  assert.equal(payments.orderingClosed('pebblet'), true, 'in live mode, HQ\'s watch checks its pages alone');
  assert.equal(payments.orderingClosed('pebblet', Date.now() + payments.CLOSED_MS), false, 'until it stops saying so');
});

test("a checkout sent with the revision its page showed is refused once the basket differs: its lines, or another country's prices", async () => {
  shop();
  const a = await line('pebblet', 'peb-rev-1'), b = await line('hello', 'hel-rev-1', { amount: 2495 });
  const basket = await basketOf(a.json);
  const shown = (await call(`/api/pay/basket?id=${basket}&country=NL`, front())).json.revision;
  assert.match(shown, /^[a-f0-9]{16}$/);
  await call('/api/pay/basket/add', front(), { basket, line: b.json.line, claim: b.json.claim });   // another tab
  const stale = await checkoutOf(basket, { revision: shown });
  assert.deepEqual([stale.status, stale.json.why], [409, 'basket_changed'], 'never a payment for a basket the page didn\'t show');
  const now = (await call(`/api/pay/basket?id=${basket}&country=NL`, front())).json;
  assert.notEqual(now.revision, shown);
  assert.deepEqual([(await checkoutOf(basket, { revision: now.revision, deliver_to: { ...ADDRESS, country: 'BE' } })).json.why], ['basket_changed'],
    "the Netherlands' total shown, Belgium's to pay");
  const paid = await checkoutOf(basket, { revision: now.revision });
  assert.equal(paid.status, 200, paid.text);
  assert.equal((await checkoutOf(basket)).status, 200, 'no revision: no check (a script, not the shop\'s page)');
});

test('a change after the customer paid is refused: the line is paid at the price its session charged', async () => {
  shop();
  const a = await line('pebblet', 'peb-late-1');
  const basket = await basketOf(a.json);
  const c = await checkoutOf(basket);
  await payPage(c.json.url);   // paid at Stripe; nobody has read the session yet
  const late = await line('pebblet', 'peb-late-1', { amount: 1995 });
  assert.equal(late.status, 409);
  const cancel = await call('/api/pay/line/cancel', as('pebblet'), { id: a.json.line });
  assert.equal(cancel.status, 409);
  const seen = await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'));
  assert.deepEqual([seen.json.status, seen.json.amount, seen.json.card], ['paid', 3995, 3995]);
});

test('refunds go per line: one line back, the other untouched, never twice, and never the whole basket', async () => {
  shop();
  const a = await line('pebblet', 'peb-refund-1'), b = await line('hello', 'hel-refund-1');
  const basket = await basketOf(a.json, b.json);
  const c = await checkoutOf(basket);
  await payPage(c.json.url);
  assert.equal((await call('/api/pay/line/refund', as('hello'), { id: a.json.line })).status, 404);
  assert.equal((await call('/api/pay/line/refund', as('hello'), { id: b.json.line })).status, 409, 'not while it is in its parcel');
  await outOfParcel('hello', b.json.line);
  const r = await call('/api/pay/line/refund', as('hello'), { id: b.json.line });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.refunded, r.json.card, r.json.description, r.json.deliver_to], [true, 3595, 'hello poster', null], 'a refund changes no clock: its words stay, its address is no longer handed out');
  assert.equal((await call('/api/pay/line/refund', as('hello'), { id: b.json.line })).json.refunded, true);
  assert.deepEqual(refundsAt(c.json.id).map((x: any) => [x.amount, x.metadata.line]), [[3595, b.json.line]]);
  const kept = (await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'))).json;
  assert.deepEqual([kept.refunded, kept.description, kept.deliver_to?.city], [false, 'pebblet poster', 'Utrecht']);
  assert.equal((await call('/api/pay/refund', front(), { id: c.json.id })).status, 409, "a basket's payment is refunded per line");
  await outOfParcel('pebblet', a.json.line);
  assert.equal((await call('/api/pay/line/refund', as('pebblet'), { id: a.json.line })).json.refunded, true);
  // (the table: the payment's delivery address, which no route shows once its lines are refunded)
  const deliver = () => (db.prepare('select deliver from payments where id = ?').get(c.json.id) as any).deliver;
  assert.ok(deliver(), 'every line refunded: the address stays as for a paid basket');
  await payments.tick(Date.now() + 15 * 864e5);
  assert.equal(deliver(), null, '14 days after the payment, refunded or not');
});

test('the shop takes the address once, for its own countries, and returns only to its own pages', async () => {
  shop();
  const a = await line('pebblet', 'peb-addr-1');
  const basket = await basketOf(a.json);
  for (const bad of [{ deliver_to: { ...ADDRESS, country: 'FR' } }, { deliver_to: { ...ADDRESS, name: '' } }, { deliver_to: { ...ADDRESS, city: 'x'.repeat(65) } },
    { email: 'nope' }, { success_url: shopUrl('/pebblet/thanks') }, { success_url: shopUrl('/Pebblet/thanks') }, { cancel_url: shopUrl('/x/..%2fpebblet/') },
    { success_url: 'https://www.company.test/order-done/' }])
    assert.equal((await checkoutOf(basket, bad)).status, 400, JSON.stringify(bad));
  const be = await checkoutOf(basket, { deliver_to: { ...ADDRESS, country: 'BE' } });
  assert.equal(be.status, 200, be.text);
  manifest('front', 'name: The shop\nstatus: live\nbasket:\n  countries: [NL]\n');
  assert.equal((await checkoutOf(basket, { success_url: 'https://www.company.test/order-done/' })).status, 200, "www's root, once the front is public");
});

test('a basket paid while nobody looks is settled by the timer, once; its address goes after 14 days', async () => {
  shop();
  const a = await line('pebblet', 'peb-tick-1');
  const basket = await basketOf(a.json);
  const c = await checkoutOf(basket);
  const heard: string[] = [];
  payments.basketPaid.push(pay => heard.push(pay.id));
  try {
    await payPage(c.json.url);
    await payments.tick();
    await payments.tick();
    assert.deepEqual(heard, [c.json.id]);
    assert.equal((await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'))).json.status, 'paid');
  } finally { payments.basketPaid.pop(); }
  await outOfParcel('pebblet', a.json.line);   // (a parcel still to be placed keeps it longer: parcels.test.ts)
  await payments.tick(Date.now() + 15 * 864e5);
  assert.equal((await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'))).json.deliver_to, null);
});

test("an unpaid checkout's address goes a day after the session ended, not at once", async () => {
  shop();
  const a = await line('pebblet', 'peb-unpaid-addr-1');
  const c = await checkoutOf(await basketOf(a.json));
  const deliver = () => (db.prepare('select deliver from payments where id = ?').get(c.json.id) as any).deliver;
  db.prepare("update payments set status = 'expired', updated = ? where id = ?").run(new Date().toISOString(), c.json.id);
  await payments.tick();
  assert.ok(deliver(), 'just ended: kept');
  await payments.tick(Date.now() + 864e5 + 60_000);
  assert.equal(deliver(), null, 'a day after it ended');
});

test("a customer's deletion request: the line's words and order page go at once, the address once no parcel needs it", async () => {
  shop();
  const a = await line('pebblet', 'peb-ask-1', { description: 'Poster of Mila', detail: 'For Mila' });
  const c = await checkoutOf(await basketOf(a.json));
  await payPage(c.json.url);
  await payments.tick();
  assert.equal((await call('/api/pay/line/forget', as('hello'), { id: a.json.line })).status, 404, "another product's line");
  let parcelNeedsIt = true;
  const needs = (session: string) => session === c.json.id && parcelNeedsIt;
  payments.keepAddress.push(needs);
  try {
    const asked = await call('/api/pay/line/forget', as('pebblet'), { id: a.json.line });
    assert.deepEqual([asked.status, asked.json], [200, { line: a.json.line }], asked.text);
    const row = db.prepare('select description, detail, order_url, amount from pay_lines where id = ?').get(a.json.line) as any;
    assert.deepEqual([row.description, row.detail, row.order_url, row.amount], ['', null, null, 3995], 'no grace; the price stays for the books');
    const deliver = () => (db.prepare('select deliver from payments where id = ?').get(c.json.id) as any).deliver;
    // the imitation's own record of the session: its payer email goes with the basket's, its payment state stays
    const imitation = () => JSON.parse((db.prepare("select record from imitation_records where kind = 'session' and id = ?").get(c.json.id) as any).record);
    await payments.tick();
    assert.ok(deliver(), 'its parcel still needs the address');
    assert.ok(imitation().customer_details.email);
    parcelNeedsIt = false;
    await payments.tick();
    assert.equal(deliver(), null, 'gone as soon as no parcel needs it');
    const s = imitation();
    assert.deepEqual([s.customer_email, s.customer_details.email, s.status, s.payment_status], [null, null, 'complete', 'paid'], 'and the imitation\'s copy');
  } finally { payments.keepAddress.splice(payments.keepAddress.indexOf(needs), 1); }
});

test("a deletion request while a parcel holds the address past 14 days: the imitation's copy of the payer email goes with the address", async () => {
  shop();
  const a = await line('pebblet', 'peb-ask-held-1');
  const c = await checkoutOf(await basketOf(a.json));
  await payPage(c.json.url);
  await payments.tick();
  let parcelNeedsIt = true;
  const needs = (session: string) => session === c.json.id && parcelNeedsIt;
  payments.keepAddress.push(needs);
  try {
    assert.equal((await call('/api/pay/line/forget', as('pebblet'), { id: a.json.line })).status, 200);
    const imitation = () => JSON.parse((db.prepare("select record from imitation_records where kind = 'session' and id = ?").get(c.json.id) as any).record);
    assert.ok(imitation().customer_details.email, 'its parcel still needs the address');
    parcelNeedsIt = false;
    await payments.tick(Date.now() + 15 * 864e5);
    assert.equal((db.prepare('select deliver from payments where id = ?').get(c.json.id) as any).deliver, null);
    const s = imitation();
    assert.deepEqual([s.customer_email, s.customer_details.email, s.status, s.payment_status], [null, null, 'complete', 'paid']);
  } finally { payments.keepAddress.splice(payments.keepAddress.indexOf(needs), 1); }
});

test("a deletion request after the basket's address went takes the imitation's copy of the payer email at once", async () => {
  shop();
  const a = await line('pebblet', 'peb-ask-late-1');
  const c = await checkoutOf(await basketOf(a.json));
  await payPage(c.json.url);
  await payments.tick();
  await outOfParcel('pebblet', a.json.line);
  await payments.tick(Date.now() + 15 * 864e5);
  assert.equal((db.prepare('select deliver from payments where id = ?').get(c.json.id) as any).deliver, null, 'gone after 14 days');
  const imitation = () => JSON.parse((db.prepare("select record from imitation_records where kind = 'session' and id = ?").get(c.json.id) as any).record);
  assert.ok(imitation().customer_details.email);
  assert.equal((await call('/api/pay/line/forget', as('pebblet'), { id: a.json.line })).status, 200);
  const s = imitation();
  assert.deepEqual([s.customer_email, s.customer_details.email, s.status, s.payment_status], [null, null, 'complete', 'paid']);
});

test('a line that goes into another basket while its first basket ends a session stays in one payable basket', async () => {
  shop();
  const a = await line('pebblet', 'peb-race-1'), b = await line('hello', 'hel-race-1');
  const first = await basketOf(b.json);
  const open = await checkoutOf(first);
  slowExpire = 300;
  try {
    const late = call('/api/pay/basket/add', front(), { basket: first, line: a.json.line, claim: a.json.claim });   // waits on the expire
    await new Promise(r => setTimeout(r, 50));
    const other = await basketOf(a.json);
    const c = await checkoutOf(other);
    assert.equal(c.status, 200, c.text);
    assert.equal((await late).status, 409, 'the late add is refused');
    assert.ok((await call(`/api/pay/basket?id=${other}`, front())).json.lines.some((l: any) => l.line === a.json.line), 'in the basket paid');
    assert.equal(sessionStatus(c.json.id), 'open');
    assert.equal(sessionStatus(open.json.id), 'expired');
  } finally { slowExpire = 0; }
});

test('a basket its vouchers pay in full is paid without Stripe; a card total under €0.50 or over €500 is refused', async () => {
  shop();
  payments.lineVoucher.push((_, reference) => (reference.startsWith('peb-free') ? 3995 : reference.startsWith('peb-low') ? 3965 : undefined));
  const heard: string[] = [];
  payments.basketPaid.push(pay => heard.push(pay.id));
  try {
    const a = await line('pebblet', 'peb-free-1', { voucher: 7 });
    assert.equal(a.json.voucher_value, 3995, a.text);
    const basket = await basketOf(a.json);
    const created = seen.filter(x => x.path === '/v1/checkout/sessions').length;
    const c = await checkoutOf(basket);
    assert.equal(c.status, 200, c.text);
    assert.match(c.json.id, /^cs_test_vouchers_/);
    assert.equal(c.json.url, shopUrl(`/order-done/?session=${c.json.id}`), 'straight to the order-done page');
    assert.equal(seen.filter(x => x.path === '/v1/checkout/sessions').length, created, 'Stripe is not asked');
    assert.deepEqual(heard, [c.json.id]);
    const paid = await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'));
    assert.deepEqual([paid.json.status, paid.json.card, paid.json.email, paid.json.lang, paid.json.deliver_to?.city], ['paid', 0, 'sanne@example.com', 'nl', 'Utrecht']);
    const done = await call(`/api/pay/basket/order?id=${c.json.id}`, front());
    assert.deepEqual([done.json.paid, done.json.total, done.json.basket], [true, 0, basket]);
    assert.equal((await checkoutOf(basket)).status, 409, 'paid once');
    await payments.tick(Date.now() + 91 * 864e5);
    assert.equal((await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'))).json.email, null, 'the email goes after 90 days');

    const low = await basketOf((await line('pebblet', 'peb-low-1', { voucher: 8 })).json);
    const refused = await checkoutOf(low);
    assert.deepEqual([refused.status, refused.json.why], [409, 'card_total_low']);
    const big = await basketOf((await line('pebblet', 'peb-big-1', { amount: 50_000 })).json, (await line('hello', 'hel-big-1', { amount: 50_000 })).json);
    const over = await checkoutOf(big);
    assert.deepEqual([over.status, over.json.why], [409, 'card_total_high']);
  } finally { payments.lineVoucher.pop(); payments.basketPaid.pop(); }
});

test('a line its voucher pays in full goes without the postage saved, whatever its place in the basket', async () => {
  shop(380);
  payments.lineVoucher.push((_, reference) => (reference.startsWith('peb-order') ? 3995 : undefined));
  try {
    const tile = (n: number) => line('hello', `hel-order-${n}`, { amount: 2995 }), poster = (n: number) => line('pebblet', `peb-order-${n}`, { voucher: 20 + n });
    const t1 = (await tile(1)).json, p1 = (await poster(1)).json, p2 = (await poster(2)).json, t2 = (await tile(2)).json;
    const baskets = [await basketOf(t1, p1), await basketOf(p2, t2)];
    for (const basket of baskets) {
      const view = (await call(`/api/pay/basket?id=${basket}&country=NL`, front())).json;
      assert.deepEqual(view.lines.map((l: any) => [l.shop, l.card, l.saved]).sort(), [['Hello', 2615, 380], ['Pebblet', 0, 0]]);
      assert.deepEqual([view.total, view.saved], [2615, 380]);
    }
    // the tile carries the saving: its refund gives back what its card paid
    const c = await checkoutOf(baskets[1]);
    assert.equal(c.status, 200, c.text);
    await payPage(c.json.url);
    await outOfParcel('hello', t2.line);
    const r = await call('/api/pay/line/refund', as('hello'), { id: t2.line });
    assert.deepEqual([r.status, r.json.refunded, r.json.card, r.json.saved], [200, true, 2615, 380], r.text);
    assert.deepEqual(refundsAt(c.json.id).map((x: any) => x.amount), [2615]);
    // a basket of only voucher-paid lines saves nothing and pays nothing by card
    const p3 = (await poster(3)).json, p4 = (await poster(4)).json;
    const free = (await call(`/api/pay/basket?id=${await basketOf(p3, p4)}&country=NL`, front())).json;
    assert.deepEqual([free.total, free.saved], [0, 0]);
  } finally { payments.lineVoucher.pop(); }
});

test('a voucher released while the basket\'s session ends never goes on the line', async () => {
  shop();
  let spent = true;
  payments.lineVoucher.push((_, reference) => (reference === 'peb-release-1' ? (spent ? 1000 : 'this voucher is no longer spent on this order') : undefined));
  try {
    const a = await line('pebblet', 'peb-release-1');
    await checkoutOf(await basketOf(a.json));
    slowExpire = 300;
    const late = line('pebblet', 'peb-release-1', { voucher: 9 });   // waits on the expire
    await new Promise(r => setTimeout(r, 50));
    spent = false;   // released meanwhile: the line had no voucher yet, so the vouchers kit lets it go
    assert.equal((await late).status, 409);
    const now = await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'));
    assert.deepEqual([now.json.voucher, now.json.voucher_value, now.json.amount], [null, null, 3995]);
  } finally { slowExpire = 0; payments.lineVoucher.pop(); }
});

test('a line its voucher paid in full is closed once the voucher is released, kept as any refunded line', async () => {
  shop();
  let spent = true;
  const worth = (_: unknown, reference: string) => (reference === 'peb-vclose-1' ? (spent ? 3995 : 'this voucher is no longer spent on this order') : undefined);
  payments.lineVoucher.push(worth);
  try {
    const a = await line('pebblet', 'peb-vclose-1', { voucher: 11, detail: 'For Noor' });
    const c = await checkoutOf(await basketOf(a.json));
    const paid = (await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'))).json;
    assert.deepEqual([paid.status, paid.card], ['paid', 0], c.text);
    const held = await call('/api/pay/line/refund', as('pebblet'), { id: a.json.line });
    assert.equal(held.status, 409, 'not while the voucher still pays it');
    spent = false;   // the product released it
    payments.lineVoucher.pop();
    const unanswered = await call('/api/pay/line/refund', as('pebblet'), { id: a.json.line });
    assert.equal(unanswered.status, 409, 'not while no tool says the voucher is released');
    payments.lineVoucher.push(worth);
    assert.equal((await call('/api/pay/line/refund', as('pebblet'), { id: a.json.line })).status, 409, 'its parcel holds it like a card refund');
    const words = await call('/api/pay/line/held', as('pebblet'), { id: a.json.line, words: 'For Noor, Keizersgracht 1' });
    assert.equal(words.status, 200, words.text);
    const kept = (await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'))).json;
    assert.deepEqual([kept.description, kept.detail, kept.refund_status], ['pebblet poster', 'For Noor', null], 'each refusal leaves the line as it is');
    await outOfParcel('pebblet', a.json.line);
    const closed = await call('/api/pay/line/refund', as('pebblet'), { id: a.json.line });
    assert.deepEqual([closed.status, closed.json.refunded, closed.json.refund_status, closed.json.detail, closed.json.deliver_to],
      [200, true, 'succeeded', 'For Noor', null], closed.text);
    // (the table: the line's order page and the words held for a person, which no route shows a product)
    const row = db.prepare('select description, detail, order_url, refund, held_words from pay_lines where id = ?').get(a.json.line) as any;
    assert.deepEqual([row.description, row.detail, !!row.order_url, row.refund, row.held_words], ['pebblet poster', 'For Noor', true, null, null],
      "no Stripe refund; what the customer made stays (a cancel changes no clock), the board's held words go at once");
    const order = await call(`/api/pay/basket/order?id=${c.json.id}`, front());
    assert.deepEqual(order.json.lines.map((l: any) => l.refund_status), ['succeeded'], 'the thank-you page can tell it was cancelled');
    assert.equal((await call('/api/pay/line/refund', as('pebblet'), { id: a.json.line })).json.refunded, true, 'asked again: still closed');
  } finally { payments.lineVoucher.pop(); }
});

test('what a line says about the customer goes 90 days after it was paid or made, cancelled or not, and a line nobody paid within a day is cancelled', async () => {
  shop();
  const paid = await line('pebblet', 'peb-forget-1', { description: 'Textile poster of Mila', detail: 'For Mila' });
  const cancelled = await line('hello', 'hel-forget-1', { description: 'House tile, Keizersgracht 1', detail: 'Keizersgracht 1' });
  const unpaid = await line('hello', 'hel-forget-2', { description: 'Mug for Noor', detail: 'For Noor' });
  assert.equal(paid.status, 200, paid.text);
  const c = await checkoutOf(await basketOf(paid.json));
  await payPage(c.json.url);
  await payments.tick();
  const gone = await call('/api/pay/line/cancel', as('hello'), { id: cancelled.json.line });
  assert.deepEqual([gone.json.status, gone.json.description, gone.json.detail], ['cancelled', 'House tile, Keizersgracht 1', 'Keizersgracht 1'],
    'a cancel changes no clock');
  const lineNow = (slug: string, id: string) => call(`/api/pay/line?id=${id}`, as(slug)).then(r => r.json);
  await payments.tick(Date.now() + 864e5 - 60_000);
  assert.equal((await lineNow('hello', unpaid.json.line)).status, 'open', 'not yet a day old');
  await payments.tick(Date.now() + 864e5 + 60_000);
  const kept = await lineNow('pebblet', paid.json.line);
  assert.deepEqual([kept.description, kept.detail], ['Textile poster of Mila', 'For Mila'], 'kept for a reprint');
  const expired = await lineNow('hello', unpaid.json.line);
  assert.deepEqual([expired.status, expired.description, expired.detail], ['cancelled', 'Mug for Noor', 'For Noor'], 'cancelled within a day, its words kept');
  const orderUrl = (id: string) => (db.prepare('select order_url from pay_lines where id = ?').get(id) as any).order_url;
  assert.ok(orderUrl(unpaid.json.line), 'its order page too, where the cancel can be taken back');
  await payments.tick(Date.now() + 89 * 864e5);
  assert.equal((await lineNow('hello', cancelled.json.line)).detail, 'Keizersgracht 1', '89 days: kept');
  await payments.tick(Date.now() + 91 * 864e5);
  for (const [slug, id] of [['hello', cancelled.json.line], ['hello', unpaid.json.line]]) {
    const now = await lineNow(slug, id);
    assert.deepEqual([now.status, now.description, now.detail, orderUrl(id)], ['cancelled', '', null, null], '90 days after its making');
  }
  const after = await lineNow('pebblet', paid.json.line);
  assert.deepEqual([after.description, after.detail, after.status, after.card], ['', null, 'paid', 3995], 'the price stays, for the books');
  const order = await call(`/api/pay/basket/order?id=${c.json.id}`, front());
  assert.deepEqual(order.json.lines.map((l: any) => [l.description, l.detail, l.order_url]), [['', null, null]]);
  assert.equal(order.json.total, 3995);
});

test('a basket nobody paid for is deleted 30 days after its start, its open lines cancelled; not while its checkout is open', async () => {
  shop();
  const a = await line('pebblet', 'peb-old-1', { description: 'Poster of Mila' }), b = await line('hello', 'hel-old-1');
  const old = await basketOf(a.json), paying = await basketOf(b.json);
  assert.equal((await checkoutOf(paying)).status, 200);
  // (a basket's age: no route makes time pass for one basket and not another)
  const started = (basket: string, daysAgo: number) =>
    db.prepare('update baskets set created = ? where id = ?').run(new Date(Date.now() - daysAgo * 864e5).toISOString(), basket);
  started(old, 29);
  started(paying, 31);
  await payments.tick();
  assert.equal((await call(`/api/pay/basket?id=${old}`, front())).status, 200, '29 days: kept');
  started(old, 31);
  await payments.tick();
  const gone = await call(`/api/pay/basket?id=${old}`, front());
  assert.deepEqual([gone.status, gone.json.why], [404, 'basket_gone']);
  const added = await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'));   // put in on its last day: hours old
  assert.deepEqual([added.json.status, added.json.description, added.json.in_basket], ['cancelled', 'Poster of Mila', false], 'its words kept 90 days, as any cancel');
  assert.equal((await call(`/api/pay/basket?id=${paying}`, front())).status, 200, 'its checkout is open: the customer may be paying now');
});

test('every refusal a shop customer can reach says why, for the shop to say in their language', async () => {
  shop();
  const why = async (answer: Promise<{ status: number; json: any }>) => { const r = await answer; return [r.status, r.json.why]; };
  const a = await line('pebblet', 'peb-why-1'), b = await line('hello', 'hel-why-1');
  const basket = await basketOf(a.json);
  for (const [bad, code] of [[{ line1: ' ' }, 'address_incomplete'], [{ city: 'x'.repeat(65) }, 'address_incomplete'],
    [{ postCode: '1234/AB' }, 'postcode_invalid'], [{ country: 'FR' }, 'country_not_delivered'], [{ country: 'Nederland' }, 'country_not_delivered']] as const)
    assert.deepEqual(await why(checkoutOf(basket, { deliver_to: { ...ADDRESS, ...bad } })), [400, code], JSON.stringify(bad));
  assert.deepEqual(await why(checkoutOf(basket, { email: 'nope' })), [400, 'email_invalid']);
  const nowhere = `bk_${'0'.repeat(32)}`;
  assert.deepEqual(await why(checkoutOf(nowhere)), [404, 'basket_gone']);
  assert.deepEqual(await why(call('/api/pay/basket/remove', front(), { basket: nowhere, line: a.json.line })), [404, 'basket_gone']);
  await call('/api/pay/line/cancel', as('hello'), { id: b.json.line });
  assert.deepEqual(await why(call('/api/pay/basket/add', front(), { basket, line: b.json.line, claim: b.json.claim })), [409, 'line_cancelled']);
  const c = await checkoutOf(basket);
  await payPage(c.json.url);
  assert.deepEqual(await why(checkoutOf(basket)), [409, 'already_paid']);
  assert.deepEqual(await why(call('/api/pay/basket/add', front(), { line: a.json.line, claim: a.json.claim })), [409, 'line_paid']);
  const e = await line('pebblet', 'peb-why-2'), emptied = await basketOf(e.json);
  await call('/api/pay/basket/remove', front(), { basket: emptied, line: e.json.line });
  assert.deepEqual(await why(checkoutOf(emptied)), [409, 'basket_empty']);
  const full: { line: string; claim: string }[] = [];
  for (let i = 0; i <= 20; i++) full.push((await line('hello', `hel-full-${i}`)).json);
  const crowded = await basketOf(...full.slice(0, 20));
  assert.deepEqual(await why(call('/api/pay/basket/add', front(), { basket: crowded, ...full[20] })), [409, 'basket_full']);
});

test('a line renamed after its checkout\'s answer got lost gets a session with its new name, not a refused key', async () => {
  shop();
  const a = await line('pebblet', 'peb-rename-1', { description: 'Poster of Mila' });
  const basket = await basketOf(a.json);
  loseCreate = true;
  assert.notEqual((await checkoutOf(basket)).status, 200);
  assert.ok(lostId, 'Stripe made a session');
  assert.equal((await line('pebblet', 'peb-rename-1', { description: 'Poster of Milan' })).status, 200);
  const c = await checkoutOf(basket);
  assert.equal(c.status, 200, c.text);
  assert.notEqual(c.json.id, lostId);
  const s = stripeSession(c.json.id);
  assert.deepEqual(s.items.map((i: any) => i.name), ['Pebblet: Poster of Milan']);
});

test("each order's steps in its stall's funnel: once in the basket, once in a checkout, none for a test order", async () => {
  shop();
  // two stalls that show the steps (metrics.ts counts them, in preview for test lines)
  const steps = { steps: ['page', 'basket', 'checkout', 'paid'].map(id => ({ id })), funnel: ['page', 'basket', 'checkout', 'paid'], tests: [] };
  for (const slug of ['stepa', 'stepb', 'stepc']) {
    manifest(slug, `name: ${slug}\nstatus: preview\n`);
    mkdirSync(`${repo}/products/${slug}/app`, { recursive: true });
    writeFileSync(`${repo}/products/${slug}/app/metrics.json`, JSON.stringify(steps));
  }
  const metrics = await import('./metrics.ts');
  const funnel = (slug: string) => { const { basket, checkout } = (metrics.detail(slug, 1, 'preview') as any).steps; return [basket, checkout]; };
  const FRONT_TEST = { slug: 'front', mode: 'test' as const };
  const a = await line('stepa', 'sta-steps-1'), b = await line('stepb', 'stb-steps-1', { amount: 2495 });
  const basket = await basketOf(a.json, b.json);
  assert.deepEqual([funnel('stepa'), funnel('stepb')], [[1, 0], [1, 0]]);
  await call('/api/pay/basket/add', front(), { basket, line: a.json.line, claim: a.json.claim });
  const changed = await line('stepa', 'sta-steps-2');
  await call('/api/pay/basket/add', front(), { basket, line: changed.json.line, claim: changed.json.claim, replaces: a.json.line });
  await payments.changeBasket(FRONT_TEST, basket, id =>
    payments.addOwnLine(id, { goes_with: changed.json.line, description: 'Fridge magnet', amount: 999, ships_in: 1, cutoff: 12 }) ?? undefined);
  assert.deepEqual(funnel('stepa'), [1, 0], "a line already in, a changed design taking its place, or the shop's own line: no new order");
  // a create whose answer got lost counts once its retry brings the session back
  loseCreate = true;
  assert.notEqual((await checkoutOf(basket)).status, 200);
  assert.deepEqual(funnel('stepa'), [1, 0]);
  const c = await checkoutOf(basket);
  assert.equal(c.json.id, lostId);
  assert.equal((await checkoutOf(basket)).json.id, c.json.id);
  assert.deepEqual([funnel('stepa'), funnel('stepb')], [[1, 1], [1, 1]]);
  // a changed basket's new session: the same orders, no new count
  await call('/api/pay/basket/remove', front(), { basket, line: b.json.line });
  assert.notEqual((await checkoutOf(basket)).json.id, c.json.id);
  assert.deepEqual([funnel('stepa'), funnel('stepb')], [[1, 1], [1, 1]]);
  // a basket that turns a test order after its things joined and a checkout opened takes back both, and counts nothing more
  const t = await basketOf((await line('stepb', 'stb-steps-2')).json);
  assert.equal((await checkoutOf(t)).status, 200);
  assert.deepEqual(funnel('stepb'), [2, 2]);
  await payments.changeBasket(FRONT_TEST, t, id => void payments.markTest(id, true));
  await call('/api/pay/basket/add', front(), { basket: t, ...(await line('stepb', 'stb-steps-3')).json });
  assert.equal((await checkoutOf(t)).status, 200);
  assert.deepEqual(funnel('stepb'), [1, 1]);
  // an old design put back after its changed one took its place is a new order; a test basket takes back each once
  const old = (await line('stepc', 'stc-steps-1')).json, again = (await line('stepc', 'stc-steps-2')).json;
  const r = await basketOf(old);
  await call('/api/pay/basket/add', front(), { basket: r, line: again.line, claim: again.claim, replaces: old.line });
  await call('/api/pay/basket/add', front(), { basket: r, line: old.line, claim: old.claim });
  assert.deepEqual(funnel('stepc'), [2, 0]);
  await payments.changeBasket(FRONT_TEST, r, id => void payments.markTest(id, true));
  assert.deepEqual(funnel('stepc'), [0, 0], 'never below none');
});

test('a line\'s detail (what is on it) shows in the basket and its order, and never reaches Stripe', async () => {
  shop();
  assert.equal((await line('pebblet', 'peb-detail-0', { detail: 'x'.repeat(121) })).status, 400, 'at most 120 characters');
  const a = await line('pebblet', 'peb-detail-1', { description: 'Cotton poster 30 × 40 cm', detail: 'For  Mila\n' });
  assert.equal(a.json.detail, 'For Mila', 'cleaned as a description is');
  const basket = await basketOf(a.json);
  const view = await call(`/api/pay/basket?id=${basket}`, front());
  assert.deepEqual(view.json.lines.map((l: any) => [l.description, l.detail]), [['Cotton poster 30 × 40 cm', 'For Mila']]);
  assert.equal((await line('pebblet', 'peb-detail-1', { description: 'Cotton poster 30 × 40 cm', detail: 'For Milan' })).json.detail, 'For Milan', 'a changed detail is the line\'s');
  const c = await checkoutOf(basket);
  assert.equal(c.status, 200, c.text);
  const s = stripeSession(c.json.id);
  assert.deepEqual(s.items.map((i: any) => i.name), ['Pebblet: Cotton poster 30 × 40 cm']);
  const order = await call(`/api/pay/basket/order?id=${c.json.id}`, front());
  assert.deepEqual(order.json.lines.map((l: any) => l.detail), ['For Milan']);
});

test('a ship date counts the making time in working days, from the next one after the cut-off', () => {
  const at = (iso: string, ships_in: number, cutoff = 12) => payments.shipBy({ paid_at: iso, ships_in, cutoff } as any);
  assert.equal(at('2026-10-06T08:00:00Z', 1), '2026-10-07', 'Tuesday 10:00 in Amsterdam: made Wednesday');
  assert.equal(at('2026-10-06T11:00:00Z', 1), '2026-10-08', 'after 12:00: from Wednesday');
  assert.equal(at('2026-10-09T09:00:00Z', 2), '2026-10-13', 'Friday morning, two days: Tuesday');
  assert.equal(at('2026-10-10T09:00:00Z', 1), '2026-10-13', 'a Saturday counts from Monday');
});

test("the shop's own lines: the company's price, nothing off them, never a basket alone, and gone with their thing", async () => {
  shop();
  payments.ownLines.price = (_basket, things, own) => own.map((_, i) => (things.length > 1 && i === 0 ? 0 : 999));
  const FRONT_TEST = { slug: 'front', mode: 'test' as const };
  try {
    const a = await line('pebblet', 'peb-own-1', { amount: 2495 }), b = await line('hello', 'hel-own-1', { amount: 2495 });
    const basket = await basketOf(a.json);
    const add = (goes_with: string) => payments.changeBasket(FRONT_TEST, basket, id =>
      payments.addOwnLine(id, { goes_with, description: 'Fridge magnet', amount: 999, ships_in: 1, cutoff: 12 }) ?? undefined);
    assert.equal(((await add(b.json.line)) as any)[2], 'own_thing', 'only next to a thing of this basket');
    const added = (await add(a.json.line)) as any;
    const own = added.lines.find((l: any) => l.goes_with);
    assert.deepEqual([own.goes_with, own.shop, own.description, own.card], [a.json.line, 'The shop', 'Fridge magnet', 999]);
    assert.equal(((await add(own.line)) as any)[2], 'own_thing', 'never next to another own line');
    // the customer takes one out: gone, and no cancelled order in the basket's view for it
    const second = ((await add(a.json.line)) as any).lines.filter((l: any) => l.goes_with).at(-1).line;
    const taken = (await call('/api/pay/basket/remove', front(), { basket, line: second })).json;
    assert.deepEqual([taken.lines.some((l: any) => l.line === second), taken.dropped], [false, []]);
    await call('/api/pay/basket/add', front(), { basket, line: b.json.line, claim: b.json.claim });
    const view = (await call(`/api/pay/basket?id=${basket}&country=NL`, front())).json;
    assert.deepEqual(view.lines.map((l: any) => [l.goes_with ? 'own' : l.shop, l.card, l.saved]),
      [['Pebblet', 2495, 0], ['own', 0, 0], ['Hello', 2095, 400]], 'priced again as the basket changed; the postage saved off a thing');
    // its thing goes out: so does the own line (cancelled); a basket left with own lines alone can't be checked out
    await call('/api/pay/basket/remove', front(), { basket, line: b.json.line });
    const lone = await basketOf(b.json);
    const own2 = (await payments.changeBasket(FRONT_TEST, lone, id =>
      payments.addOwnLine(id, { goes_with: b.json.line, description: 'Fridge magnet', amount: 999, ships_in: 1, cutoff: 12 }) ?? undefined)) as any;
    assert.equal(own2.total, 2495 + 999);
    const ownLine = own2.lines.find((l: any) => l.goes_with).line;
    await call('/api/pay/basket/remove', front(), { basket: lone, line: b.json.line });
    assert.equal((await call(`/api/pay/line?id=${ownLine}`, front())).json.status, 'cancelled');
    assert.deepEqual((await call(`/api/pay/basket?id=${lone}&country=NL`, front())).json.dropped, [], 'nor for its thing taken out');
    // the checkout charges the price it showed, and keeps it as the line's amount
    const c = await checkoutOf(basket);
    assert.equal(c.status, 200, c.text);
    const s = stripeSession(c.json.id);
    assert.deepEqual(s.items.map((i: any) => [i.name, i.amount]), [['Pebblet: pebblet poster', 2495], ['The shop: Fridge magnet', 999]]);
    assert.equal((await call(`/api/pay/line?id=${own.line}`, front())).json.amount, 999);
  } finally {
    delete payments.ownLines.price;
  }
});

test("a line's picture of its own design: on the product's own address only, in the basket, gone with its words", async () => {
  shop();
  const own = 'https://pebblet.preview.company.test/api/orders/peb-pic-1/picture/abc';
  assert.equal((await line('pebblet', 'peb-pic-0', { picture: 'https://hello.preview.company.test/x.png' })).status, 400, "never another product's");
  assert.equal((await line('pebblet', 'peb-pic-0', { picture: 'http://pebblet.preview.company.test/x.png' })).status, 400, 'https only');
  const a = await line('pebblet', 'peb-pic-1', { picture: own });
  assert.equal(a.status, 200, a.text);
  const basket = await basketOf(a.json);
  assert.deepEqual((await call(`/api/pay/basket?id=${basket}`, front())).json.lines.map((l: any) => l.picture), [own]);
  assert.equal((await line('pebblet', 'peb-pic-1')).status, 200, 'registered again without one: none');
  assert.deepEqual((await call(`/api/pay/basket?id=${basket}`, front())).json.lines.map((l: any) => l.picture), [null]);
  await line('pebblet', 'peb-pic-1', { picture: own });
  await call('/api/pay/line/forget', as('pebblet'), { id: a.json.line });
  assert.deepEqual((await call(`/api/pay/basket?id=${basket}`, front())).json.lines.map((l: any) => l.picture), [null], 'a deletion request takes it');
});

test("a changed design takes its old line's place in the basket, with the shop's line that went with it; anything else is added as any line", async () => {
  shop();
  const FRONT_TEST = { slug: 'front', mode: 'test' as const };
  const a = await line('pebblet', 'peb-swap-1'), b = await line('hello', 'hel-swap-1', { amount: 2495 });
  const basket = await basketOf(a.json, b.json);
  const magnet = (await payments.changeBasket(FRONT_TEST, basket, id =>
    payments.addOwnLine(id, { goes_with: a.json.line, description: 'Fridge magnet', amount: 0, ships_in: 1, cutoff: 12 }) ?? undefined)) as any;
  const magnetLine = magnet.lines.find((l: any) => l.goes_with).line;
  const changed = await line('pebblet', 'peb-swap-2', { detail: 'For Mila', order_url: 'https://pebblet.preview.company.test/order/peb-swap-2' });
  const view = (await call('/api/pay/basket/add', front(), { basket, line: changed.json.line, claim: changed.json.claim, replaces: a.json.line })).json;
  assert.deepEqual(view.lines.map((l: any) => [l.line, l.goes_with]), [[changed.json.line, null], [b.json.line, null], [magnetLine, changed.json.line]],
    'in the old one\'s place, its magnet going with it');
  const m = view.lines.find((l: any) => l.goes_with);
  assert.deepEqual([m.detail, m.order_url], ['For Mila', 'https://pebblet.preview.company.test/order/peb-swap-2'], "in the new design's words");
  const old = (await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'))).json;
  assert.deepEqual([old.status, old.in_basket], ['open', false], 'the old one is out of the basket, as one taken out is');
  // another product's line, a line of another basket, the line itself or one not in the basket: added as any line
  const c = await line('pebblet', 'peb-swap-3');
  const added = (await call('/api/pay/basket/add', front(), { basket, line: c.json.line, claim: c.json.claim, replaces: b.json.line })).json;
  assert.deepEqual(added.lines.map((l: any) => l.line), [changed.json.line, b.json.line, magnetLine, c.json.line], "never another stall's line");
  const d = await line('pebblet', 'peb-swap-4');
  const again = (await call('/api/pay/basket/add', front(), { basket, line: d.json.line, claim: d.json.claim, replaces: a.json.line })).json;
  assert.equal(again.lines.at(-1).line, d.json.line, 'nor a line no longer in the basket');
  // a full basket takes a changed design in place of its old one
  const crowded = await basketOf(...(await Promise.all(Array.from({ length: 20 }, (_, i) => line('pebblet', `peb-swap-full-${i}`)))).map(r => r.json));
  const e = await line('pebblet', 'peb-swap-full-x');
  assert.equal((await call('/api/pay/basket/add', front(), { basket: crowded, line: e.json.line, claim: e.json.claim })).status, 409);
  const first = (await call(`/api/pay/basket?id=${crowded}`, front())).json.lines[0].line;
  const swapped = await call('/api/pay/basket/add', front(), { basket: crowded, line: e.json.line, claim: e.json.claim, replaces: first });
  assert.deepEqual([swapped.status, swapped.json.lines.length, swapped.json.lines[0].line], [200, 20, e.json.line]);
});

test("a changed design takes its old line's voucher with it, or the basket keeps the old design and its voucher", async () => {
  shop();
  payments.lineVoucher.push((_, reference) => (reference === 'peb-vswap-1' ? 2000 : 'not this order'));
  const moves: string[] = [];
  payments.basketVoucher.move = (from, to) => {
    if (to.amount < 2000) return [409, 'this voucher pays 2000 cents, on an order costing at least that', 'voucher_cheaper'];
    moves.push(`${from.reference} > ${to.reference}`);
    return 2000;
  };
  try {
    const a = await line('pebblet', 'peb-vswap-1', { voucher: 31 });
    const basket = await basketOf(a.json);
    const change = (l: any) => call('/api/pay/basket/add', front(), { basket, line: l.json.line, claim: l.json.claim, replaces: a.json.line });
    const cheap = await line('pebblet', 'peb-vswap-2', { amount: 1500 });
    const kept = await change(cheap);
    assert.deepEqual([kept.status, kept.json.why], [409, 'voucher_cheaper'], kept.text);
    const before = (await call(`/api/pay/basket?id=${basket}`, front())).json;
    assert.deepEqual(before.lines.map((l: any) => [l.line, l.voucher_value]), [[a.json.line, 2000]], 'the old design and its voucher stay');
    assert.equal((await call(`/api/pay/line?id=${cheap.json.line}`, as('pebblet'))).json.in_basket, false, 'the cheaper one never joined');
    const changed = await line('pebblet', 'peb-vswap-3', { amount: 2695 });
    const view = (await change(changed)).json;
    assert.deepEqual(view.lines.map((l: any) => [l.line, l.voucher_value, l.card]), [[changed.json.line, 2000, 695]], 'the voucher pays the new design');
    assert.deepEqual(moves, ['peb-vswap-1 > peb-vswap-3']);
    const old = (await call(`/api/pay/line?id=${a.json.line}`, as('pebblet'))).json;
    assert.deepEqual([old.in_basket, old.voucher, old.voucher_value], [false, null, null], 'the old order holds it no more');
    assert.equal((await call(`/api/pay/line?id=${changed.json.line}`, as('pebblet'))).json.voucher, 31, 'the stall finds it on its new line');
  } finally { payments.lineVoucher.pop(); delete payments.basketVoucher.move; }
});

test("a support chat's lookups by the payer's email: a product's own paid sessions only, the email never returned", async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const pay = async (slug: string, reference: string, email: string, paid = true) => {
    const c = await call('/api/pay/checkout', as(slug), order({ reference, customer_email: email,
      success_url: `https://${slug}.preview.company.test/`, cancel_url: `https://${slug}.preview.company.test/` }));
    assert.equal(c.status, 200, c.text);
    if (paid) await call(`${new URL(c.json.url).pathname}/pay`, { origin: 'https://hq.company.test' }, '');
    return c.json.id as string;
  };
  const first = await pay('pebblet', 'payer-1', 'Ann@Example.test'), second = await pay('pebblet', 'payer-2', 'ann@example.test');
  const open = await pay('pebblet', 'payer-3', 'ann@example.test', false), other = await pay('pebblet', 'payer-4', 'bo@example.test');
  const elsewhere = await pay('hello', 'payer-5', 'ann@example.test');
  await call('/api/pay/refund', as('pebblet'), { id: first });
  const match = async (id: string, email: string) => (await call('/api/pay/payer', as('pebblet'), { id, email })).json;
  assert.deepEqual(await match(first, ' ANN@example.test '), { match: true }, 'a refunded payment was still paid from it, case aside');
  for (const [id, email] of [[other, 'ann@example.test'], [open, 'ann@example.test'], [elsewhere, 'ann@example.test'], ['cs_test_nope', 'ann@example.test']])
    assert.deepEqual(await match(id, email), { match: false }, `${id} ${email}`);
  assert.equal((await call('/api/pay/payer', as('pebblet'), { id: first, email: 'ann' })).status, 400);
  const sessions = await call('/api/pay/payer/sessions', as('pebblet'), { email: 'Ann@Example.test' });
  assert.deepEqual(sessions.json, { sessions: [{ id: second, reference: 'payer-2' }, { id: first, reference: 'payer-1' }] },
    "newest first; the unpaid one, another payer's and another product's are left out");
  assert.ok(!sessions.text.includes('example.test'), 'the email never comes back');
  assert.deepEqual((await call('/api/pay/payer/sessions', as('hello'), { email: 'ann@example.test' })).json.sessions.map((s: any) => s.id), [elsewhere]);
  assert.deepEqual((await call('/api/pay/payer/sessions', as('pebblet', 'live'), { email: 'ann@example.test' })).status, 503, 'live mode needs its own key');
  // a territory's sale is listed once HQ charged its hold, never after a release, whatever Stripe's session says
  async function listPayerReferences() {
    const payerSessionsResponse = await call('/api/pay/payer/sessions', as('pebblet'), { email: 'cy@example.test' });
    return payerSessionsResponse.json.sessions.map((session: any) => session.reference);
  }
  async function createHeldSession(reference: string, form: string) {
    const checkoutRequest = order({
      reference,
      amount: 499,
      countries: ['NL'],
      customer_email: 'cy@example.test',
      success_url: 'https://pebblet.preview.company.test/',
      cancel_url: 'https://pebblet.preview.company.test/',
    });
    const checkoutResponse = await call('/api/pay/checkout', as('pebblet'), checkoutRequest);
    assert.equal(checkoutResponse.status, 200, checkoutResponse.text);
    const checkoutPath = new URL(checkoutResponse.json.url).pathname;
    await call(`${checkoutPath}/pay`, { origin: 'https://hq.company.test' }, form);
    return checkoutResponse.json.id as string;
  }
  const insideTerritorySessionId = await createHeldSession('payer-held', 'country=NL');
  const outsideTerritorySessionId = await createHeldSession('payer-released', 'country=DE');
  assert.deepEqual(await listPayerReferences(), [], 'a hold not yet decided is not paid');
  // Reading each session decides its hold before the next payer lookup.
  const insideTerritoryResponse = await call(`/api/pay/session?id=${insideTerritorySessionId}`, as('pebblet'));
  const outsideTerritoryResponse = await call(`/api/pay/session?id=${outsideTerritorySessionId}`, as('pebblet'));
  assert.equal(insideTerritoryResponse.status, 200, insideTerritoryResponse.text);
  assert.equal(outsideTerritoryResponse.status, 200, outsideTerritoryResponse.text);
  assert.equal(insideTerritoryResponse.json.paid, true);
  assert.equal(outsideTerritoryResponse.json.paid, false);
  assert.equal(outsideTerritoryResponse.json.status, 'released');
  const capturedImitationSession = stripeSession(insideTerritorySessionId);
  assert.equal(
    capturedImitationSession.payment_status,
    'unpaid',
    "the imitation's session stays unpaid after the capture",
  );
  assert.deepEqual(await listPayerReferences(), ['payer-held']);
  try {
    const releasedImitationSession = stripeSession(outsideTerritorySessionId);
    payerListReply = {
      data: [releasedImitationSession, capturedImitationSession].map(session => ({
        ...session,
        payment_status: 'paid',
      })),
    };
    assert.deepEqual(
      await listPayerReferences(),
      ['payer-held'],
      'a released hold is left out even if Stripe says paid',
    );
  } finally {
    payerListReply = undefined;
  }
  try {
    payerListReply = {};
    assert.equal((await call('/api/pay/payer/sessions', as('pebblet'), { email: 'ann@example.test' })).status, 500);
    payerListReply = { data: [] };
    assert.deepEqual((await call('/api/pay/payer/sessions', as('pebblet'), { email: 'ann@example.test' })).json, { sessions: [] });
  } finally {
    payerListReply = undefined;
  }
});

// ---- an order past its product's retention
const retire = (reference: string, slug = 'pebblet') => call('/api/pay/retire', as(slug), { reference });
const rowsOf = (reference: string) => db.prepare('select * from payments where reference = ? order by created, id').all(reference);
const attemptsOf = (reference: string) => db.prepare('select * from checkout_creates where reference = ? order by minute, key').all(reference);
const payAt = (id: string, form = '') => call(`/pay/imitation/${id}/pay`, { origin: 'https://hq.company.test' }, form);

test('a held payment refuses retirement without changing a column, beside a session only Stripe knows expired, until it is released', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const stale = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-retire-held', amount: 499 }));
  const held = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-retire-held', amount: 499, countries: ['NL'] }));
  // the first session expired at Stripe when the second opened; HQ hasn't read it since
  // (HQ's row as it was before the expiry: no route leaves a session HQ didn't hear expired)
  db.prepare("update payments set status = 'open' where id = ?").run(stale.json.id);
  await payAt(held.json.id, 'country=NL&card_country=DE');   // complete and unpaid at Stripe: the payment is held
  const before = rowsOf('bud-retire-held');
  assert.deepEqual(before.map((row: any) => [row.id, row.status, row.hold]), [[stale.json.id, 'open', null], [held.json.id, 'open', null]]);
  for (let i = 0; i < 2; i++) {
    const r = await retire('bud-retire-held');
    assert.equal(r.status, 409, r.text);
    assert.deepEqual(rowsOf('bud-retire-held'), before, `try ${i + 1}: every column as it was`);
  }
  assert.deepEqual((await retire('bud-retire-held', 'hello')).json, { reference: 'bud-retire-held' }, "hello has nothing of pebblet's order");
  assert.deepEqual(rowsOf('bud-retire-held'), before);
  // HQ's next read releases the hold (the card is German), and then the order can go
  assert.equal((await call(`/api/pay/session?id=${held.json.id}`, as('pebblet'))).json.status, 'released');
  for (let i = 0; i < 2; i++) assert.deepEqual((await retire('bud-retire-held')).json, { reference: 'bud-retire-held' });
  assert.deepEqual(rowsOf('bud-retire-held'), []);
});

test('a payment refuses retirement without changing a column until it is refunded; a fee lookup that ends after it writes nothing back', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const c = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-retire-paid' }));
  await payAt(c.json.id);   // paid at Stripe, while HQ's row still says open
  const before = rowsOf('bud-retire-paid');
  assert.deepEqual(before.map((row: any) => row.status), ['open']);
  for (let i = 0; i < 2; i++) {
    const r = await retire('bud-retire-paid');
    assert.equal(r.status, 409, r.text);
    assert.deepEqual(rowsOf('bud-retire-paid'), before, `try ${i + 1}`);
  }
  assert.equal((await call('/api/pay/refund', as('pebblet'), { id: c.json.id })).json.refunded, true);
  feeLookup = 'held';
  assert.equal((await settlementOf(c.json.id))[0], true);
  await until(() => heldFees.length, 'Stripe holds the fee lookup');
  assert.deepEqual((await retire('bud-retire-paid')).json, { reference: 'bud-retire-paid' });
  assert.deepEqual([rowsOf('bud-retire-paid'), attemptsOf('bud-retire-paid')], [[], []]);
  assert.throws(() => stripeSession(c.json.id), /No such checkout\.session/, 'nor does the imitation keep it');
  feeLookup = null;
  heldFees.splice(0).forEach(answer => answer());
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(rowsOf('bud-retire-paid'), [], 'the late fee writes no row back');
  assert.equal((await retire('bud retire')).status, 400);
  assert.equal((await retire(`bk_${'0'.repeat(32)}`, 'front')).status, 409, "a basket's payment stays with its lines");
});

test("a create whose answer got lost refuses retirement until its session expired unpaid, and one paid keeps refusing", async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const lose = async (reference: string) => {
    loseCreate = true;
    assert.notEqual((await call('/api/pay/checkout', as('pebblet'), order({ reference }))).status, 200);
    return lostId;
  };
  const paidLost = await lose('bud-retire-lost-paid');
  const unpaidLost = await lose('bud-retire-lost');
  const attempts = attemptsOf('bud-retire-lost');
  assert.deepEqual([rowsOf('bud-retire-lost'), attempts.length], [[], 1], 'no row, one pending attempt');
  const r = await retire('bud-retire-lost');
  assert.equal(r.status, 409, 'its session may still be open');
  assert.deepEqual(attemptsOf('bud-retire-lost'), attempts);
  await payAt(paidLost);   // paid at Stripe, though HQ never had its answer
  const realNow = Date.now;
  Date.now = () => realNow() + 67 * 60_000;   // past both sessions' expiry
  try {
    const paidRefusal = await retire('bud-retire-lost-paid');
    assert.equal(paidRefusal.status, 409, 'a paid one stays');
    await retire('bud-retire-lost-paid');
    assert.equal(logged('NEEDS A PERSON: pebblet: bud-retire-lost-paid'), 1, 'one request for a person per HQ run');
    assert.equal(attemptsOf('bud-retire-lost-paid').length, 1);
    assert.deepEqual((await retire('bud-retire-lost')).json, { reference: 'bud-retire-lost' });
    assert.deepEqual(attemptsOf('bud-retire-lost'), []);
    assert.equal(stripeSession(unpaidLost).status, 'expired');
  } finally { Date.now = realNow; }
});

test('a paid create whose answer got lost retires once Stripe refunded it in full, and one held or refunded in part keeps refusing', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const lose = async (reference: string, countries?: string[]) => {
    loseCreate = true;
    assert.notEqual((await call('/api/pay/checkout', as('pebblet'), order({ reference, amount: 3995, countries }))).status, 200);
    return lostId;
  };
  const intent = (id: string) => stripeSession(id).payment_intent;
  const refundAt = (id: string, amount: number) => payments.imitation('POST', '/v1/refunds', new URLSearchParams({ payment_intent: intent(id), amount: String(amount) }));
  const paid = await lose('bud-lost-refunded');
  await payAt(paid);
  const held = await lose('bud-lost-held', ['NL']);
  await payAt(held, 'country=NL&card_country=DE');   // complete, its payment held
  const realNow = Date.now;
  Date.now = () => realNow() + 67 * 60_000;
  try {
    refundAt(paid, 1000);
    const part = await retire('bud-lost-refunded');
    assert.equal(part.status, 409, 'refunded in part');
    assert.equal(attemptsOf('bud-lost-refunded').length, 1);
    assert.equal((await retire('bud-lost-held')).status, 409, 'its held payment can still be charged');
    // the rest in 100 refunds, so the 1000 is on Stripe's second page of 100 (newest first)
    for (let i = 0; i < 99; i++) refundAt(paid, 1);
    assert.equal((await retire('bud-lost-refunded')).status, 409, '1099 of 3995 refunded');
    refundAt(paid, 2896);
    const newest = payments.imitation('GET', `/v1/refunds?payment_intent=${intent(paid)}&limit=100`, new URLSearchParams());
    assert.deepEqual([newest.has_more, newest.data.reduce((n: number, r: any) => n + r.amount, 0)], [true, 2995]);
    assert.deepEqual((await retire('bud-lost-refunded')).json, { reference: 'bud-lost-refunded' });
    assert.deepEqual([rowsOf('bud-lost-refunded'), attemptsOf('bud-lost-refunded')], [[], []]);
    payments.imitation('POST', `/v1/payment_intents/${intent(held)}/cancel`, new URLSearchParams());
    assert.deepEqual((await retire('bud-lost-held')).json, { reference: 'bud-lost-held' }, 'its held payment was let go');
  } finally { Date.now = realNow; }
});

test('a lost create stays checked under a later retry and under a later session, whatever that one asked', async () => {
  writeFileSync(`${DATA}/secrets/STRIPE_TEST_RESTRICTED_KEY`, 'rk_test_abc123');
  const realNow = Date.now, at = (minutes: number) => { Date.now = () => realNow() + minutes * 60_000; };
  const lose = async (reference: string) => {
    loseCreate = true;
    assert.notEqual((await call('/api/pay/checkout', as('pebblet'), order({ reference }))).status, 200);
    return lostId;
  };
  const expireAt = (id: string) => payments.imitation('POST', `/v1/checkout/sessions/${id}/expire`, new URLSearchParams());
  try {
    // paid, then a retry 40 minutes on whose answer got lost too: a new minute, so a new key
    await payAt(await lose('bud-over-lost'));
    at(40);
    await lose('bud-over-lost');
    assert.equal(attemptsOf('bud-over-lost').length, 2, 'both creates are kept');
    // paid, then a retry in another language that opened a session of its own, which expired
    await payAt(await lose('bud-over-paid'));
    const paidLater = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-over-paid', locale: 'nl' }));
    assert.equal(paidLater.status, 200, paidLater.text);
    expireAt(paidLater.json.id);
    // still open, then a retry in another language that opened a session of its own, which was paid and refunded
    const openLost = await lose('bud-over-open');
    const openLater = await call('/api/pay/checkout', as('pebblet'), order({ reference: 'bud-over-open', locale: 'nl' }));
    assert.notEqual(openLater.json.id, openLost);
    await payAt(openLater.json.id);
    assert.equal((await call('/api/pay/refund', as('pebblet'), { id: openLater.json.id })).json.refunded, true);
    assert.equal(attemptsOf('bud-over-open').length, 1, 'the later session clears only its own create');
    const before = ['bud-over-paid', 'bud-over-open'].map(ref => [rowsOf(ref), attemptsOf(ref)]);
    const r = await retire('bud-over-open');
    assert.equal(r.status, 409, 'the lost session is still open');
    at(107);   // past every session's expiry
    for (const reference of ['bud-over-lost', 'bud-over-paid']) {
      const refusal = await retire(reference);
      assert.equal(refusal.status, 409, `${reference}: the first, paid session stays`);
    }
    assert.equal(attemptsOf('bud-over-lost').length, 2);
    assert.deepEqual([rowsOf('bud-over-paid'), attemptsOf('bud-over-paid')], before[0]);
    // its own refunded session is HQ's to judge, not a completed one HQ has no record of
    assert.deepEqual((await retire('bud-over-open')).json, { reference: 'bud-over-open' });
    assert.deepEqual([rowsOf('bud-over-open'), attemptsOf('bud-over-open')], [[], []]);
    assert.equal(stripeSession(openLost).status, 'expired');
  } finally { Date.now = realNow; }
});

test("the log's payment lines go 90 days after they were written; other lines stay", async () => {
  const insert = db.prepare("insert into events (ts, type, agent, text) values (?, 'log', 'bolt', ?)");
  const daysAgo = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
  insert.run(daysAgo(91), 'Payments: pebblet: bud-log-old is paid (test, €39.95).');
  insert.run(daysAgo(89), 'Payments: pebblet: bud-log-new is paid (test, €39.95).');
  insert.run(daysAgo(91), 'Watch: an old line about something else');
  await payments.tick();
  const left = db.prepare("select text from events where text like '%bud-log-%' or text like 'Watch: an old line%' order by id").all().map((e: any) => e.text);
  assert.deepEqual(left, ['Payments: pebblet: bud-log-new is paid (test, €39.95).', 'Watch: an old line about something else']);
});
