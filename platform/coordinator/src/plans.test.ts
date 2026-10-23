// node --test src/plans.test.ts   (the harness; no Stripe key, so the imitation plays Stripe)
// A product's own plans: monthly or up front, read back per payer, stopped in one call, and a tester's voucher that pays
// one of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { productHeaders } from './fixture.ts';

const h = await harness('plans', { env: { PUBLIC_HOST: 'hq.company.test' } });
const { db, repo, send } = h;
const payments = await import('./payments.ts');
const shares = await import('./shares.ts');
const feedback = await import('./feedback.ts');
const guests = await import('./guests.ts');

const product = (slug: string, files: Record<string, string>) => {
  mkdirSync(`${repo}/products/${slug}`, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(`${repo}/products/${slug}/${name}`, text);
};
product('rocket', {
  'product.yaml': 'name: Rocket\nstatus: preview\nowner: bolt\nplans: plans.yaml\n',
  'plans.yaml': `plans:
  - {id: plan, name: Basic, month: 500, up_front: [6, 12], tiers: [extra, more]}
tiers:
  - {id: extra, name: Extra, month: 400}
  - {id: more, name: More, month: 200}
tester:
  en: Open the menu and take a plan with the voucher below.
`,
});
product('comet', {
  'product.yaml': `name: Comet\nstatus: preview\nowner: bolt\nplans:\n  plans:\n    - {id: solo, name: Solo, month: 300, monthly: false, up_front: [3]}\n`,
});
product('front', { 'product.yaml': 'name: The shop\nstatus: preview\nowner: bolt\nbasket:\n  countries: [NL]\n' });
product('pebblet', { 'product.yaml': 'name: Pebblet\nstatus: preview\nowner: bolt\n' });

const as = await productHeaders();
const back = {
  success_url: 'https://rocket.preview.company.test/paid?s={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://rocket.preview.company.test/plans',
};
const held = (payer: string, slug = 'rocket') => send(`/api/pay/plans/held?payer=${payer}`, as(slug)).then(r => r.json);
const checkout = (payer: string, choice: Record<string, unknown>, slug = 'rocket') =>
  send('/api/pay/plans/checkout', as(slug), { payer, ...back, ...choice });
// The payer's own step: Pay on the checkout's page (the imitation's, on HQ)
// (form: method=sepa_debit settles later; renewals=decline, a card whose later charges are declined)
const pay = (id: string, form = '') => send(`/pay/imitation/${id}/pay`, { origin: 'https://hq.company.test' }, form);

test("a product's plans come from its own files, and a choice's total is the same in its quote, its checkout and its page", async () => {
  const listed = await send('/api/pay/plans', as('rocket'));
  assert.deepEqual(listed.json, {
    plans: [
      {
        id: 'plan',
        name: 'Basic',
        month: 500,
        monthly: true,
        up_front: [6, 12],
        tiers: ['extra', 'more'],
      },
    ],
    tiers: [
      { id: 'extra', name: 'Extra', month: 400 },
      { id: 'more', name: 'More', month: 200 },
    ],
  });
  assert.equal((await send('/api/pay/plans', as('comet'))).json.plans[0].id, 'solo', 'inline in the manifest too');
  assert.equal((await send('/api/pay/plans', as('pebblet'))).status, 404, 'no plans named, none offered');

  const quote = (await send('/api/pay/plans/quote?plan=plan&tiers=more&period=12', as('rocket'))).json;
  assert.deepEqual(quote, { plan: 'plan', tiers: ['more'], period: 'up_front', months: 12, total: 12 * 700 });
  const opened = await checkout('quote-payer', { plan: 'plan', tiers: ['more'], period: 12 });
  assert.equal(opened.status, 200, opened.text);
  assert.equal(opened.json.total, quote.total);
  assert.match((await send(`/pay/imitation/${opened.json.id}`)).text, /€84\.00/);
  const monthly = (await send('/api/pay/plans/quote?plan=plan&tiers=more,extra&period=monthly', as('rocket'))).json;
  assert.equal(monthly.total, 500 + 200 + 400);

  for (const [choice, why] of [
    [{ plan: 'gold', period: 'monthly' }, 'plan_unknown'],
    [{ plan: 'plan', tiers: ['more', 'more'], period: 'monthly' }, 'tier_unknown'],
    [{ plan: 'plan', tiers: ['loot'], period: 'monthly' }, 'tier_unknown'],
    [{ plan: 'plan', period: 3 }, 'period_unknown'],
  ] as const)
    assert.equal((await checkout('quote-payer-2', choice)).json.why, why);
  assert.equal(
    (await checkout('quote-payer-2', { plan: 'solo', period: 'monthly' }, 'comet')).json.why,
    'period_unknown',
    'up front only',
  );
});

test('a malformed plans file is refused in words that name what is wrong', async () => {
  product('broken', {
    'product.yaml':
      'name: Broken\nstatus: preview\nowner: bolt\nplans:\n  plans:\n    - {id: plan, name: Plan, month: 4.99}\n',
  });
  const r = await send('/api/pay/plans', as('broken'));
  assert.equal(r.status, 409);
  assert.match(r.json.error, /month/);
});

// Starting is one call and the payer's Pay; stopping is one call, whose answer is already final: no page, nothing to confirm
test('monthly: free, then paid and renewing each month, then stopped in one call, held to the end of its paid month, then free', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2028-01-31T12:00:00Z') });
  assert.deepEqual(await held('vw_monthly'), { held: false });
  const start = await checkout('vw_monthly', { plan: 'plan', tiers: ['extra'], period: 'monthly' });
  assert.equal(start.status, 200, start.text);
  assert.deepEqual(await held('vw_monthly'), { held: false }, 'not before it is paid');
  assert.equal((await pay(start.json.id)).status, 303);
  const holding = await held('vw_monthly');
  assert.equal(holding.held, true);
  assert.deepEqual(
    { ...holding, paid_until: undefined },
    {
      held: true,
      plan: 'plan',
      tiers: ['extra'],
      period: 'monthly',
      months: null,
      total: 900,
      paid_until: undefined,
      stopped: false,
      renews: true,
      voucher: false,
      owing: false,
    },
  );
  assert.equal(holding.paid_until, '2028-02-29T12:00:00.000Z');

  // a month later it has been paid again by itself
  t.mock.timers.setTime(Date.parse('2028-03-03T12:00:00Z'));
  const renewed = await held('vw_monthly');
  assert.equal(renewed.paid_until, '2028-03-31T12:00:00.000Z');
  assert.equal(renewed.renews, true);

  const stop = await send('/api/pay/plans/stop', as('rocket'), { payer: 'vw_monthly' });
  assert.equal(stop.status, 200, stop.text);
  assert.deepEqual(
    { stopped: stop.json.stopped, renews: stop.json.renews, held: stop.json.held, url: stop.json.url },
    { stopped: true, renews: false, held: true, url: undefined },
  );
  assert.equal(stop.json.paid_until, renewed.paid_until, 'held to the end of the month it paid for');
  assert.deepEqual(await held('vw_monthly'), stop.json);
  assert.deepEqual(
    (await send('/api/pay/plans/stop', as('rocket'), { payer: 'vw_monthly' })).json,
    stop.json,
    'stopping again changes nothing',
  );

  t.mock.timers.setTime(Date.parse(renewed.paid_until) + 60_000);
  assert.deepEqual(await held('vw_monthly'), { held: false }, 'not paid again: it has ended');
  t.mock.timers.reset();
});

