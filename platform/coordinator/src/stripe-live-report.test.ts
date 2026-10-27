// node --test src/stripe-live-report.test.ts   (infra/stripe_live.mjs, the status report's "== stripe, live" section, over
// the live baskets the shop's routes make in a throwaway hq.db, against a stand-in Stripe: types and codes only)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { harness } from './harness.ts';

const h = await harness('stripe-live', {
  env: { PUBLIC_HOST: 'hq.company.test' },
  before: repo => {
    const product = (slug: string, yaml: string) => {
      mkdirSync(`${repo}/products/${slug}`, { recursive: true });
      writeFileSync(`${repo}/products/${slug}/product.yaml`, yaml);
    };
    product('front', 'name: The shop\nstatus: live\nbasket:\n  countries: [NL, BE, DE]\n');
    product('alpha', 'name: Alpha\nstatus: live\n');
    product('beta', 'name: Beta\nstatus: live\n');
  },
});
const { dataDir: DATA, send: call } = h;
const payments = await import('./payments.ts');
const approvals = await import('./approvals.ts');
const REPORT = new URL('../../../infra/stripe_live.mjs', import.meta.url).pathname;

// The buyer's details, where Stripe keeps them: none may reach the report
const BUYER = {
  name: 'Sanne de Vries',
  email: 'sanne@example.com',
  phone: '+31612345678',
  address: { line1: 'Lindelaan 12', postal_code: '1234 AB', city: 'Utrecht', country: 'NL' },
};

// A stand-in for api.stripe.com in live mode: the imitation's sessions under live ids, and for the report's reads, each
// session as a test gives it (answers), with the buyer's details on it
const answers = new Map<string, Record<string, unknown> | 404>();
const asTest = (path: string) => path.replace('cs_live_', 'cs_test_');
const asLive = (out: any) =>
  JSON.parse(JSON.stringify(out).replaceAll('cs_test_', 'cs_live_').replace('"livemode":false', '"livemode":true'));
