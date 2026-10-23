// node --test src/players.test.ts   (hq preview --player: an agent job's own test player on the preview of a
// product with plans, and its voucher; the harness's server, whose imitation plays Stripe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';
import { productHeaders } from './fixture.ts';

const h = await harness('players', {
  env: { PUBLIC_HOST: 'hq.company.test' },
  before: repo => {
    const product = (slug: string, files: Record<string, string>) => {
      mkdirSync(`${repo}/products/${slug}`, { recursive: true });
      for (const [name, text] of Object.entries(files)) writeFileSync(`${repo}/products/${slug}/${name}`, text);
    };
    product('rocket', {
      'product.yaml': 'name: Rocket\nstatus: preview\nowner: bolt\nplans: plans.yaml\n',
      'plans.yaml':
        'plans:\n  - {id: plan, name: Basic, month: 500, up_front: [6, 12], tiers: [extra]}\ntiers:\n  - {id: extra, name: Extra, month: 400}\n',
    });
    product('front', { 'product.yaml': 'name: The shop\nstatus: preview\nowner: bolt\nbasket:\n  countries: [NL]\n' });
  },
});
const as = await productHeaders();
const feedback = await import('./feedback.ts');
const guests = await import('./guests.ts');

const HQ = 'hq.company.test',
  ROCKET = 'rocket.preview.company.test';
const ask = (run: Running, slug: string, player?: string) =>
  h.agent('preview-passes', run.token, { slug, ...(player === undefined ? {} : { player }) });
const passOf = async (run: Running, player?: string) => {
  const r = await ask(run, 'rocket', player);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { cookie: string; voucher?: string };
};
// Caddy's forward_auth for a page of the preview: its status and the X-Viewer it hands the product
const check = async (cookie: string, query = '', host = ROCKET) => {
  const r = await h.send(`/api/preview/check${query}`, {
    host: HQ,
    cookie,
    'x-forwarded-host': host,
    'x-forwarded-uri': '/',
  });
  return { status: r.status, viewer: r.headers['x-viewer'] as string | undefined };
};
// the game asking HQ's payments tool, as its preview's test connection does
const product = as('rocket');
const pay = (path: string, body?: Record<string, unknown>) => h.send(`/api/pay/plans/${path}`, product, body);

test('a test player is asked for by name on a product with plans only, and a pass without one stays view-only', async () => {
  const run = await h.start({ agent: 'wren', title: 'QA' });
  assert.equal((await ask(run, 'hello', 'qa')).status, 409, 'hello has no plans');
  assert.equal((await ask(run, 'front', 'qa')).status, 409, "the shop's door has none either");
  for (const name of ['', 'QA', '-qa', 'q a', 'x'.repeat(33), 7])
    assert.equal((await ask(run, 'rocket', name as string)).status, 400);
  const plain = await passOf(run);
  assert.equal(plain.voucher, undefined);
  assert.deepEqual(await check(plain.cookie), { status: 200, viewer: undefined }, 'no player: watch only');
  await h.finish(run);
});