test('a stopped monthly plan ends after a restart too, and another can start then', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2028-01-31T12:00:00Z') });
  const start = await checkout('vw_restart', { plan: 'plan', period: 'monthly' });
  assert.equal((await pay(start.json.id)).status, 303);
  const stop = await send('/api/pay/plans/stop', as('rocket'), { payer: 'vw_restart' });
  assert.equal(stop.json.paid_until, '2028-02-29T12:00:00.000Z');
  const subscription = payments.imitation(
    'GET',
    `/v1/checkout/sessions/${start.json.id}`,
    new URLSearchParams(),
  ).subscription;

  // HQ started again: the same database, the imitation fresh in memory, and its period over meanwhile
  // @ts-expect-error the query makes a fresh copy of the module, a path TypeScript can't resolve
  const restarted: typeof payments = await import('./payments.ts?restart');
  t.mock.timers.setTime(Date.parse('2028-03-03T12:00:00Z'));
  assert.equal(
    restarted.imitation('GET', `/v1/subscriptions/${subscription}`, new URLSearchParams()).status,
    'canceled',
    'its subscription is still there, and ended at its period',
  );
  assert.deepEqual(await held('vw_restart'), { held: false });
  const again = await checkout('vw_restart', { plan: 'plan', period: 6 });
  assert.equal(again.status, 200, again.text);
  t.mock.timers.reset();
});