const stripe = createServer(async (q, s) => {
  let body = '';
  for await (const c of q) body += c;
  const reply = (status: number, out: unknown) => {
    s.writeHead(status, { 'content-type': 'application/json', 'stripe-version': '2026-09-30.clover' });
    s.end(JSON.stringify(out));
  };
  if (q.headers.authorization !== 'Bearer rk_live_standin1')
    return reply(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key' } });
  const url = new URL(q.url!, 'http://stripe'),
    id = url.pathname.replace('/v1/checkout/sessions/', '');
  if (url.pathname === '/v1/account')
    return reply(200, { id: 'acct_1Planted', charges_enabled: true, payouts_enabled: true });
  const answer = q.method === 'GET' ? answers.get(id) : undefined;
  if (answer === 404)
    return reply(404, {
      error: {
        code: 'resource_missing',
        type: 'invalid_request_error',
        message: `No such checkout.session: ${id} (Sanne)`,
      },
    });
  try {
    const out = asLive(
      payments.imitation(
        q.method as 'GET' | 'POST',
        asTest(url.pathname),
        new URLSearchParams(body),
        q.headers['idempotency-key'] as string | undefined,
      ),
    );
    reply(200, answer ? { ...out, customer_email: BUYER.email, customer_details: BUYER, ...answer } : out);
  } catch (e: any) {
    reply(e.status ?? 500, { error: { message: e.message } });
  }
});
await new Promise<void>(r => stripe.listen(0, r));
test.after(() => stripe.close());
process.env.STRIPE_API = `http://localhost:${(stripe.address() as any).port}`;
writeFileSync(`${DATA}/secrets/STRIPE_LIVE_RESTRICTED_KEY`, 'rk_live_standin1');
for (const [i, slug] of ['front', 'alpha', 'beta'].entries()) approvals.record(`live:${slug}`, 900 + i);

const as = (slug: string, mode = 'live') => ({
  authorization: `Bearer ${payments.tokenFor(slug, mode)}`,
  'x-product': slug,
  'x-mode': mode,
});
const host = (slug: string, mode: string) =>
  mode === 'live' ? `${slug}.company.test` : `${slug}.preview.company.test`;
let lines = 0;
async function line(slug: string, amount = 3995, mode = 'live') {
  const reference = `${slug.slice(0, 3)}-report-${++lines}`;
  const r = await call('/api/pay/line', as(slug, mode), {
    reference,
    amount,
    description: `${slug} poster`,
    order_url: `https://${host(slug, mode)}/order/${reference}`,
  });
  assert.equal(r.status, 200, r.text);
  return r.json;
}
async function add(basket: string | undefined, l: { line: string; claim: string }, mode = 'live') {
  const r = await call('/api/pay/basket/add', as('front', mode), { basket, line: l.line, claim: l.claim });
  assert.equal(r.status, 200, r.text);
  return r.json.basket as string;
}
async function checkout(basket: string, country = 'NL', mode = 'live') {
  const r = await call('/api/pay/basket/checkout', as('front', mode), {
    basket,
    email: 'sanne@example.com',
    locale: 'nl',
    deliver_to: { name: BUYER.name, line1: 'Lindelaan 12', postCode: '1234 AB', city: 'Utrecht', country },
    success_url: `https://${host('front', mode)}/order-done/?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `https://${host('front', mode)}/checkout/`,
  });
  assert.equal(r.status, 200, r.text);
  return r.json.id as string;
}
const one = async (country = 'NL', mode = 'live') =>
  checkout(await add(undefined, await line('alpha', 3995, mode), mode), country, mode);
// a session as the imitation keeps it: when it opened, and its page's life in minutes
const kept = (s: string) =>
  payments.imitation('GET', asTest(`/v1/checkout/sessions/${s}`), new URLSearchParams()) as any;
const life = (s: string) => Math.round((kept(s).expires_at - kept(s).created) / 60);
// The report section as report.sh runs it: the coordinator's node, the script on stdin
function report() {
  const child = spawn('node', ['--disable-warning=ExperimentalWarning', '--input-type=module'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, DATA_DIR: DATA, SECRETS_DIR: `${DATA}/secrets` },
  });
  createReadStream(REPORT).pipe(child.stdin);
  let out = '';
  child.stdout.on('data', chunk => (out += chunk));
  return new Promise<string>((done, fail) =>
    child.on('close', code => (code === 0 ? done(out) : fail(new Error(`the report section exited ${code}`)))),
  );
}

