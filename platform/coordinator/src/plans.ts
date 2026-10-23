// What a payer holds of a product's plans (pricing.ts): paid by the month or up front for a set number of months, read
// back, and stopped (house rules 2 and 3). Its endpoints are in payments.ts's header; payments.ts's caller() keeps live
// mode refused without the board's launch approval.
//
// Starting and stopping take the same: one call each. A monthly plan is a Stripe subscription that recurs until the payer
// stops it, which ends it at its paid period's end. Up front is one payment that never renews. A tester's voucher (the
// board's tester invite, shares.ts) pays one plan once, with no card and nothing recurring.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.ts';
import { address } from './mailout.ts';
import * as payments from './payments.ts';
import type { Caller, Refused } from './payments.ts';
import * as pricing from './pricing.ts';
import type { Choice, Plans } from './pricing.ts';

// open: its checkout isn't paid yet; held: paid (it may have ended since: paid_until); expired: unpaid or confirmed ended.
// months: null for monthly; total: what each payment is (a month's, or the whole stretch's); subscription: Stripe's, for
// monthly; stopped: when the payer stopped a monthly plan; voucher: the tester's voucher that paid it; asked: a hash of the
// checkout's choice and pages, to hand an open one out again.
db.exec(`create table if not exists plan_holdings (id text primary key, created text not null, updated text not null,
  product text not null, mode text not null, payer text not null, plan text not null, tiers text not null, months integer,
  total integer not null, status text not null, subscription text, paid_at text, paid_until text, stopped text, voucher text,
  asked text)`);
db.exec('create index if not exists plan_holdings_payer on plan_holdings (product, mode, payer)');
type Holding = {
  id: string;
  created: string;
  updated: string;
  product: string;
  mode: 'test' | 'live';
  payer: string;
  plan: string;
  tiers: string;
  months: number | null;
  total: number;
  status: 'open' | 'held' | 'expired';
  subscription: string | null;
  paid_at: string | null;
  paid_until: string | null;
  stopped: string | null;
  voucher: string | null;
  asked: string | null;
};
// A holding as the payer stands with it now: owing while its monthly plan's renewal failed and Stripe still tries to charge it
type Standing = Holding & { owing: boolean };

const PAYER = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_LIFE_S = 3660; // Stripe wants at least 30 minutes; it ends within the hour after its minute
const stamp = () => new Date().toISOString();
const heldRefusal: Refused = [
  409,
  'this payer holds a plan already: it can be stopped, and a new one starts once it has ended',
  'plan_held',
];
const owingRefusal: Refused = [
  409,
  "this payer's monthly plan couldn't be paid again and can still charge them: it holds again once paid, or it can be stopped",
  'plan_owing',
];
const processingRefusal: Refused = [
  409,
  "this payer's checkout is paid but its payment hasn't settled yet: a new one can start once it has",
  'payment_processing',
];

// ---- the routes: the product's plans, and a payer's (payer: the product's id for them)
type Route = (c: Caller, plans: Plans, b: any) => unknown;
const ROUTES: Record<string, Route> = {
  'GET /api/pay/plans': (_c, plans) => pricing.shownOf(plans),
  'GET /api/pay/plans/quote': (_c, plans, b) => quote(plans, b),
  'POST /api/pay/plans/checkout': (c, plans, b) => forPayer(c, b, () => openCheckout(c, plans, b)),
  'POST /api/pay/plans/voucher': (c, plans, b) => forPayer(c, b, () => payByVoucher(c, plans, b)),
};
const HOLDING_ROUTES: Record<string, (c: Caller, b: any) => unknown> = {
  'GET /api/pay/plans/held': (c, b) => forPayer(c, b, () => held(c, b.payer)),
  'POST /api/pay/plans/stop': (c, b) => forPayer(c, b, () => stop(c, b.payer)),
};
export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x'),
    path = `${req.method} ${url.pathname}`,
    route = ROUTES[path],
    holdingRoute = HOLDING_ROUTES[path];
  const asked = await payments.productRequest(req, res);
  if (!asked) return;
  const { caller: c, body: b } = asked;
  if (!route && !holdingRoute) return payments.json(res, 404, { error: 'not found' });
  try {
    if (holdingRoute) return payments.reply(res, await holdingRoute(c, b));
    const plans = pricing.plansOf(c.slug);
    if (!plans) return payments.json(res, 404, { error: "this product's manifest names no plans" });
    return payments.reply(res, await route(c, plans, b));
  } catch (err) {
    if (err instanceof pricing.PlansError) return payments.json(res, 409, { error: err.message });
    if (err instanceof payments.StripeError) return payments.json(res, err.status, { error: err.message });
    throw err;
  }
}
// One payer's checkouts, reads, stops and vouchers, one at a time: a double tap finds the first one's checkout
const forPayer = (c: Caller, b: any, run: () => Promise<unknown>) =>
  PAYER.test(String(b.payer ?? ''))
    ? serial(c, b.payer, run)
    : ([400, 'payer: 1-64 letters, digits, _ or -'] as Refused);