test('up front: paid once for its months, never renewing, and free again after them', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-31T12:00:00Z') });
  const start = await checkout('vw_upfront', { plan: 'plan', period: 6 });
  assert.equal(start.status, 200, start.text);
  await pay(start.json.id);
  const holding = await held('vw_upfront');
  assert.deepEqual(
    { ...holding, paid_until: undefined },
    {
      held: true,
      plan: 'plan',
      tiers: [],
      period: 'up_front',
      months: 6,
      total: 6 * 500,
      paid_until: undefined,
      stopped: false,
      renews: false,
      voucher: false,
      owing: false,
    },
  );
  assert.equal(holding.paid_until, '2026-07-31T12:00:00.000Z');
  assert.deepEqual(
    (await send('/api/pay/plans/stop', as('rocket'), { payer: 'vw_upfront' })).json,
    holding,
    'nothing to stop',
  );
  assert.equal(
    payments.imitation('GET', `/v1/checkout/sessions/${start.json.id}`, new URLSearchParams()).subscription,
    null,
  );
  t.mock.timers.setTime(Date.parse(holding.paid_until) + 60_000);
  assert.deepEqual(await held('vw_upfront'), { held: false });
  t.mock.timers.reset();
});

test('one checkout per payer: a second tap gets the same one, another choice ends the first, and a payer holding a plan gets none', async () => {
  const first = await checkout('vw_double', { plan: 'plan', period: 'monthly' });
  const again = await checkout('vw_double', { plan: 'plan', period: 'monthly' });
  assert.equal(again.json.id, first.json.id);
  const other = await checkout('vw_double', { plan: 'plan', period: 12 });
  assert.notEqual(other.json.id, first.json.id);
  assert.equal(
    payments.imitation('GET', `/v1/checkout/sessions/${first.json.id}`, new URLSearchParams()).status,
    'expired',
  );
  await pay(other.json.id);
  assert.equal((await checkout('vw_double', { plan: 'plan', period: 'monthly' })).json.why, 'plan_held');
  assert.equal((await send('/api/pay/plans/stop', as('rocket'), { payer: 'vw_nobody' })).json.why, 'plan_none');
  assert.equal((await held('vw_double', 'comet')).held, false, "a product reads only its own payers' plans");
});

test('live mode stays refused without the board’s launch approval', async () => {
  const r = await send('/api/pay/plans/held?payer=vw_live', as('rocket', 'live'));
  assert.equal(r.status, 403);
});

// ---- who is looking, and a tester's voucher
const HOST = 'rocket.preview.company.test';
const viewerOf = async (cookie: string, host = HOST, uri = '/') => {
  const r = await send('/api/preview/check', { cookie, 'x-forwarded-host': host, 'x-forwarded-uri': uri });
  assert.equal(r.status, 200);
  return String(r.headers['x-viewer']);
};
// A tester's session on the preview, as the door's Open leaves it (shares.ts accept)
function sessionFor(share: number, guest: string, host = HOST) {
  const session = `session-${share}-${guest}`;
  db.prepare('insert into review_share_sessions (hash, share, guest, seal, host) values (?, ?, ?, ?, ?)').run(
    createHash('sha256').update(session).digest('hex'),
    share,
    guest,
    guests.seal(guest),
    host,
  );
  return `ps=${session}`;
}
const invite = (name: string, cap?: number, page = `https://${HOST}/`) =>
  feedback.inviteToShare({
    page,
    name,
    email: `${name.toLowerCase()}@example.com`,
    days: 3,
    tester: true,
    ...(cap ? { cap } : {}),
  }) as any;