test("a test player is its own on that product and run: never the board's or a tester's, the same on each pass, another by name", async () => {
  const run = await h.start({ agent: 'wren', title: 'QA' });
  const qa = await passOf(run, 'qa');
  assert.match(qa.voucher!, /^TESTER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const id = (await check(qa.cookie)).viewer!;
  assert.match(id, /^vw_[a-f0-9]{32}$/);
  const again = await passOf(run, 'qa');
  assert.equal(again.voucher, qa.voucher, "the same player's voucher");
  assert.equal((await check(again.cookie)).viewer, id, 'the same player on another pass');
  const other = await passOf(run, 'qb');
  assert.notEqual(other.voucher, qa.voucher);
  assert.notEqual((await check(other.cookie)).viewer, id);

  // the board's and a tester's ids are theirs
  const link = await h.board('/api/preview/link', { url: `https://${ROCKET}/` });
  const code = new URL(link.body.url).searchParams.get('c')!;
  const board = String((await h.send(`/__preview?c=${code}&to=/`, { host: ROCKET })).headers['set-cookie']).split(
    ';',
  )[0];
  const share = feedback.inviteToShare({
    page: `https://${ROCKET}/`,
    name: 'Tess',
    email: 'tess@example.com',
    days: 3,
    tester: true,
  }) as any;
  const session = `session-${share.id}`;
  h.db
    .prepare('insert into review_share_sessions (hash, share, guest, seal, host) values (?, ?, ?, ?, ?)')
    .run(createHash('sha256').update(session).digest('hex'), share.id, 'Tess', guests.seal('Tess'), ROCKET);
  const others = [(await check(board)).viewer, (await check(`ps=${session}`)).viewer];
  assert.equal(new Set([id, ...others]).size, 3);

  // and the pass's other limits hold: no chat route, no hand-off, no other host, never HQ
  assert.equal((await check(qa.cookie, '?board=1')).status, 403);
  const handoff = await h.send(
    '/__preview/handoff',
    { host: ROCKET, cookie: qa.cookie, origin: `https://${ROCKET}`, 'content-type': 'application/json' },
    { to: '/' },
  );
  assert.equal(handoff.status, 403);
  assert.equal((await check(qa.cookie, '', 'hello.preview.company.test')).status, 302);
  assert.equal((await h.send('/api/jobs', { host: HQ, cookie: qa.cookie })).status, 401);
  assert.ok(
    (await h.board(`/api/jobs/log?id=${run.id}`)).body.some((line: { text: string }) =>
      line.text.includes(`Preview pass: test player qa, with a test voucher, on ${ROCKET}`),
    ),
    'HQ logs the test player pass',
  );
  feedback.endShare({ id: share.id });
  await h.finish(run);
});

test('a test player plays the plans: reads its own, starts and stops a test plan, and its voucher pays one plan for it once, within its amount', async () => {
  const run = await h.start({ agent: 'wren', title: 'QA' });
  // one player starts and stops a monthly test plan by checkout
  const buyer = await passOf(run, 'buyer');
  const payer = (await check(buyer.cookie)).viewer!;
  assert.equal((await pay(`held?payer=${payer}`)).json.held, false);
  const opened = await pay('checkout', {
    payer,
    plan: 'plan',
    period: 'monthly',
    success_url: `https://${ROCKET}/plan`,
    cancel_url: `https://${ROCKET}/plan`,
  });
  assert.equal(opened.status, 200, opened.text);
  await h.send(`/pay/imitation/${opened.json.id}/pay`, { origin: `https://${HQ}` }, '');
  assert.equal((await pay(`held?payer=${payer}`)).json.held, true);
  const stopped = await pay('stop', { payer });
  assert.equal(stopped.json.stopped, true);
  assert.equal(stopped.json.renews, false);

  // another takes one with its voucher: its own only, within €50, once
  const taker = await passOf(run, 'voucher');
  const own = (await check(taker.cookie)).viewer!;
  const redeem = (who: string, choice: Record<string, unknown>) =>
    pay('voucher', { payer: who, voucher: taker.voucher, ...choice });
  assert.equal((await redeem(payer, { plan: 'plan', period: 'monthly' })).json.why, 'code_other');
  assert.equal((await redeem(own, { plan: 'plan', tiers: ['extra'], period: 12 })).json.why, 'tester_cap');
  const took = await redeem(own, { plan: 'plan', period: 6 });
  assert.equal(took.status, 200, took.text);
  assert.equal(took.json.voucher, true);
  assert.equal((await pay(`held?payer=${own}`)).json.months, 6);
  assert.equal((await redeem(own, { plan: 'plan', period: 6 })).json.why, 'code_used');
  const line = await h.send('/api/pay/line', product, {
    reference: 'test-item',
    amount: 500,
    description: 'Test item',
    order_url: `https://${ROCKET}/order/test-item`,
  });
  assert.equal(line.status, 200, line.text);
  const front = as('front');
  const basket = await h.send('/api/pay/basket/add', front, { line: line.json.line, claim: line.json.claim });
  assert.equal(basket.status, 200, basket.text);
  const entered = await h.send('/api/pay/basket/code', front, {
    basket: basket.json.basket,
    code: taker.voucher,
    country: 'NL',
  });
  assert.equal(entered.json.why, 'code_unknown', "the shop's code box never takes it");

  // its run over, nothing it holds opens or pays
  const spare = await passOf(run, 'spare');
  const sparesOwn = (await check(spare.cookie)).viewer!;
  await h.finish(run);
  assert.equal((await check(spare.cookie)).status, 302);
  const late = await pay('voucher', { payer: own, voucher: spare.voucher, plan: 'plan', period: 'monthly' });
  assert.equal(late.json.why, 'code_other');
  assert.equal(
    (await pay('voucher', { payer: sparesOwn, voucher: spare.voucher, plan: 'plan', period: 'monthly' })).json.why,
    'code_expired',
  );
});