const serial = <T>(c: Caller, payer: string, run: () => Promise<T>) =>
  payments.serial(`plan:${c.slug}:${c.mode}:${payer}`, run);

function quote(plans: Plans, b: any) {
  const choice = pricing.choiceOf(plans, b);
  return Array.isArray(choice) ? choice : pricing.quoteOf(choice);
}

// ---- starting: a checkout for the chosen plan, its tiers and its period
async function openCheckout(c: Caller, plans: Plans, b: any) {
  const ask = checkoutAsk(c, plans, b);
  if (Array.isArray(ask)) return ask;
  const handedOut = await heldOrOpen(c, b.payer, ask.asked);
  if (Array.isArray(handedOut)) return handedOut;
  if (handedOut) return { id: handedOut.id, url: handedOut.url, expires_at: handedOut.expires_at, total: ask.total };
  if (!payments.countCheckout(c)) return [429, 'too many checkouts this hour'];
  const s = await createSession(c, b.payer, ask);
  const now = stamp();
  db.prepare(
    `insert or replace into plan_holdings (id, created, updated, product, mode, payer, plan, tiers, months, total, status, asked)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(
    s.id,
    now,
    now,
    c.slug,
    c.mode,
    b.payer,
    ask.choice.plan.id,
    tiersOf(ask.choice),
    ask.choice.months,
    ask.total,
    ask.asked,
  );
  payments.log(
    `${c.slug} opened a ${c.mode} checkout for plan ${ask.choice.plan.id} (${periodOf(ask.choice.months)}, ${payments.euros(ask.total, 'eur')}).`,
  );
  return { id: s.id, url: s.url, expires_at: s.expires_at, total: ask.total };
}
type Ask = {
  choice: Choice;
  total: number;
  success: string;
  cancel: string;
  locale: string;
  email: string | null;
  asked: string;
};
// What a checkout asks for, checked; asked: its hash, the same for a second tap
function checkoutAsk(c: Caller, plans: Plans, b: any): Ask | Refused {
  const choice = pricing.choiceOf(plans, b);
  if (Array.isArray(choice)) return choice;
  const success = payments.returnUrl(b.success_url, c.slug),
    cancel = payments.returnUrl(b.cancel_url, c.slug);
  const locale = b.locale == null || b.locale === '' ? 'auto' : String(b.locale);
  const emailGiven = b.customer_email != null && b.customer_email !== '',
    email = emailGiven ? (address(b.customer_email)?.toLowerCase() ?? null) : null;
  const total = pricing.totalOf(choice, choice.months),
    range = `${payments.euros(payments.MIN, 'eur')} to ${payments.euros(payments.MAX, 'eur')}`;
  if (total < payments.MIN || total > payments.MAX)
    return [400, `a payment of ${payments.euros(total, 'eur')}: one is ${range}`];
  if (!success || !cancel) return [400, "success_url and cancel_url: https, on this product's own address"];
  if (!payments.LOCALES.has(locale)) return [400, "locale: one of Stripe Checkout's (auto, en, nl, de, fr...)"];
  if (emailGiven && email === null) return [400, 'customer_email: an email address'];
  const asked = createHash('sha256')
    .update(JSON.stringify([pricing.quoteOf(choice), success, cancel, locale, email]))
    .digest('hex')
    .slice(0, 16);
  return { choice, total, success, cancel, locale, email, asked };
}
// Monthly: a subscription, every part recurring each month, cards only (a renewal by any other way settles later). Up
// front: one payment for the months, in the ways the product names. The idempotency key names this payer's attempt, its
// minute and what was asked: a retry after a lost answer gets the same session.
async function createSession(c: Caller, payer: string, ask: Ask) {
  const { choice } = ask,
    monthly = choice.months === null,
    named = monthly ? ['card'] : payments.methods(c.slug);
  const items = [choice.plan, ...choice.tiers].map(part => ({
    quantity: 1,
    price_data: {
      currency: 'eur',
      unit_amount: part.month * (choice.months ?? 1),
      product_data: { name: monthly ? part.name : `${part.name}, ${choice.months} months` },
      ...(monthly ? { recurring: { interval: 'month' } } : {}),
    },
  }));
  const attempt = (
    db
      .prepare('select count(*) n from plan_holdings where product = ? and mode = ? and payer = ?')
      .get(c.slug, c.mode, payer) as { n: number }
  ).n;
  const minute = Math.floor(Date.now() / 60_000),
    meta = { product: c.slug, plan: choice.plan.id };
  const params = {
    mode: monthly ? 'subscription' : 'payment',
    success_url: ask.success,
    cancel_url: ask.cancel,
    line_items: items,
    locale: ask.locale,
    customer_email: ask.email ?? undefined,
    metadata: meta,
    ...(monthly ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }),
    excluded_payment_method_types: payments.EXCLUDABLE.filter(m => !named.includes(m)),
    expires_at: minute * 60 + SESSION_LIFE_S,
  };
  return payments.stripe(
    c.mode,
    'POST',
    '/v1/checkout/sessions',
    params,
    `plan-${c.slug}-${c.mode}-${payer}-${attempt}-${minute}-${ask.asked}`,
  );
}
// What the payer has that a new plan would add to: why not (a plan held, a monthly one still charging, or a checkout paid
// or settling meanwhile), or its open checkout that asked the same (asked; null for none), every other one ended first.
// Else null.
async function heldOrOpen(c: Caller, payer: string, asked: string | null) {
  const standing = await holding(c, payer);
  if (standing) return standing.owing ? owingRefusal : heldRefusal;
  const open = db
    .prepare("select * from plan_holdings where product = ? and mode = ? and payer = ? and status = 'open'")
    .all(c.slug, c.mode, payer) as Holding[];
  const refusalOf = (state: 'paid' | 'processing') => (state === 'paid' ? heldRefusal : processingRefusal);
  for (const row of open) {
    const s = await settle(row);
    if (s === 'paid' || s === 'processing') return refusalOf(s);
    if (!s) continue;
    if (row.asked === asked && s.url) return s;
    try {
      await payments.stripe(c.mode, 'POST', `/v1/checkout/sessions/${row.id}/expire`);
    } catch (err) {
      if (!(err instanceof payments.StripeError && err.status === 400)) throw err;
    }
    const ended = await settle(row);
    if (ended === 'paid' || ended === 'processing') return refusalOf(ended);
  }
  return null;
}
const tiersOf = (choice: Choice) => JSON.stringify(choice.tiers.map(t => t.id));
const periodOf = (months: number | null) =>
  months === null ? 'monthly' : `${months} ${months === 1 ? 'month' : 'months'} up front`;

// ---- what a payer holds now
async function held(c: Caller, payer: string) {
  const row = await holding(c, payer);
  return row ? viewOf(row) : { held: false };
}
// The plan the payer holds now, its open checkout read first (paid meanwhile, it's the one), a monthly one as Stripe has
// it now. Else a monthly one that's owing, or null.
async function holding(c: Caller, payer: string): Promise<Standing | null> {
  const rows = () =>
    db
      .prepare(
        "select * from plan_holdings where product = ? and mode = ? and payer = ? and status in ('open', 'held') order by created desc",
      )
      .all(c.slug, c.mode, payer) as Holding[];
  for (const row of rows()) if (row.status === 'open') await settle(row);
  let owing: Standing | null = null;
  for (const row of rows()) {
    // Scheduled cancellation can still owe after its cached period ends. Only the provider confirms it ended.
    const over = Date.parse(row.paid_until ?? '') <= Date.now();
    if (row.status !== 'held' || (over && !row.subscription)) continue;
    const now = row.subscription ? await renewed(row) : { ...row, owing: false };
    if (Date.parse(now.paid_until ?? '') > Date.now()) return now;
    if (now.owing) owing ??= now;
  }
  return owing;
}
// An open checkout as Stripe has it (payments.ts sessionState): paid, it's held from now (a monthly plan for its
// subscription's period, up front for its months); ended unpaid, expired; paid but not settled, it stays open. → 'paid',
// 'processing', the session while it's open, or null.
async function settle(row: Holding) {
  let s;
  try {
    s = await payments.stripe(row.mode, 'GET', `/v1/checkout/sessions/${row.id}`);
  } catch (err) {
    if (!(err instanceof payments.StripeError && err.status === 404)) throw err;
  }
  let state = s ? payments.sessionState(s) : 'ended';
  if (state === 'open') return s;
  if (state === 'processing' && s.payment_intent) {
    const id = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id;
    const intent = await payments.stripe(row.mode, 'GET', `/v1/payment_intents/${encodeURIComponent(id)}`);
    if (intent.status === 'requires_payment_method' || intent.status === 'canceled') state = 'ended';
  }
  if (state === 'processing') return 'processing';
  if (state === 'ended') {
    db.prepare("update plan_holdings set status = 'expired', updated = ? where id = ?").run(stamp(), row.id);
    return null;
  }
  const now = stamp(),
    subscription = typeof s.subscription === 'string' ? s.subscription : (s.subscription?.id ?? null);
  const paidUntil = row.months === null ? null : new Date(pricing.addMonths(Date.now(), row.months)).toISOString();
  db.prepare(
    "update plan_holdings set status = 'held', paid_at = ?, paid_until = ?, subscription = ?, updated = ? where id = ? and status = 'open'",
  ).run(now, paidUntil, subscription, now, row.id);
  if (subscription) await renewed({ ...row, subscription });
  payments.log(`${row.product}: plan ${row.plan} is paid (${row.mode}, ${periodOf(row.months)}).`);
  return 'paid';
}
// A monthly plan as its subscription has it now: paid until its period's end while it's active, stopped once it's set to
// end there or has ended. Any other is paid until nothing more. One whose renewal failed is owing: Stripe keeps trying to
// charge it until it's paid (active again) or ended.
const OWING = new Set(['past_due', 'unpaid', 'incomplete']);
async function renewed(row: Holding, subscription?: any): Promise<Standing> {
  const sub =
    subscription ??
    (await payments.stripe(row.mode, 'GET', `/v1/subscriptions/${encodeURIComponent(row.subscription!)}`));
  const end = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end; // (on the item since Stripe's 2025-03-31 API)
  const active = (sub.status === 'active' || sub.status === 'trialing') && Number.isInteger(end),
    owing = OWING.has(sub.status),
    ended = sub.status === 'canceled' || sub.status === 'incomplete_expired';
  const stopped = ended || (sub.cancel_at_period_end && !owing) ? (row.stopped ?? stamp()) : null;
  const until = active
    ? new Date(end * 1000).toISOString()
    : new Date(Math.min(Date.parse(row.paid_until ?? stamp()), Date.now())).toISOString();
  if (ended) db.prepare("update plan_holdings set status = 'expired' where id = ?").run(row.id);
  if (until !== row.paid_until || stopped !== row.stopped)
    db.prepare('update plan_holdings set paid_until = ?, stopped = ?, updated = ? where id = ?').run(
      until,
      stopped,
      stamp(),
      row.id,
    );
  return { ...row, paid_until: until, stopped, owing };
}
// What the product reads back: held while it's paid, the plan, its tiers, monthly or up front, what each payment was, until
// when it's paid, stopped or not, whether it renews by itself, whether a tester's voucher paid it, and owing or not
const viewOf = (row: Standing) => ({
  held: Date.parse(row.paid_until ?? '') > Date.now(),
  plan: row.plan,
  tiers: JSON.parse(row.tiers) as string[],
  period: row.months === null ? 'monthly' : 'up_front',
  months: row.months,
  total: row.total,
  paid_until: row.paid_until,
  stopped: !!row.stopped,
  renews: row.months === null && !row.stopped,
  voucher: !!row.voucher,
  owing: row.owing,
});

// ---- stopping: one call ends a monthly plan at its paid period's end, or an owing one now (it has no paid period left,
// and Stripe stops trying to charge it once it has ended)
async function stop(c: Caller, payer: string) {
  const row = await holding(c, payer);
  if (!row) return [404, 'this payer holds no plan', 'plan_none'] as Refused;
  if (row.months !== null || row.stopped) return viewOf(row);
  const sub = `/v1/subscriptions/${encodeURIComponent(row.subscription!)}`;
  const subscription = row.owing
    ? await payments.stripe(c.mode, 'DELETE', sub)
    : await payments.stripe(c.mode, 'POST', sub, { cancel_at_period_end: true }, `plan-stop-${row.subscription}`);
  let stopped = await renewed(row, subscription);
  if (stopped.owing) {
    const ended = await payments.stripe(c.mode, 'DELETE', sub);
    stopped = await renewed(stopped, ended);
  }
  const ends =
    Date.parse(stopped.paid_until ?? '') <= Date.now() ? 'it has ended' : `it ends ${stopped.paid_until?.slice(0, 10)}`;
  payments.log(`${c.slug}: a monthly plan ${row.plan} was stopped (${c.mode}): ${ends}.`);
  return viewOf(stopped);
}

// ---- a tester's voucher: one plan, paid once, no card
async function payByVoucher(c: Caller, plans: Plans, b: any) {
  const voucher = payments.testerVoucher;
  const code = c.mode === 'test' ? voucher.find?.(b.voucher, c.slug) : undefined;
  if (!code || !voucher.use) return [404, 'no such code', 'code_unknown'] as Refused;
  const choice = pricing.choiceOf(plans, b);
  if (Array.isArray(choice)) return choice;
  if (voucher.viewer?.(code) !== b.payer) return [409, "this voucher is another tester's", 'code_other'] as Refused;
  const spent = voucher.unusable?.(code);
  if (spent) return spent;
  const months = choice.months ?? 1,
    total = pricing.totalOf(choice, months);
  const overCap = (): Refused | null => {
    const cap = voucher.cap?.(code);
    if (cap === undefined || total <= cap) return null;
    const over = `this plan comes to ${payments.euros(total, 'eur')}, and this voucher pays up to ${payments.euros(cap, 'eur')}`;
    return [409, over, 'tester_cap', { cap }];
  };
  const capped = overCap();
  if (capped) return capped;
  // a checkout still open ends first: paid after this, it would be a second plan
  const inTheWay = await heldOrOpen(c, b.payer, null);
  if (inTheWay) return inTheWay;
  // (from here to the voucher spent, nothing is awaited: its invite may have ended during the awaits)
  const endedSince = voucher.unusable?.(code);
  if (endedSince) return endedSince;
  const cappedSince = overCap();
  if (cappedSince) return cappedSince;
  const id = `pl_test_tester_${randomBytes(12).toString('hex')}`,
    now = stamp(),
    paidUntil = new Date(pricing.addMonths(Date.now(), months)).toISOString();
  db.exec('begin');
  try {
    db.prepare(
      `insert into plan_holdings (id, created, updated, product, mode, payer, plan, tiers, months, total, status, paid_at, paid_until, voucher)
      values (?, ?, ?, ?, 'test', ?, ?, ?, ?, ?, 'held', ?, ?, ?)`,
    ).run(id, now, now, c.slug, b.payer, choice.plan.id, tiersOf(choice), months, total, now, paidUntil, code);
    const why = voucher.use(code, id);
    if (why) throw new Error(`a tester's voucher for ${c.slug} could not be spent: ${why[1]}`);
    db.exec('commit');
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
  payments.log(
    `${c.slug}: a tester's voucher paid plan ${choice.plan.id} for ${months} ${months === 1 ? 'month' : 'months'} (test).`,
  );
  return viewOf({ ...(db.prepare('select * from plan_holdings where id = ?').get(id) as Holding), owing: false });
}

// What a plan holding was for, by name (the plan's, then its tiers'), for the board's list of a tester invite (shares.ts),
// or null when it's no plan's
export function bought(id: string): string[] | null {
  const row = db.prepare('select product, plan, tiers from plan_holdings where id = ?').get(id) as
    Pick<Holding, 'product' | 'plan' | 'tiers'> | undefined;
  return row ? pricing.namesOf(row.product, row.plan, JSON.parse(row.tiers)) : null;
}

// Every 2 minutes (server.ts): open checkouts are read, so a paid one is held from when it was paid, not from the payer's
// next look
export async function tick() {
  for (const row of db.prepare("select * from plan_holdings where status = 'open'").all() as Holding[]) {
    try {
      await serial({ slug: row.product, mode: row.mode }, row.payer, () => settle(row));
    } catch (err) {
      console.error(`Plans: could not read checkout ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
}
export const start = () => {
  setInterval(() => void tick(), 2 * 60_000);
};