const voucherOf = (share: number, name: string) => shares.people(share).find(p => p.guest === name)!.voucher!;
const redeem = (payer: string, voucher: string, choice: Record<string, unknown>) =>
  send('/api/pay/plans/voucher', as('rocket'), { payer, voucher, ...choice });

test('each viewer of a preview has an id of their own there, the same on every request and different on every product', async () => {
  const link = await h.board('/api/preview/link', { url: `https://${HOST}/` });
  const code = new URL(link.body.url).searchParams.get('c')!;
  const accepted = await send(`/__preview?c=${code}&to=/`, { host: HOST });
  const board = String(accepted.headers['set-cookie']).split(';')[0];
  const share = invite('Vera');
  const vera = sessionFor(share.id, 'Vera');
  const ids = [await viewerOf(board), await viewerOf(vera)];
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.match(id, /^vw_[a-f0-9]{32}$/);
  assert.equal(await viewerOf(vera, HOST, '/game/'), ids[1], 'the same on every page');
  assert.equal(await viewerOf(board), ids[0]);
  assert.notEqual(await viewerOf(board, 'comet.preview.company.test'), ids[0], "another product's is another id");
  const onFront = (uri: string) => viewerOf(board, 'front.preview.company.test', uri);
  const [front, rocket] = [await onFront('/'), await onFront('/rocket/')];
  assert.notEqual(front, rocket, "a shelf on the shop's door is its product's");
  for (const uri of ['/ROCKET/game?x=1', '/x/..%2frocket/', '/%72ocket/'])
    assert.equal(await onFront(uri), rocket, `${uri}: as Caddy routes it`);
  for (const uri of ['/rocket%zz/', '/rocket/..%2f', '/pebbles/']) assert.equal(await onFront(uri), front, uri);
  feedback.endShare({ id: share.id });
});