test('the latest unpaid live checkouts as Stripe has them: types and codes only, never an id, name, email or address', async () => {
  const older = [await one(), await one()];
  // a live basket of two stalls' things whose page expired (its basket changed: a third thing), then opened again
  const two = await add(await add(undefined, await line('alpha')), await line('beta', 2995));
  const expired = await checkout(two);
  await add(two, await line('beta', 2995));
  const reopened = await checkout(two);
  // tried and declined, left at the bank, planted, gone at Stripe, never tried (in Germany)
  const [declined, left, planted, gone, untried] = [
    await one(),
    await one(),
    await one(),
    await one(),
    await one('DE'),
  ];
  // and the rows it leaves out: a paid one, and a test-mode one
  const paid = await one();
  assert.equal(
    (await call(`/pay/imitation/${asTest(paid)}/pay`, { origin: 'https://hq.company.test' }, '')).status,
    303,
  );
  await payments.tick();
  await one('NL', 'test');

  answers.set(declined, {
    status: 'expired',
    payment_intent: {
      id: 'pi_3PlantedIntent01',
      object: 'payment_intent',
      status: 'requires_payment_method',
      created: kept(declined).created + 200,
      cancellation_reason: null,
      payment_method: null,
      receipt_email: BUYER.email,
      last_payment_error: {
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        message: 'Your card has insufficient funds.',
        payment_method: { id: 'pm_1PlantedMethod01', type: 'card', billing_details: BUYER },
      },
      latest_charge: {
        id: 'ch_3PlantedCharge01',
        created: kept(declined).created + 240,
        failure_code: 'card_declined',
        failure_message: 'Sanne',
        billing_details: BUYER,
        payment_method_details: { type: 'card', card: { last4: '4242' } },
      },
    },
  });
  answers.set(left, {
    locale: 'auto',
    metadata: { product: 'front', methods: 'd434b61caee7' }, // an older session: what HQ left out, as a hash
    payment_intent: {
      id: 'pi_3PlantedIntent02',
      status: 'requires_action',
      created: kept(left).created + 600,
      cancellation_reason: null,
      last_payment_error: null,
      latest_charge: null,
      payment_method: { id: 'pm_1PlantedMethod02', type: 'ideal', billing_details: BUYER },
    },
  });
  answers.set(planted, {
    status: 'Sanne de Vries',
    payment_status: 'sanne@example.com',
    locale: 'Lindelaan 12',
    payment_method_types: ['Sanne', 'pi_3plantedintent03', 'sanne@example.com'],
    metadata: { named: 'Sanne pi_3plantedintent03 sanne@example.com', methods: 'Lindelaan 12' },
    payment_intent: {
      id: 'pi_3PlantedIntent03',
      status: 'Utrecht',
      created: kept(planted).created + 60,
      cancellation_reason: 'Sanne',
      payment_method: { id: 'pm_1PlantedMethod03', type: 'Sanne de Vries' },
      last_payment_error: { code: '1234 AB', decline_code: 'pm_1plantedmethod03' },
      latest_charge: 'ch_3PlantedCharge03',
    },
  });
  answers.set(gone, 404);
  for (const s of [older[0], expired, reopened, untried]) answers.set(s, {});
  answers.set(older[1], { status: undefined, payment_intent: undefined }); // fields missing from Stripe's answer: not known, never none

  const out = await report();
  const rows = out
    .split('\n')
    .filter(r => /^\| \d{4}-/.test(r))
    .map(r => r.split(' | ').slice(1).join(' | '));
  assert.match(out, /How far the latest 8 unpaid live checkouts got \(Stripe API version 2026-09-30\.clover;/);
  const methods = `${kept(untried).payment_method_types.join(' ')} | ${kept(untried).metadata.named}`,
    open = (s: string) => `open/unpaid | NL | nl | ${methods} | - | - | - | - | - | ${life(s)} |`;
  assert.equal(
    kept(untried).metadata.named,
    'card',
    'what HQ named (no setting here: cards), beside what Stripe offered',
  );
  assert.deepEqual(
    rows,
    [
      `alpha | 39.95 | open/unpaid | DE | nl | ${methods} | - | - | - | - | - | ${life(untried)} |`,
      'alpha | 39.95 | Stripe 404: resource_missing |',
      `alpha | 39.95 | ?/? | NL | ? | ? ? ? | ? ? ? | ? | ? | ? | ?/? | 1 | ${life(planted)} |`,
      `alpha | 39.95 | open/unpaid | NL | auto | ${kept(left).payment_method_types.join(' ')} | #d434b61caee7 | ideal | requires_action | - | - | 10 | ${life(left)} |`,
      `alpha | 39.95 | expired/unpaid | NL | nl | ${methods} | card | requires_payment_method | - | card_declined/insufficient_funds | 4 | ${life(declined)} |`,
      `alpha beta | 99.85 | ${open(reopened)}`,
      `alpha beta | 69.90 | ${open(expired).replace('open/', 'expired/')}`,
      `alpha | 39.95 | ?/unpaid | NL | nl | ${methods} | - | ? | - | - | - | ${life(older[1])} |`,
    ],
    'the paid, the test-mode and older checkouts are left out',
  );
  for (const word of [
    'Sanne',
    'sanne',
    'example.com',
    'Lindelaan',
    '1234',
    'Utrecht',
    '+316',
    '4242',
    'cs_live_',
    'cs_test_',
    'pi_',
    'pm_',
    'ch_',
    'acct_',
    'bk_',
    'rk_live',
    'insufficient funds',
  ])
    assert.ok(!out.includes(word), `${word}: no id, name, email or address reaches the report`);
});