test("a tester invite opens on a product with plans, not on one without; the shop's stays as it was", async () => {
  assert.equal(invite('Pim', undefined, 'https://pebblet.preview.company.test/')[0], 400);
  product('meteor', { 'product.yaml': 'name: Meteor\nstatus: preview\nowner: bolt\nplans: {plans: [{id: plan}]}\n' });
  const broken = await h.board('/api/review/shares', {
    page: 'https://meteor.preview.company.test/',
    name: 'Pim',
    email: 'pim@example.com',
    days: 3,
    tester: true,
  });
  assert.equal(broken.status, 409);
  assert.match(broken.body.error, /meteor's plans/, 'it names what to fix');
  const made = invite('Pim');
  assert.equal(made.tester, true);
  assert.equal(made.pays, 'plan');
  assert.equal(invite('Pim', undefined, 'https://front.preview.company.test/').pays, 'order');
  const voucher = voucherOf(made.id, 'Pim');
  assert.equal(payments.testerVoucher.find!(voucher), undefined, "the shop's code box doesn't take it");
  assert.equal(payments.testerVoucher.find!(voucher, 'rocket'), voucher);
  for (const s of shares.list()) if (!s.ended) feedback.endShare({ id: s.id });
});

test("a tester's voucher pays one plan for its own tester, up to its invite's amount, once, with nothing recurring, and counts as their order", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-31T12:00:00Z') });
  const share = invite('Tess', 30);
  const session = sessionFor(share.id, 'Tess');
  const [tess, other] = [await viewerOf(session), 'vw_someone_else'];
  const voucher = voucherOf(share.id, 'Tess');
  const typed = `tester-${voucher.slice(6, 10)} ${voucher.slice(10)}`; // as a person types it
  assert.equal((await redeem(other, voucher, { plan: 'plan', period: 6 })).json.why, 'code_other');
  assert.equal((await redeem(tess, 'TESTER-AAAA-BBBB-CCCC', { plan: 'plan', period: 6 })).json.why, 'code_unknown');
  const over = await redeem(tess, typed, { plan: 'plan', tiers: ['more'], period: 6 });
  assert.deepEqual([over.status, over.json.why, over.json.cap], [409, 'tester_cap', 3000]);
  assert.equal(shares.orderOf(shares.people(share.id).find(p => p.guest === 'Tess')!), null, 'refused, nothing spent');
  assert.equal(shares.allIn(share.id), false);

  const sessions = () =>
    payments.imitation('GET', '/v1/checkout/sessions?limit=100', new URLSearchParams()).data.length;
  const before = sessions();
  const paid = await redeem(tess, typed, { plan: 'plan', period: 6 });
  assert.equal(sessions(), before, 'no checkout, no card');
  assert.equal(paid.status, 200, paid.text);
  assert.deepEqual(
    { ...paid.json, paid_until: undefined },
    {
      held: true,
      plan: 'plan',
      tiers: [],
      period: 'up_front',
      months: 6,
      total: 3000,
      paid_until: undefined,
      stopped: false,
      renews: false,
      voucher: true,
      owing: false,
    },
  );
  assert.equal(paid.json.paid_until, '2026-07-31T12:00:00.000Z');
  assert.deepEqual(await held(tess), paid.json);
  assert.equal((await redeem(tess, voucher, { plan: 'plan', period: 6 })).json.why, 'code_used', "it can't pay twice");
  assert.deepEqual(shares.orderedFrom(shares.people(share.id).find(p => p.guest === 'Tess')!), ['Basic']);

  // its notes sent, it's everyone's order and notes: the invite ends
  const sent = await send(
    '/__review/submit',
    { host: HOST, cookie: session, origin: `https://${HOST}`, 'content-type': 'application/json' },
    {},
  );
  assert.equal(sent.status, 200, sent.text);
  feedback.gather();
  assert.equal(shares.byId(share.id)!.ended_by, 'everyone');
  t.mock.timers.setTime(Date.parse(paid.json.paid_until) + 60_000);
  assert.deepEqual(await held(tess), { held: false }, 'it never renews');
  t.mock.timers.reset();
});

test('a monthly choice on a voucher pays one month, and stops working once its invite ends', async () => {
  const share = invite('Ruud');
  const ruud = await viewerOf(sessionFor(share.id, 'Ruud'));
  const voucher = voucherOf(share.id, 'Ruud');
  feedback.endShare({ id: share.id });
  assert.equal((await redeem(ruud, voucher, { plan: 'plan', period: 'monthly' })).json.why, 'code_expired');

  const next = invite('Ines');
  const ines = await viewerOf(sessionFor(next.id, 'Ines'));
  const month = await redeem(ines, voucherOf(next.id, 'Ines'), {
    plan: 'plan',
    tiers: ['more'],
    period: 'monthly',
  });
  assert.equal(month.status, 200, month.text);
  assert.deepEqual(
    [month.json.period, month.json.months, month.json.renews, month.json.total],
    ['up_front', 1, false, 700],
  );
  assert.equal(
    (await send('/api/pay/plans/voucher', as('rocket', 'live'), { payer: ines, voucher: 'x', plan: 'plan', period: 6 }))
      .status,
    403,
  );
  feedback.endShare({ id: next.id });
});

test('a monthly plan whose renewal is declined is no longer held but still owing: no other plan starts over it, and stopping ends it at once', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-10T12:00:00Z') });
  const start = await checkout('vw_declined', { plan: 'plan', period: 'monthly' });
  await pay(start.json.id, 'renewals=decline');
  assert.equal((await held('vw_declined')).held, true);

  t.mock.timers.setTime(Date.parse('2026-04-11T12:00:00Z'));
  const owing = await held('vw_declined');
  assert.deepEqual([owing.held, owing.owing, owing.renews], [false, true, true]);
  assert.equal((await checkout('vw_declined', { plan: 'plan', period: 6 })).json.why, 'plan_owing');

  const stopped = await send('/api/pay/plans/stop', as('rocket'), { payer: 'vw_declined' });
  assert.equal(stopped.status, 200, stopped.text);
  assert.deepEqual(
    [stopped.json.held, stopped.json.owing, stopped.json.stopped, stopped.json.renews],
    [false, false, true, false],
  );
  const subscription = payments.imitation(
    'GET',
    `/v1/checkout/sessions/${start.json.id}`,
    new URLSearchParams(),
  ).subscription;
  assert.equal(
    payments.imitation('GET', `/v1/subscriptions/${subscription}`, new URLSearchParams()).status,
    'canceled',
    'Stripe charges it no more',
  );
  assert.deepEqual(await held('vw_declined'), { held: false });
  assert.equal((await checkout('vw_declined', { plan: 'plan', period: 6 })).status, 200, 'a new plan can start now');
  t.mock.timers.reset();
});

test('a checkout paid by a way that settles later is neither held nor replaced, by another checkout or a voucher, until it settles', async () => {
  const share = invite('Pia', 50);
  const pia = await viewerOf(sessionFor(share.id, 'Pia'));
  const start = await checkout(pia, { plan: 'plan', period: 6 });
  await pay(start.json.id, 'method=sepa_debit');
  assert.deepEqual(await held(pia), { held: false });
  assert.equal((await checkout(pia, { plan: 'plan', period: 12 })).json.why, 'payment_processing');
  assert.equal(
    (await redeem(pia, voucherOf(share.id, 'Pia'), { plan: 'plan', period: 6 })).json.why,
    'payment_processing',
  );
  feedback.endShare({ id: share.id });
});

test("a voucher ends its tester's open checkout first, so paying that checkout afterwards can't start a second plan", async () => {
  const share = invite('Olga', 50);
  const olga = await viewerOf(sessionFor(share.id, 'Olga'));
  const open = await checkout(olga, { plan: 'plan', period: 'monthly' });
  assert.equal(open.status, 200, open.text);
  assert.equal((await redeem(olga, voucherOf(share.id, 'Olga'), { plan: 'plan', period: 12 })).json.why, 'tester_cap');
  assert.equal(
    payments.imitation('GET', `/v1/checkout/sessions/${open.json.id}`, new URLSearchParams()).status,
    'open',
  );
  const paid = await redeem(olga, voucherOf(share.id, 'Olga'), { plan: 'plan', period: 6 });
  assert.equal(paid.status, 200, paid.text);
  assert.equal((await pay(open.json.id)).status, 409, 'its checkout has ended');
  assert.deepEqual(await held(olga), paid.json);
  feedback.endShare({ id: share.id });
});

test('sold plans remain readable and stoppable after the catalogue is removed or invalidated', async () => {
  for (const [suffix, catalogue] of [
    ['removed', ''],
    ['invalid', 'plans: {plans: [{id: plan, name: Basic, month: 4.99}]}'],
  ]) {
    const slug = `legacy-${suffix}`;
    const manifest = 'name: Legacy\nstatus: preview\nowner: bolt\n';
    product(slug, { 'product.yaml': manifest + 'plans: {plans: [{id: plan, name: Basic, month: 500}]}\n' });
    const start = await checkout(
      'payer',
      {
        plan: 'plan',
        period: 'monthly',
        success_url: `https://${slug}.preview.company.test/paid`,
        cancel_url: `https://${slug}.preview.company.test/plans`,
      },
      slug,
    );
    assert.equal(start.status, 200, start.text);
    await pay(start.json.id);
    assert.equal((await held('payer', slug)).held, true);
    product(slug, { 'product.yaml': manifest + catalogue + '\n' });
    assert.equal((await held('payer', slug)).held, true, suffix);
    const stopped = await send('/api/pay/plans/stop', as(slug), { payer: 'payer' });
    assert.equal(stopped.status, 200, stopped.text);
    assert.equal(stopped.json.renews, false);
  }
});
