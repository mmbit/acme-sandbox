// Payments: Stripe as a gated tool (house rules 2, 7 and 8). The Stripe key never leaves the coordinator. A product
// container gets a token for its own slug and mode (infra/products.py writes it into the product's env file) and asks
// here to open a Checkout Session, check it, expire it or refund it in full. Live mode refuses to run without the
// board's launch approval for that product (approvals.ts), and each mode only accepts its own kind of key.
//
// No webhook: "paid" is what Stripe says when we ask for the session, server to server with our key, so it's verified
// without a public endpoint (previews sit behind the board login). Products poll a pending order's session, the same
// way they poll Print API. Without a test key, test mode runs against the imitation at the bottom of this file.
//
//   POST /api/pay/checkout  {amount (cents), currency: 'eur', reference, description, success_url, cancel_url,
//                            locale?: Stripe's (en, nl, de...; auto by default), customer_email?: prefills Stripe's page,
//                            countries?: the sale's territory, two-letter codes (NL, BE...)}
//                                    → {id, url, expires_at, countries}
//                                    It offers only what the shop names (methods()), of what Stripe's dashboard has on.
//                                    With countries, see "A territory's sale" below; the answer echoes them (null without).
//   GET  /api/pay/session?id=cs_...   → {id, reference, status: open|complete|expired|released, paid, amount, currency,
//                                        refunded, refund_status: null|pending|requires_action|succeeded|failed|canceled,
//                                        fee, fee_currency, country}
//                                     fee: Stripe's actual fee in cents (of fee_currency), from the charge's balance
//                                     transaction, null until a lookup that runs beside the answer has it (read again
//                                     later); country: the payer's billing country as Stripe's checkout took it, or
//                                     null; released: a territory's payment that was held and let go, never charged
// A territory's sale (countries): Stripe only holds the payment (capture_method manual, cards and Link) and asks for the
// billing address. The first session read after the payer pays decides it: HQ charges the hold when the billing country
// and the card's issuing country (Link's funding country for Link) agree and are in countries. Otherwise HQ releases it.
// Those are the two non-contradictory pieces of location evidence EU VAT asks for (Regulation 282/2011, art. 24b and
// 24f), so the product knows where its paid buyer is before any money moves, and `country` is that place. The key needs
// write access to PaymentIntents.
//   POST /api/pay/expire    {id}      an unpaid session can't be paid any more (the order was cancelled)
//   POST /api/pay/expire/open         → {expired}: none of the product's open sessions in its mode can be paid any more
//                                     (its ordering closed); one paid meanwhile stays paid. In live mode it is also the
//                                     product's word that its ordering is closed on purpose, for CLOSED_MS: HQ's watch
//                                     then checks its pages alone. A product that keeps it closed asks again within that
//                                     time.
//   POST /api/pay/refund    {id}      the whole amount back, once (a cancelled or misprinted order). `refunded` only once
//                                     Stripe says the refund succeeded; after a failed one, calling it again tries anew.
//   POST /api/pay/retire {reference}  → {reference}: the order is past the product's own retention, so HQ forgets it;
//                                     409 keeps the order's records while a checkout may still be paid, or is paid and
//                                     not refunded (retire())
//   GET  /api/pay/methods             → {methods: ['card', 'ideal', ...]}: what the shop names before ordering starts,
//                                     the setting (methods()); a checkout leaves out everything else it can
//   GET  /api/pay/ready               → {ready}: whether a payment can go through now (ready()), so a shop says so before
//                                     anyone starts making something
//   POST /api/pay/payer {id, email}   → {match}: whether the product's own paid session was paid from that email (case
//                                     aside), the same answer for a session it doesn't have. The email never comes back.
//   POST /api/pay/payer/sessions {email} → {sessions: [{id, reference}]}: the product's paid sessions in its mode paid from
//                                     that email, newest first, at most 20 (of Stripe's latest 100 for it). Stripe matches
//                                     the email as the checkout had it. HQ lower-cases customer_email at checkout.
//                                     Both are for a support chat's order lookups (platform/care's order endpoint).
// One basket over every product: a product registers each order as a line with
// its price, server to server; the front (the shop, approvals.ts FRONT) puts lines in a basket at the customer's
// request and opens one Checkout Session over them, with the delivery address taken once; each product sees and
// refunds only its own line. A line changing while its session is open expires that session.
//   POST /api/pay/line  {reference, amount, description, order_url, ships_in?, cutoff?, voucher?, detail?, picture?}  → the line (view)
//                                     detail: what's on the item (a name), shown in the shop and its email, never sent to
//                                     Stripe; picture: a small picture of its own design on the product's address, which
//                                     the shop's basket shows
//                                     number: the order number its customer is told, set once (its number afterwards, its keeping and the shop's order history:
//                                     history.ts)
//   GET  /api/pay/line?id=ln_...      → {line, claim, status: open|checkout|paid|cancelled, card, deliver_to, email...}
//   POST /api/pay/line/cancel {id}    an unpaid line is cancelled (its open session expires)
//   POST /api/pay/line/refund {id}    what the card paid for a paid line, back to the basket's payment, once; a line its
//                                     voucher paid in full is closed once that voucher is released
//   POST /api/pay/line/forget {id}    → {line}: its customer asked the product to delete their details. The line's words
//                                     and order page go now; its basket's address and payer email as soon as no parcel
//                                     needs the address (forget_asked).
//   front only: POST /api/pay/basket/add {basket?, line, claim, replaces?}, /remove {basket, line}, /quantity {basket, line,
//   quantity, country?} (copies of a thing, 1 to the view's copies), /checkout {basket, deliver_to,
//   email, locale?, success_url, cancel_url, revision?}; GET /api/pay/basket?id=bk_...&country=NL, /basket/order?id=cs_...
//   The basket's view carries its revision (its lines and what the card pays for each); a checkout sent with the one
//   its page showed is refused (basket_changed) when the basket differs now.
//   A basket its vouchers pay in full is paid at /checkout itself: its url is the success_url. So is a basket holding the
//   shop's test code (isTestCode, below): a test order, paid nowhere and made nowhere, whose order view says test: true;
//   and a test basket holding a tester's voucher (testerVoucher, below): a tester order, paid nowhere and made for real,
//   whose views say tester: true.
// A refusal a customer
//   can reach carries `why`, for the shop to say in the customer's language: address_incomplete, postcode_invalid,
//   country_not_delivered, email_invalid, line_paid, line_cancelled, line_elsewhere, basket_full, basket_empty,
//   basket_gone, already_paid, payment_processing, not_approved, card_total_low, card_total_high, basket_changed,
//   test_limit (the why codes after card_total_*; test_limit).
//   The front's manifest names the countries it delivers to, the postage a basket saves per country, and the days after
//   its start a basket nobody paid for is deleted (basketRules; the days).
// A product's own plans (plans.ts): what a payer holds, paid by the month or up
// front for a set number of months, from the plans its manifest names. payer: the product's own id for the person, 1-64
// letters, digits, _ or - (on a preview, the X-Viewer Caddy gives it: preview.ts). A choice is {plan, tiers?: [ids],
// period: 'monthly' | months}. Its total, VAT included, is the same in every answer: the plan's and its tiers' price a
// month, times the months.
//   GET  /api/pay/plans               → {plans: [{id, name, month, monthly, up_front, tiers}], tiers: [{id, name, month}]}
//   GET  /api/pay/plans/quote?plan=&tiers=a,b&period=  → {plan, tiers, period, months, total}
//   POST /api/pay/plans/checkout {payer, plan, tiers?, period, success_url, cancel_url, locale?, customer_email?}
//                                     → {id, url, expires_at, total}: monthly recurs every month until stopped (cards
//                                     only); up front is paid once and never renews. 409 plan_held while the payer holds
//                                     one, plan_owing while a monthly one's renewal failed and it can still charge,
//                                     payment_processing while a checkout's payment hasn't settled.
//   GET  /api/pay/plans/held?payer=   → {held: false} or {held, plan, tiers, period: monthly|up_front, months, total,
//                                     paid_until, stopped, renews, voucher, owing}: held while it's paid; owing (held:
//                                     false) while a monthly one's renewal failed and Stripe still tries to charge it.
//   POST /api/pay/plans/stop {payer}  → the same: a monthly plan stops at the end of its paid period, in this one call, and
//                                     an owing one ends now, charging nothing more. Up front never renews, so it stays as
//                                     it is. 404 plan_none without one.
//   POST /api/pay/plans/voucher {payer, voucher, plan, tiers?, period}  → the same, held at once: a tester's voucher for
//                                     this product's preview, test mode only, its own tester's only (code_other), up to its
//                                     invite's amount (tester_cap). It pays the months once (monthly: one), never renews
//                                     and asks for no card. It ends the payer's open checkouts first, and is refused as a
//                                     checkout is. Spent, it pays nothing again (code_used); its invite ended, none
//                                     (code_expired).
// Headers: authorization: Bearer <PAYMENTS_TOKEN>, x-product: <slug>, x-mode: test|live.
// A paid order's own emails to its customer: POST /api/pay/email (ordermail.ts).
// Whether a preview's viewer is the company's own (the board, a running job's test player): GET /api/pay/viewer?id=
// (preview.ts companyViewer).
// A closing product's full refunds, only with the board's recorded decision: /api/pay/closures (closures.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR, ORIGIN, PUBLIC_HOST, ZONE as zone } from './config.ts';
import { columnsOf, db, once, remember, setting } from './db.ts';
import { publish } from './events.ts';
import { secret } from './secrets.ts';
import { approved, FRONT, isPublic } from './approvals.ts';   // FRONT: the shelves
import { routedPath, shelfOf } from './shelves.ts';
import { manifest, servedDomain } from './manifests.ts';
import { companyDay, companyFormats, infra, roles, timeZone } from './company.ts';
import { addWorkingDays, workingDaysBetween } from './care.ts';   // a basket's ship dates
import { address } from './mailout.ts';
import * as printapi from './printapi.ts';
import * as pricing from './pricing.ts';
import { forgetHeldWords } from './held-lines.ts';
import { newNumber } from '../../../shared/ordernumber/ordernumber.js';
import { copiesOf } from '../../../shared/format/format.js';
import { readJson as readJsonBody } from '../../../shared/routes/routes.ts';

// Basket payments.
// - refund_asked: a refund whose answer isn't in yet, or was lost (refund()).
// - basket: the front's basket whose payment this session is.
// - deliver: its delivery address, kept until the products have had time to read it (sweep()).
// - country: its delivery country.
// - payer, locale: a basket paid by vouchers alone has no Stripe session to keep them (sessionOf).
// - territory: a territory sale's countries (territoryOf).
// - hold: what HQ did with its held payment, captured or released (decideHold).
// - forget_asked: a customer asked a product to delete their details (forgetLine).
// - fee, fee_currency: Stripe's actual fee once its balance transaction has it (settlement).
// - payer_hash: the keyed hash a basket's payer is found by (history.ts). Empty when Stripe had no email
//   or the customer asked us to delete their details.
db.exec(`create table if not exists payments (id text primary key, created text not null, product text not null,
  mode text not null, reference text not null, amount integer not null, currency text not null, status text not null,
  refund text, refund_status text, updated text not null, refund_asked text, basket text, deliver text, country text,
  shape text, payer text, locale text, territory text, hold text, forget_asked text, fee integer, fee_currency text,
  payer_hash text, number text)`);
db.exec('create index if not exists payments_payer_hash on payments (payer_hash)');
// Every session create whose answer HQ hasn't recorded, by its idempotency key, written before Stripe is asked: a retry
// after a lost answer reuses its key, and retire() checks what each one may have made. A retry with other parameters
// adds its own row, and a later answer clears only its own.
db.exec(`create table if not exists checkout_creates (key text primary key, product text not null, mode text not null,
  reference text not null, amount integer not null, attempt integer not null, minute integer not null)`);
// Basket lines, baskets (the front's), and what each session charged (session_lines).
// - detail: what's on the item.
// - offer: the product's offer price, which a code never takes from.
// - code_saved: what the basket's code took off it (codes.ts), also in session_lines.
// - goes_with: the shop's own line going with a thing in its basket (ownLines).
// - picture: the item's design on the product's address, shown in the basket (registerLine).
// - number: the order number the line's customer was told (history.ts).
// - quantity: how many copies of the line's thing the basket holds, each a thing of its own (setQuantity).
// - kept_until: the customer asked the product to keep what they made until then (the sweep below).
// The held columns belong to held-lines.ts:
// - held: when the product first said it holds the line.
// - held_why: its reason.
// - held_words: what its word check read.
// - held_revision: the hash of words and why the board answers for.
// - held_seen: its last report.
// - held_answer, held_answered: the board's answer and when it answered.
// - held_taken: when the product read it, after which it can't be taken back.
db.exec(`create table if not exists pay_lines (id text primary key, created text not null, product text not null, mode text not null,
  reference text not null, amount integer not null, currency text not null, description text not null, voucher integer,
  voucher_value integer, ships_in integer not null, cutoff integer not null, order_url text, basket text, position integer,
  status text not null, session text, card integer, saved integer, paid_at text, refund text, refund_status text,
  refund_asked text, updated text not null, detail text, offer integer, code_saved integer, goes_with text, picture text,
  number text, kept_until text, held text, held_why text, held_words text, held_revision text, held_seen text,
  held_answer text, held_answered text, held_taken text, quantity integer not null default 1,
  unique (product, mode, reference))`);
// A basket's test holds the shop's test code (isTestCode below), making checkout a test order.
// tester holds its tester voucher as its code (testerVoucher below), making checkout a tester order.
db.exec(`create table if not exists baskets (id text primary key, mode text not null, created text not null, updated text not null,
  status text not null, test integer, tester text)`);
db.exec(`create table if not exists session_lines (session text not null, line text not null, position integer not null,
  card integer not null, saved integer not null, code_saved integer, primary key (session, line))`);
once('payments-number-quantity', () => {
  if (!columnsOf('payments').includes('number')) db.exec('alter table payments add column number text');
  if (!columnsOf('pay_lines').includes('quantity')) db.exec('alter table pay_lines add column quantity integer not null default 1');
});
// basket_counted and checkout_counted: when the line's step was counted for its stall's funnel (lineSteps), null while
// it isn't
for (const column of ['basket_counted', 'checkout_counted'])
  if (!columnsOf('pay_lines').includes(column)) db.exec(`alter table pay_lines add column ${column} text`);
// number: a basket's order number, the one its customer is told (shared/ordernumber), given as it's paid (settle), to a test
// order as it's made, and here to every basket paid before numbers
db.exec('create unique index if not exists payments_number on payments (number) where number is not null');
const giveNumber = (session: string) => {
  let number: string;
  do number = newNumber();
  while (db.prepare('select 1 from payments where number = ?').get(number));
  db.prepare('update payments set number = ? where id = ? and number is null').run(number, session);
};
atOnce(() => {
  const before = db.prepare(`select id from payments where product = ? and basket is not null and number is null
    and status in ('paid', 'refunded', 'test') order by created`).all(FRONT) as { id: string }[];
  for (const { id } of before) giveNumber(id);
});
// A basket's order, by its session: its number, null before it's paid
export const orderNumber = (session: string) =>
  (db.prepare('select number from payments where id = ?').get(session) as { number: string | null } | undefined)?.number ?? null;

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/, REF = /^[A-Za-z0-9_-]{1,64}$/, SESSION = /^cs_(test|live)_[A-Za-z0-9_]{1,200}$/;
const LINE = /^ln_[a-f0-9]{24}$/, BASKET = /^bk_[a-f0-9]{32}$/;
export const MIN = 50, MAX = 50_000;        // €0.50 to €500 per checkout: Stripe's minimum, and far above any order we sell
const PER_HOUR = 120;                // checkouts per product and hour
const stripeApi = () => process.env.STRIPE_API ?? 'https://api.stripe.com';

// ---- who is calling: the product's token is an HMAC of its slug and mode under a key only the server holds.
// The key sits next to the key store, outside it, so no credential request can overwrite it.
const KEY_FILE = `${DATA_DIR}/payments.key`;
function signingKey() {
  if (!existsSync(KEY_FILE)) try { writeFileSync(KEY_FILE, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); } catch { /* made meanwhile */ }
  return readFileSync(KEY_FILE, 'utf8').trim();
}
signingKey();
// The same key signs the counting tokens (metrics.ts).
export const signed = (text: string) => createHmac('sha256', signingKey()).update(text).digest('hex');
export const tokenFor = (slug: string, mode: string) => signed(`pay:${slug}:${mode}`);

// (exported, with stripe, ownSession, refund, log, euros, json and readJson, for a company's own payment tools)
// A request's JSON: null past limit bytes or when it isn't JSON (shared/routes readJson)
export const readJson = (req: IncomingMessage, limit = 8192) => readJsonBody(req, limit);
export type Caller = { slug: string; mode: 'test' | 'live' };
export function caller(req: IncomingMessage): Caller | [number, string] {
  const slug = String(req.headers['x-product'] ?? ''), mode = String(req.headers['x-mode'] ?? '');
  const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!SLUG.test(slug) || (mode !== 'test' && mode !== 'live') || !/^[a-f0-9]{64}$/.test(token)) return [401, 'payments token'];
  if (!timingSafeEqual(Buffer.from(tokenFor(slug, mode)), Buffer.from(token))) return [401, 'payments token'];
  if (mode === 'live' && !approved(`live:${slug}`)) return [403, "live payments need the board's launch approval for this product"];
  return { slug, mode };
}

// Test mode takes only test keys and live mode only live ones, so a live key typed into the test field can't move money
// from a preview. Test mode without a key uses the imitation; live mode without one refuses.
function stripeKey(mode: 'test' | 'live') {
  const key = secret(mode === 'live' ? 'STRIPE_LIVE_RESTRICTED_KEY' : 'STRIPE_TEST_RESTRICTED_KEY');
  if (!key) return mode === 'test' ? 'imitation' : null;
  return new RegExp(`^(rk|sk)_${mode}_[A-Za-z0-9]+$`).test(key) ? key : null;
}

// ---- Stripe's API: form-encoded in, JSON out. The error text is Stripe's message, which never holds the key.
// param: the request field Stripe named in its refusal, if any
export class StripeError extends Error {
  status: number; param?: string;
  constructor(status: number, message: string, param?: string) { super(message); this.status = status; this.param = param; }
}
function encode(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') encode(v as Record<string, unknown>, key, out);
    else if (v !== undefined && v !== null) out.append(key, String(v));
  }
  return out;
}
export async function stripe(mode: 'test' | 'live', method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown> = {}, idempotency?: string) {
  const key = stripeKey(mode);
  if (!key) throw new StripeError(503, `no usable Stripe ${mode} key on the server yet`);
  const body = method === 'POST' ? encode(params) : undefined;
  if (key === 'imitation') return imitation(method, path, body ?? new URLSearchParams(), idempotency);
  const r = await fetch(stripeApi() + path, { method, body, signal: AbortSignal.timeout(20_000), headers: {
    authorization: `Bearer ${key}`,
    ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(idempotency ? { 'idempotency-key': idempotency } : {}) } })
    .catch(() => { throw new StripeError(502, 'Stripe: no answer (the product may retry: the same order gets the same session)'); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new StripeError(r.status >= 500 ? 502 : r.status, `Stripe: ${String(j?.error?.message ?? r.status).slice(0, 300)}`, j?.error?.param);
  return j;
}

// ---- the tool
// A product's own hosts: its standard and preview addresses, and its own domain once launched (servedDomain, manifests.ts)
function allowedHosts(slug: string) {
  const hosts = new Set([`${slug}.${zone}`, `${slug}.preview.${zone}`]);
  const p = manifest(slug);
  if (p?.status === 'live' && p.partner_env === 'live' && approved(`live:${slug}`) && servedDomain(p.domain)) hosts.add(p.domain);
  return hosts;
}
// A public product's shelf uses the shop's host. Return URLs also accept www.<zone> when it redirects there.
// The front's own domain is accepted only while the front is public there. Preview shelves use front.preview.<zone>
// for every product but the front, the chat's service and the platform's own pieces.
const CARE = 'care';   // infra/products.py's
function shelfHosts(slug: string) {
  const p = manifest(slug), hosts = new Set<string>();
  if (!p || slug === FRONT || slug === CARE) return hosts;
  if (isPublic(slug)) {
    hosts.add(`www.${zone}`);
    const frontDomain = manifest(FRONT)?.domain;
    if (isPublic(FRONT) && servedDomain(frontDomain)) hosts.add(frontDomain);
  }
  if (p.platform !== true) hosts.add(`front.preview.${zone}`);
  return hosts;
}
// A shelf's path is the product's only if Caddy routes it there (shelves.ts), and one that can't be decoded is nobody's
function onShelf(pathname: string, slug: string) {
  const routed = routedPath(pathname);
  return routed !== null && pathname.startsWith(`/${slug}/`) && routed.startsWith(`/${slug}/`);
}
// A URL on the product's own address or shelf (https; or localhost when HQ itself runs there), else null
// (exported for ordermail.ts's links; job #5963: its shelves too)
export function ownUrl(u: unknown, slug: string) {
  let url: URL;
  try { url = new URL(String(u ?? '')); } catch { return null; }
  if (PUBLIC_HOST === 'localhost' && url.hostname === 'localhost') return url;
  if (url.protocol !== 'https:') return null;
  const own = slug === FRONT ? frontHosts().has(url.hostname) && !onAnyShelf(url.pathname)
    : allowedHosts(slug).has(url.hostname) || (shelfHosts(slug).has(url.hostname) && onShelf(url.pathname, slug));
  return own ? url : null;
}
// The front's own addresses: its preview door and, while it's public, www's root; every other product's shelf path on
// them isn't the front's (any product's: Caddy routes a shelf by the cleaned path, ignoring case, as onShelf reads it).
function frontHosts() {
  const hosts = allowedHosts(FRONT);
  if (manifest(FRONT)?.status === 'live') hosts.add(`www.${zone}`);
  return hosts;
}
// (one that can't be decoded may be, so it's refused)
const onAnyShelf = (pathname: string) => routedPath(pathname) === null || shelfOf(pathname) !== null;
// (exported for plans.ts's checkouts)
export const returnUrl = (u: unknown, slug: string) => ownUrl(u, slug)?.href.replace(/%7BCHECKOUT_SESSION_ID%7D/g, '{CHECKOUT_SESSION_ID}') ?? null;

// What a shop names as its ways to pay: cards always (the wallets ride on them), plus the immediate methods the product's
// manifest names (`payment_methods: [ideal, bancontact]`, [] for cards only; a comma-separated string works too) or else
// the company's, company/infra.env's PAYMENT_METHODS (comma-separated). Stripe no longer takes a per-session list (its
// 400 on payment_method_types, 2026-10-06), so a checkout leaves out every other method it can (EXCLUDABLE, below) and
// offers what's left of what the account has on in its dashboard (Settings › Payment methods), in Stripe's order for the
// customer; the dashboard must still have the named ones on. Link can't be left out: only the dashboard's switch turns
// it off. Only methods that settle at once (Stripe: "immediate notification") are named, so a complete session stays a
// paid one; a delayed method (SEPA Direct Debit, Sofort, a bank transfer) is left out whatever a setting says, and
// logged once for the owner.
const IMMEDIATE = new Set(['ideal', 'bancontact', 'eps', 'wero']);
const warned = new Set<string>();
export function methods(slug: string) {
  const own = manifest(slug)?.payment_methods;
  const named = Array.isArray(own) ? own : String(typeof own === 'string' ? own : infra().PAYMENT_METHODS ?? '').split(',');
  const out = ['card'];
  for (const m of named.map(v => String(v).trim().toLowerCase()).filter(m => m && m !== 'card')) {
    if (IMMEDIATE.has(m)) { if (!out.includes(m)) out.push(m); continue; }
    if (warned.has(`${slug}:${m}`)) continue;
    warned.add(`${slug}:${m}`);
    log(`${slug}: its settings name the payment method ${JSON.stringify(m.slice(0, 40))}, which doesn't settle at once (only card, ${[...IMMEDIATE].join(', ')} do), so its checkout leaves it out.`);
  }
  return out;
}
// What a Checkout Session can leave out (excluded_payment_method_types), as Stripe's 400 on `link` listed it in test
// mode on 2026-10-09. A method Stripe adds later isn't here: reportUnnamedMethods() reports it once. One Stripe drops
// makes every checkout fail with a 400 naming excluded_payment_method_types[n]: that name must come out.
export const EXCLUDABLE = ['card', 'acss_debit', 'affirm', 'afterpay_clearpay', 'alipay', 'au_becs_debit', 'bacs_debit',
  'bancontact', 'blik', 'boleto', 'cashapp', 'crypto', 'customer_balance', 'eps', 'fpx', 'giropay', 'grabpay', 'ideal',
  'klarna', 'konbini', 'mb_way', 'multibanco', 'oxxo', 'p24', 'pay_by_bank', 'paynow', 'paypal', 'payto', 'pix',
  'promptpay', 'sepa_debit', 'sofort', 'swish', 'upi', 'us_bank_account', 'wechat_pay', 'revolut_pay', 'mobilepay', 'zip',
  'scalapay', 'amazon_pay', 'alma', 'twint', 'kr_card', 'naver_pay', 'kakao_pay', 'payco', 'nz_bank_account',
  'samsung_pay', 'billie', 'bizum', 'paypay', 'satispay', 'sequra', 'sunbit'];
// A session can offer a method the shop doesn't name, other than Link: one Stripe added after EXCLUDABLE was read, or one
// it can't leave out (Wero today). Each is logged once for the owner, and the checkout goes on.
function reportUnnamedMethods(slug: string, named: string[], s: any) {
  const shown: string[] = Array.isArray(s?.payment_method_types) ? s.payment_method_types.map(String) : [];
  for (const m of shown) {
    if (named.includes(m) || m === 'link' || warned.has(`offered:${m}`)) continue;
    warned.add(`offered:${m}`);
    log(`${slug}'s checkout offered ${JSON.stringify(m.slice(0, 40))}, which its settings don't name. Either it's new to Stripe and missing from EXCLUDABLE, or Stripe can't leave it out and only the dashboard's switch turns it off.`);
  }
}
// Whether a payment can go through now, for a shop that says so before anyone starts making something: test mode always
// can (Stripe's test mode or the imitation). Live mode needs a usable live key whose account Stripe says takes charges
// (charges_enabled), so the live restricted key also needs read access to the account. Anything else is a no: Stripe's
// 401 (a revoked or mistyped key) and its 403 (a key that may not read the account; Stripe's message names the
// permission, logged). It also needs live Print API keys that Print API takes: every paid basket goes to the printer as
// the one parcel, placed with them (parcels.ts), so without them a paid order could only be refunded. Stripe is asked at
// most once a READY_MS per set of keys, and Print API only once HQ's token for them has expired (about four hours:
// Print API's expires_in less five minutes, so revoked keys close ordering only then); no answer is an error.
const READY_MS = 5 * 60_000;
let liveReadiness: { keys: string; ready: boolean; at: number } | null = null;
async function ready(c: Caller) {
  if (c.mode === 'test') return { ready: true };
  const key = stripeKey('live');
  if (!key || !printapi.keys('live')) return { ready: false };
  const keys = `${key}\n${printapi.keysHash('live')}`;
  if (liveReadiness?.keys !== keys || Date.now() - liveReadiness.at >= READY_MS)
    liveReadiness = { keys, ready: (await takesCharges()) && (await printerTakesKeys()), at: Date.now() };
  return { ready: liveReadiness.ready };
}
// Whether a live payment can go through now, for the watch on live apps
export const paymentsReady = async () => (await ready({ slug: '', mode: 'live' })).ready;
async function takesCharges() {
  try {
    return (await stripe('live', 'GET', '/v1/account')).charges_enabled === true;
  } catch (err) {
    if (err instanceof StripeError && err.status === 403) console.error(`payments: the live key may not read the account, so no payment counts as ready: ${err.message}`);
    if (err instanceof StripeError && (err.status === 401 || err.status === 403)) return false;
    throw err;
  }
}
// Print API gives a token for the live keys (one it already gave counts until it expires). Its refusal is a no, logged
// in our words: a 400 (OAuth's invalid_client, what Print API answers wrong keys) or a 401 or 403. Anything else (a 429,
// a timeout) is no answer
async function printerTakesKeys() {
  try {
    await printapi.auth('live');
    return true;
  } catch (err) {
    if (!(err instanceof printapi.PrintApiError) || ![400, 401, 403].includes(err.status)) throw err;
    console.error(`payments: Print API refused the live keys, so no payment counts as ready (${err.status})`);
    return false;
  }
}

// Stripe Checkout's languages (its `locale`); auto follows the customer's browser (exported for plans.ts)
export const LOCALES = new Set(['auto', 'bg', 'cs', 'da', 'de', 'el', 'en', 'en-GB', 'es', 'es-419', 'et', 'fi', 'fil', 'fr', 'fr-CA',
  'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'ms', 'mt', 'nb', 'nl', 'pl', 'pt', 'pt-BR', 'ro', 'ru', 'sk', 'sl', 'sv',
  'th', 'tr', 'vi', 'zh', 'zh-HK', 'zh-TW']);

const opened = new Map<string, number[]>();
export const log = (text: string) => publish({ type: 'log', agent: roles().process, text: `Payments: ${text}` });
export const euros = (cents: number, currency: string) => companyFormats(currency).money(cents, 'en');

// One checkout at a time per order: a second request for the same reference (a double click) waits for the first and
// then finds its session, instead of both finding none and opening two payable sessions for one order. A basket's
// changes and its checkout share one queue per basket too. Exported for the one parcel's queue.
const queues = new Map<string, Promise<unknown>>();
export function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
  queues.set(key, next);
  return next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
}
const checkout = (c: Caller, b: any) => serial(`${c.slug}:${c.mode}:${String(b?.reference ?? '')}`, () => openCheckout(c, b));

async function openCheckout(c: Caller, b: any) {
  const amount = b.amount, currency = String(b.currency ?? '').toLowerCase(), reference = String(b.reference ?? '');
  const description = String(b.description ?? '').replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const success = returnUrl(b.success_url, c.slug), cancel = returnUrl(b.cancel_url, c.slug);
  const locale = b.locale == null || b.locale === '' ? 'auto' : String(b.locale);
  const email = b.customer_email == null || b.customer_email === '' ? null : address(b.customer_email)?.toLowerCase() ?? null;
  if (!Number.isInteger(amount) || amount < MIN || amount > MAX) return [400, `amount: whole cents from ${MIN} to ${MAX}`];
  if (currency !== 'eur') return [400, 'currency: eur'];
  if (!REF.test(reference)) return [400, 'reference: 1-64 letters, digits, _ or -'];
  if (!description || description.length > 120) return [400, 'description: 1-120 characters'];
  if (!success || !cancel) return [400, "success_url and cancel_url: https, on this product's own address"];
  if (!LOCALES.has(locale)) return [400, "locale: one of Stripe Checkout's (auto, en, nl, de, fr...)"];
  if (email === null && b.customer_email != null && b.customer_email !== '') return [400, 'customer_email: an email address'];
  if (c.slug === FRONT && BASKET.test(reference)) return [409, "a basket's checkout is POST /api/pay/basket/checkout"];
  const territory = territoryOf(b.countries);
  if (territory === false) return [400, 'countries: 1-30 different two-letter country codes (NL, BE...)'];
  const opened = await openSession(c, { reference, amount, currency, items: [{ name: description, amount }], success, cancel, locale, email, territory });
  return Array.isArray(opened) ? opened : { ...opened, countries: territory?.split(',') ?? null };
}
// A territory as a payments row keeps it: its countries sorted and comma-joined, null for none, false when malformed.
function territoryOf(countries: unknown) {
  if (countries == null) return null;
  if (!Array.isArray(countries) || countries.length < 1 || countries.length > 30 || new Set(countries).size !== countries.length) return false;
  if (!countries.every(country => typeof country === 'string' && /^[A-Z]{2}$/.test(country))) return false;
  return [...countries].sort().join(',');
}

// What a session asks Stripe for. shape: a basket's lines, their amounts and names and the address, so a changed basket
// gets a new session; created: written in the same step as the session's row (a basket's lines).
type Ask = { reference: string; amount: number; currency: string; items: { name: string; amount: number }[]; success: string;
  cancel: string; locale: string; email: string | null; basket?: { id: string; shape: string; created: (session: string) => void };
  territory?: string | null };
// How long a create's idempotency key is reused, and how long its session stays open after the attempt's minute
const ATTEMPT_MINUTES = 25, SESSION_LIFE_S = 3660;
async function openSession(c: Caller, a: Ask) {
  const { reference, amount, currency, locale, email } = a, shape = a.basket?.shape ?? null, territory = a.territory ?? null;
  // One order, one payment: an open session for the same order and amount is handed out again (a double click, a
  // second tab), one for another amount (or another language or email) is closed first, and an order that's already
  // paid can't be paid again. One opened while the shop named other methods (before a settings change) is closed too:
  // its metadata keeps a hash of what it left out. A territory's sale takes cards and Link so the payment can be held.
  const named = territory ? ['card'] : methods(c.slug), excluded = EXCLUDABLE.filter(m => !named.includes(m));
  const policy = createHash('sha256').update(JSON.stringify(excluded)).digest('hex').slice(0, 12);
  const rows = db.prepare("select * from payments where product = ? and mode = ? and reference = ? and status in ('open', 'paid', 'complete')")
    .all(c.slug, c.mode, reference) as any[];
  for (const row of rows) {
    let s;
    try { s = await sessionOf(c.mode, row.id); } catch (err) {
      // gone at Stripe (the imitation's sessions don't outlive a restart, or the test key changed): it can't be paid
      if (!(err instanceof StripeError && err.status === 404)) throw err;
      db.prepare("update payments set status = 'expired', updated = ? where id = ?").run(new Date().toISOString(), row.id);
      continue;
    }
    const v = view(row, s);
    if (v.paid) return [409, 'this order is already paid', 'already_paid'];
    if (sessionState(s) === 'processing') return [409, 'the payment for this order is still being processed', 'payment_processing'];
    if (s.status !== 'open') continue;
    const asked = (s.locale ?? 'auto') === locale && String(s.customer_email ?? '').toLowerCase() === String(email ?? '').toLowerCase();
    if (row.amount === amount && asked && s.metadata?.methods === policy && (row.shape ?? null) === shape && (row.territory ?? null) === territory && s.url) return { id: s.id, url: s.url, expires_at: s.expires_at };
    view(row, await stripe(c.mode, 'POST', `/v1/checkout/sessions/${row.id}/expire`));
  }
  if (!countCheckout(c)) return [429, 'too many checkouts this hour'];
  const meta = { product: c.slug, reference };
  // The idempotency key names this attempt (the order, its amount, how many sessions it had, the minute it started), and
  // expires_at follows that minute. The attempt is stored before Stripe is asked, so a retry of a create whose answer got
  // lost reuses the key and gets the same session back rather than a second one. After 25 minutes it starts afresh (Stripe
  // wants expires_at at least 30 minutes ahead): a session the customer never saw, which expires within the hour.
  const attempt = (db.prepare('select count(*) n from payments where product = ? and mode = ? and reference = ?').get(c.slug, c.mode, reference) as any).n;
  const thisMinute = Math.floor(Date.now() / 60_000);
  const pending = db.prepare(`select minute from checkout_creates where product = ? and mode = ? and reference = ? and amount = ?
    and attempt = ? and minute > ? order by minute desc`).get(c.slug, c.mode, reference, amount, attempt, thisMinute - ATTEMPT_MINUTES) as any;
  const minute = pending?.minute ?? thisMinute;
  // The key also names what else was asked (the language, email and methods; a basket's lines and address), since Stripe
  // refuses one key for two different requests: a retry that asks the same gets the same session. Every method the shop
  // doesn't name is left out (methods(), above), and Stripe orders what's left.
  const asked = [locale, email, ...(shape === null ? [] : [shape]), excluded, ...(territory ? [territory] : [])];
  const hash = createHash('sha256').update(JSON.stringify(asked)).digest('hex').slice(0, 12);
  const key = `checkout-${c.slug}-${c.mode}-${reference}-${amount}-${attempt}-${minute}-${hash}`;
  db.prepare('insert or ignore into checkout_creates (key, product, mode, reference, amount, attempt, minute) values (?, ?, ?, ?, ?, ?, ?)')
    .run(key, c.slug, c.mode, reference, amount, attempt, minute);
  const s = await stripe(c.mode, 'POST', '/v1/checkout/sessions', {
    mode: 'payment', success_url: a.success, cancel_url: a.cancel, client_reference_id: reference, metadata: { ...meta, methods: policy },
    line_items: a.items.map(item => ({ quantity: 1, price_data: { currency, unit_amount: item.amount, product_data: { name: item.name } } })),
    locale, customer_email: email ?? undefined, payment_intent_data: { metadata: meta, ...(territory ? { capture_method: 'manual' } : {}) },
    expires_at: minute * 60 + SESSION_LIFE_S, excluded_payment_method_types: excluded, ...(territory ? { billing_address_collection: 'required' } : {}),
  }, key);
  reportUnnamedMethods(c.slug, named, s);
  const now = new Date().toISOString();
  atOnce(() => {
    db.prepare('insert or replace into payments (id, created, product, mode, reference, amount, currency, status, updated, basket, shape, territory) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, now, c.slug, c.mode, reference, amount, currency, 'open', now, a.basket?.id ?? null, shape, territory);
    a.basket?.created(s.id);
    db.prepare('delete from checkout_creates where key = ?').run(key);
  });
  log(`${c.slug} opened a ${c.mode} checkout of ${euros(amount, currency)} for ${reference}.`);
  return { id: s.id, url: s.url, expires_at: s.expires_at };
}

// A checkout counted against the product's hour, or false once it has had PER_HOUR. One budget per mode: test checkouts
// (the preview's token never rotates) can't use up a live shop's hour. (exported for plans.ts's checkouts)
export function countCheckout(c: Caller) {
  const budget = `${c.slug}:${c.mode}`, times = (opened.get(budget) ?? []).filter(t => t > Date.now() - 36e5);
  if (times.length >= PER_HOUR) return false;
  opened.set(budget, [...times, Date.now()]);
  return true;
}

// The session, checked against Stripe and against the caller: a product only ever sees its own sessions.
export async function ownSession(c: Caller, id: string) {
  if (!SESSION.test(id) || !id.startsWith(`cs_${c.mode}_`)) return null;
  const row = db.prepare('select * from payments where id = ? and product = ? and mode = ?').get(id, c.slug, c.mode) as any;
  if (!row) return null;
  const s = await sessionOf(c.mode, id);
  if (s?.metadata?.product !== c.slug || s.livemode !== (c.mode === 'live')) return null;
  return { row, s: row.territory ? heldSession(row, s) : s };
}
// A territory's session is paid once HQ charged its hold (decideHold), whatever Stripe's session says after the capture.
const heldSession = (row: any, s: any) => ({ ...s, payment_status: row.hold === 'captured' ? 'paid' : 'unpaid' });
// A Checkout Session as Stripe has it; one made here (MADE_HERE), a basket paid by vouchers (paidByVouchers: Stripe's
// own ids have no underscore after the mode) in the same shape, from its row, its payer's email kept there until the 90
// days the privacy page names. A test order's (paidAsTest) is complete with nothing paid, as Stripe says of a session
// that charged nothing, so nothing that waits for a paid session ever takes it for one.
const MADE_HERE = /^cs_(test|live)_(vouchers|test|tester)_[a-f0-9]{24}$/;
export async function sessionOf(mode: 'test' | 'live', id: string) {
  if (!MADE_HERE.test(id)) return stripe(mode, 'GET', `/v1/checkout/sessions/${id}`);
  const row = db.prepare('select * from payments where id = ? and mode = ?').get(id, mode) as any;
  if (!row) throw new StripeError(404, 'Stripe: no such checkout session');
  return { id, object: 'checkout.session', status: 'complete', payment_status: row.status === 'test' ? 'no_payment_required' : 'paid', amount_total: 0, currency: row.currency,
    livemode: mode === 'live', locale: row.locale, customer_details: { email: row.payer }, customer_email: row.payer,
    metadata: { product: row.product, reference: row.reference }, payment_intent: null, url: null, expires_at: null };
}
// A checkout session's state, read the same way for every order and plan: paid; processing (complete, but its payment
// hasn't settled: it may still be paid, so it's neither paid again nor replaced); open; or ended unpaid. (exported for
// plans.ts)
export type SessionState = 'paid' | 'processing' | 'open' | 'ended';
export const sessionState = (s: any): SessionState =>
  s.status === 'complete' ? (s.payment_status === 'paid' ? 'paid' : 'processing') : s.status === 'open' ? 'open' : 'ended';
function view(row: any, s: any) {
  if (row.territory) s = heldSession(row, s);
  // a test order stays one: nothing about it is ever paid or settled
  if (row.status === 'test') return { id: s.id, reference: row.reference, status: s.status, paid: false, amount: 0, currency: row.currency,
    refunded: false, refund_status: null, test: true };
  const paid = sessionState(s) === 'paid', refunded = row.refund_status === 'succeeded';
  const status = refunded ? 'refunded' : paid ? 'paid' : row.hold === 'released' ? 'released' : s.status;
  if (status !== row.status) {
    // a basket's lines turn paid in the same step as its payment
    const basket = status === 'paid' && row.basket;
    atOnce(() => {
      db.prepare('update payments set status = ?, updated = ? where id = ?').run(status, new Date().toISOString(), row.id);
      if (basket) settle(row);
    });
    if (status === 'paid') log(`${row.product}: ${row.reference} is paid (${row.mode}, ${euros(s.amount_total, s.currency)}).`);
    if (basket) tellPaid(row, s);
  }
  return { id: s.id, reference: row.reference, status: row.hold === 'released' ? 'released' : s.status, paid, amount: s.amount_total,
    currency: s.currency, refunded, refund_status: row.refund ? row.refund_status ?? 'pending' : null };
}

// A refund is done when Stripe says it succeeded, not when it was asked for. Until then it's read again on every check,
// and a failed or canceled one is reported to the owner and can be tried again.
const ENDED = new Set(['failed', 'canceled']);
function noteRefund(row: any, r: any) {
  if (r.id === row.refund && r.status === row.refund_status) return row;
  db.prepare('update payments set refund = ?, refund_status = ?, updated = ? where id = ?').run(r.id, r.status, new Date().toISOString(), row.id);
  const what = `${row.reference} (${row.mode}, ${euros(row.amount, row.currency)})`;
  if (r.status === 'succeeded') log(`${row.product} refunded ${what} in full.`);
  else if (ENDED.has(r.status)) log(`${row.product}: the refund of ${what} ${r.status}. The customer does NOT have the money back; the product can refund again, or the owner should look.`);
  else log(`${row.product} asked for a refund of ${what}: ${r.status} at Stripe.`);
  return { ...row, refund: r.id, refund_status: r.status };
}
async function refreshRefund(c: Caller, row: any) {
  if (!row.refund || row.refund_status === 'succeeded' || ENDED.has(row.refund_status)) return row;
  return noteRefund(row, await stripe(c.mode, 'GET', `/v1/refunds/${encodeURIComponent(row.refund)}`));
}

async function session(c: Caller, id: string) {
  let own = await ownSession(c, id);
  if (!own) return [404, 'no such session for this product'];
  if (own.row.territory && !own.row.hold && own.s.status === 'complete') own = (await decideHold(c, id)) ?? own;
  return { ...view(await refreshRefund(c, own.row), own.s), ...settlement(c, own.row, own.s) };
}

// A support chat's lookups by the payer's email. Stripe keeps the email; HQ compares it and never keeps or returns it.
const PAYER_SESSIONS = 20;
const paidFrom = (stripeSession: any, email: string) =>
  stripeSession?.status === 'complete' &&
  stripeSession.payment_status === 'paid' &&
  String(stripeSession.customer_details?.email ?? '')
    .trim()
    .toLowerCase() === email;
async function matchPayer(caller: Caller, requestBody: any) {
  const email = address(requestBody.email)?.toLowerCase();
  if (!email) return [400, 'email: an email address'];
  const ownSessionDetails = await ownSession(caller, String(requestBody.id ?? ''));
  return {
    match: !!ownSessionDetails && ownSessionDetails.row.status !== 'test' && paidFrom(ownSessionDetails.s, email),
  };
}
async function listPayerSessions(caller: Caller, requestBody: any) {
  const email = address(requestBody.email)?.toLowerCase();
  if (!email) return [400, 'email: an email address'];
  const sessionFilter = new URLSearchParams({ 'customer_details[email]': email, status: 'complete', limit: '100' });
  const stripeResponse = await stripe(caller.mode, 'GET', `/v1/checkout/sessions?${sessionFilter}`);
  if (!Array.isArray(stripeResponse?.data)) throw new Error('Stripe did not return a checkout session list.');
  const paymentLookup = db.prepare(
    "select reference, territory, hold from payments where id = ? and product = ? and mode = ? and status != 'test'",
  );
  const sessions = stripeResponse.data
    .filter(
      (stripeSession: any) =>
        stripeSession.metadata?.product === caller.slug && stripeSession.livemode === (caller.mode === 'live'),
    )
    .flatMap((stripeSession: any) => {
      const ownPayment = paymentLookup.get(stripeSession.id, caller.slug, caller.mode) as any;
      // a territory's sale is paid once HQ charged its hold, as ownSession says
      const judged = ownPayment?.territory ? heldSession(ownPayment, stripeSession) : stripeSession;
      return ownPayment && paidFrom(judged, email)
        ? [{ id: stripeSession.id as string, reference: ownPayment.reference as string }]
        : [];
    });
  return { sessions: sessions.slice(0, PAYER_SESSIONS) };
}

// The live orders placed with an email address, for the job investigating a customer's care card (care.ts ordersForJob):
// every complete session Stripe has for it, and the baskets the caller knows it paid (history.ts's payer hash: a card's
// address may not have the case it was paid with, and a basket paid by vouchers alone has no Stripe session), each with
// what HQ knows of it (a basket's number and things; care.ts adds its parcel by `session`). The address is asked and
// compared, never kept; a session HQ has no row for, or one whose payer asked to be forgotten, isn't listed. Stripe's
// email filter is exact, so it's asked as the card has it and in lower case. A Stripe failure throws.
export async function placedWith(email: string, baskets: string[]) {
  const forms = [...new Set([email.trim(), email.trim().toLowerCase()])], ids = new Set(baskets);
  for (const form of forms)
    for await (const s of listed('live', '/v1/checkout/sessions', { 'customer_details[email]': form, status: 'complete' }))
      if (s.livemode === true) ids.add(String(s.id));
  const row = db.prepare("select * from payments where id = ? and mode = 'live' and forget_asked is null");
  return ([...ids].map(id => row.get(id)).filter(Boolean) as any[])
    .sort((a, b) => b.created.localeCompare(a.created))
    .map(r => ({ at: r.created as string, app: r.product as string, status: r.status as string, amount: euros(r.amount, r.currency),
      ...(r.basket ? { session: r.id as string, number: orderNumber(r.id),
        things: paidLines(r.id).map(l => ({ app: l.product, reference: l.reference, description: l.description, status: l.status })) }
        : { reference: r.reference as string }) }));
}

// A territory's held payment, decided once, in a queue of its own so two reads can't both decide. HQ charges it when the
// billing country and the card's issuing country (Link's funding country for Link) agree and are in the territory.
// Otherwise HQ releases it. A hold Stripe already charged or let go (a decision whose answer was lost, or a hold that
// lapsed) is recorded as it stands.
function decideHold(c: Caller, id: string) {
  return serial(`hold:${id}`, async () => {
    const own = await ownSession(c, id);
    if (!own || own.row.hold || own.s.status !== 'complete' || !own.s.payment_intent) return own;
    const intentId = typeof own.s.payment_intent === 'string' ? own.s.payment_intent : own.s.payment_intent.id;
    const intentPath = `/v1/payment_intents/${encodeURIComponent(intentId)}`;
    let intent = await stripe(c.mode, 'GET', `${intentPath}?expand%5B%5D=latest_charge`);
    if (intent.status === 'requires_capture') {
      const billingCountry = own.s.customer_details?.address?.country;
      const details = intent.latest_charge?.payment_method_details;
      const cardCountry = details?.card?.country ?? details?.link?.country;
      const inside = typeof billingCountry === 'string' && billingCountry === cardCountry && own.row.territory.split(',').includes(billingCountry);
      const decision = inside ? 'capture' : 'cancel';
      intent = await stripe(c.mode, 'POST', `${intentPath}/${decision}`, {}, `${decision}-${intentId}`);
    }
    const hold = intent.status === 'succeeded' ? 'captured' : intent.status === 'canceled' ? 'released' : null;
    if (!hold) return own;
    db.prepare('update payments set hold = ?, updated = ? where id = ?').run(hold, stamp(), id);
    if (hold === 'released') log(`${c.slug}: ${own.row.reference} released uncharged (${c.mode}): payment hold canceled`);
    return ownSession(c, id);
  });
}

// What a paid session settled at, for a product's net: Stripe's actual fee and the payer's billing country. The answer
// never waits for Stripe's fee: it carries the fee kept so far, or null, and starts one lookup per payment on the side
// (lookUpFee). A fee can settle after the payment, so it stays null until the charge's balance transaction has one, and
// is kept once it does. A lookup Stripe refuses (a restricted key without read access to charges and balance) leaves it
// null too: an unknown fee, never a guessed one.
const feeLookups = new Set<string>();   // the payments whose lookup is on its way
const feeRefusals = new Set<string>();
function settlement(c: Caller, row: any, s: any) {
  const country = typeof s.customer_details?.address?.country === 'string' ? s.customer_details.address.country : null;
  if (row.fee_currency) return { fee: row.fee as number, fee_currency: row.fee_currency as string, country };
  const settles = row.status !== 'test' && s.status === 'complete' && s.payment_status === 'paid' && s.payment_intent;
  if (settles && !feeLookups.has(row.id)) {
    const intent = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id;
    feeLookups.add(row.id);
    lookUpFee(c.mode, row.id, intent)
      .catch(err => console.error(`Payments: could not look up the fee of ${row.id}:`, err))
      .finally(() => feeLookups.delete(row.id));
  }
  return { fee: null, fee_currency: null, country };
}
async function lookUpFee(mode: 'test' | 'live', id: string, intent: string) {
  let charged;
  try {
    charged = await stripe(mode, 'GET', `/v1/payment_intents/${encodeURIComponent(intent)}?expand%5B%5D=latest_charge.balance_transaction`);
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    if ((e.status === 401 || e.status === 403) && !feeRefusals.has(mode)) {
      log(`Stripe refused the ${mode} key a fee lookup (${e.message}): products' net stays unknown until the key may read charges and balance.`);
      feeRefusals.add(mode);
    }
    return;
  }
  const settled = charged?.latest_charge?.balance_transaction;
  if (!Number.isInteger(settled?.fee) || settled.fee < 0 || typeof settled.currency !== 'string') return;
  db.prepare('update payments set fee = ?, fee_currency = ?, updated = ? where id = ?').run(settled.fee, settled.currency, new Date().toISOString(), id);
}

async function expire(c: Caller, id: string) {
  const own = await ownSession(c, id);
  if (!own) return [404, 'no such session for this product'];
  if (own.s.status !== 'open') return view(own.row, own.s);
  return view(own.row, await stripe(c.mode, 'POST', `/v1/checkout/sessions/${id}/expire`));
}

// Ends every open session of the product in its mode, its basket's included. Each one is ended in the same per-basket or
// per-order queue as a change to it, so the end can't race a basket change
async function expireOpen(c: Caller) {
  if (c.mode === 'live') remember(`pay.closed.${c.slug}`, new Date().toISOString());
  let expired = 0;
  for (const row of db.prepare("select * from payments where product = ? and mode = ? and status = 'open'").all(c.slug, c.mode) as any[]) {
    const ended = await serial(row.basket ? basketKey(c.mode, row.basket) : `${c.slug}:${c.mode}:${row.reference}`, () => endSession(row));
    if (ended === true) expired++;
  }
  if (expired) log(`${c.slug} closed its ordering: ${expired} open ${c.mode} checkout${expired === 1 ? '' : 's'} can't be paid any more.`);
  return { expired };
}

// ---- an order past the product's own retention
// POST /api/pay/retire {reference} → {reference}: the product's books no longer need the order, so HQ forgets what it
// holds of it: its checkout sessions, the creates whose answer it never had, and what retireHooks forget (its order
// emails, ordermail.ts). HQ refuses the whole retirement, and keeps the order's records, in these cases:
// - A retireRefusals check names a reason (closures.ts: an asked or approved decision keeps the payments it names).
// - A session may still be paid, or is paid and not refunded (canRetirePayment()).
// - Any create whose answer never reached HQ, every one of them even after later retries or sessions, may have made a
//   session that may still be paid, or was paid and not refunded in full (createRetireRefusal()).
// HQ reads its payment records and Stripe without changing the order's records. It deletes them only once nothing refuses.
// A paid create whose answer was lost is logged once per HQ run for a person to refund in Stripe. Retirement runs in
// the order's queue, as its checkout and order emails do. A line of a basket keeps its books record (tick).
export const retireHooks: ((c: Caller, reference: string) => void)[] = [];
export const retireRefusals: ((c: Caller, reference: string) => string | null)[] = [];
async function retire(caller: Caller, requestBody: any): Promise<Refused | object> {
  const reference = String(requestBody.reference ?? '');
  if (!REF.test(reference)) return [400, 'reference: 1-64 letters, digits, _ or -'];
  if (caller.slug === FRONT && BASKET.test(reference)) return [409, "a basket's payment stays with its lines, for the books"];
  return serial(`${caller.slug}:${caller.mode}:${reference}`, async (): Promise<Refused | object> => {
    for (const refusal of retireRefusals) {
      const why = refusal(caller, reference);
      if (why) return [409, why];
    }
    const rows = db.prepare('select * from payments where product = ? and mode = ? and reference = ?').all(caller.slug, caller.mode, reference) as any[];
    for (const row of rows)
      if (!(await canRetirePayment(row))) return [409, 'a checkout of this order is paid and not refunded, or may still be paid'];
    // every create's minute is checked, and one completed at Stripe outranks one that may still be open
    const minutes = db.prepare('select distinct minute from checkout_creates where product = ? and mode = ? and reference = ? order by minute')
      .all(caller.slug, caller.mode, reference) as { minute: number }[];
    const knownSessionIds = new Set(rows.map(row => row.id)), refusals: CreateRefusal[] = [];
    for (const { minute } of minutes) {
      const refusal = await createRetireRefusal(caller, reference, minute, knownSessionIds);
      if (refusal) refusals.push(refusal);
    }
    if (refusals.length) return [409, refusals.includes(COMPLETED_CREATE) ? completedCreate(caller, reference) : refusals[0]];
    atOnce(() => {
      db.prepare('delete from payments where product = ? and mode = ? and reference = ?').run(caller.slug, caller.mode, reference);
      db.prepare('delete from checkout_creates where product = ? and mode = ? and reference = ?').run(caller.slug, caller.mode, reference);
      forgetImitation(rows.map(row => row.id));
      for (const hook of retireHooks) hook(caller, reference);
    });
    return { reference };
  });
}
// Whether a session can never be paid or refunded any more: refunded in full, a test order, a held payment released
// uncharged, or expired (gone at Stripe too). A paid one isn't, and an open or complete one only once Stripe says it
// expired. Stripe's session is read as it is (sessionOf), never through view(), which records what it finds.
async function canRetirePayment(row: any) {
  if (row.refund_status === 'succeeded' || row.status === 'test' || row.status === 'expired' || row.hold === 'released') return true;
  if (row.status !== 'open' && row.status !== 'complete') return false;
  try { return (await sessionOf(row.mode, row.id)).status === 'expired'; }
  catch (err) {
    if (err instanceof StripeError && err.status === 404) return true;   // gone at Stripe: it can't be paid
    throw err;
  }
}
// Why the creates of one minute whose answer never reached HQ cannot retire, or null when they left nothing that can be
// paid. Their keys were sent within ATTEMPT_MINUTES of that minute, and their sessions expire SESSION_LIFE_S after it
// (openSession()). Until then one may be open. After that Stripe lists every session those keys can have made.
// Each session of this order that HQ has no row for must have expired, or completed with a payment that Stripe
// released or refunded in full (unpaidAtStripe()). canRetirePayment() judges the sessions recorded in HQ.
// CLOCK_SLACK_S covers the clocks of HQ and Stripe and a slow answer.
const CLOCK_SLACK_S = 300;
const OPEN_CREATE = 'a checkout of this order whose answer never reached HQ may still be paid. Ask again once it has expired';
const COMPLETED_CREATE = 'a checkout of this order completed at Stripe, but HQ has no record of its payment. A person must refund it in full in Stripe (or cancel its held payment there), then ask again';
type CreateRefusal = typeof OPEN_CREATE | typeof COMPLETED_CREATE;
async function createRetireRefusal(caller: Caller, reference: string, minute: number, knownSessionIds: Set<string>): Promise<CreateRefusal | null> {
  const startedAt = minute * 60;
  if (Date.now() / 1000 < startedAt + SESSION_LIFE_S + CLOCK_SLACK_S) return OPEN_CREATE;
  const createdSessions = await sessionsCreated(caller.mode, startedAt - CLOCK_SLACK_S, startedAt + ATTEMPT_MINUTES * 60 + CLOCK_SLACK_S);
  const unknownSessions = createdSessions.filter(s => s.client_reference_id === reference && s.metadata?.product === caller.slug && !knownSessionIds.has(s.id));
  for (const s of unknownSessions) if (s.status === 'complete' && !(await unpaidAtStripe(caller.mode, s))) return COMPLETED_CREATE;
  return unknownSessions.every(s => s.status === 'expired' || s.status === 'complete') ? null : OPEN_CREATE;
}
// Whether a completed session's payment can't be charged any more (canceled) or was refunded in full: its succeeded
// refunds add up to what Stripe received. One still held, on its way, or refunded in part may still keep money.
async function unpaidAtStripe(mode: 'test' | 'live', s: any) {
  if (!s.payment_intent) return s.payment_status === 'no_payment_required';
  const id = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id;
  const intent = await stripe(mode, 'GET', `/v1/payment_intents/${encodeURIComponent(id)}`);
  if (intent.status === 'canceled') return true;
  if (intent.status !== 'succeeded' || !(intent.amount_received > 0)) return false;
  let refunded = 0;
  for await (const refund of listed(mode, '/v1/refunds', { payment_intent: id })) {
    if (refund.status !== 'succeeded') continue;
    refunded += refund.amount;
    if (refunded >= intent.amount_received) return true;
  }
  return false;
}
// The refusal for a completed create HQ has no record of, logged once per HQ run for a person to check
const completedCreatesReported = new Set<string>();
function completedCreate(c: Caller, reference: string) {
  const key = `${c.slug}:${c.mode}:${reference}`;
  if (!completedCreatesReported.has(key)) {
    completedCreatesReported.add(key);
    log(`NEEDS A PERSON: ${c.slug}: ${reference} (${c.mode}): ${COMPLETED_CREATE}`);
  }
  return COMPLETED_CREATE;
}
// Every Checkout Session Stripe made between two times (Unix seconds)
async function sessionsCreated(mode: 'test' | 'live', from: number, to: number) {
  const sessions: any[] = [];
  for await (const s of listed(mode, '/v1/checkout/sessions', { 'created[gte]': String(from), 'created[lte]': String(to) })) sessions.push(s);
  return sessions;
}
// Every item of one of Stripe's lists, page by page, fetching the next only when asked for
async function* listed(mode: 'test' | 'live', path: string, filter: Record<string, string>) {
  for (let after = ''; ;) {
    const query = new URLSearchParams({ ...filter, limit: '100' });
    if (after) query.set('starting_after', after);
    const page = await stripe(mode, 'GET', `${path}?${query}`);
    yield* page.data as any[];
    if (!page.has_more || !page.data.length) return;
    after = page.data.at(-1).id;
  }
}

// Whether the live product said within CLOSED_MS that its ordering is closed on purpose (POST /api/pay/expire/open), for
// HQ's watch. A product that keeps its ordering closed asks again within it.
export const CLOSED_MS = 10 * 60_000;
export function orderingClosed(slug: string, now = Date.now()) {
  const saidAt = setting(`pay.closed.${slug}`);
  if (!saidAt) return false;
  return now - Date.parse(saidAt) < CLOSED_MS;
}

// A payment that funds something else can't be refunded here: a company's own tool adds a guard (say a voucher bought
// with it, refunded as the voucher, or the customer would have the money and the code).
// And from the moment a refund of a payment is asked until Stripe's answer is in hand, nothing may start using it
// (such a tool reads `refund_asked` and `asking`): a refund whose answer was lost may well have happened, so its mark stays
// on the payment, across restarts, until the refund is asked again (its idempotency key finds the same one) and answered.
export const refundGuards: ((c: Caller, session: string) => string | null)[] = [];
const askingNow = new Map<string, number>();
export const asking = (session: string) => (askingNow.get(session) ?? 0) > 0;
const askedMark = (id: string, on: boolean) => db.prepare('update payments set refund_asked = ? where id = ?').run(on ? new Date().toISOString() : null, id);
export async function refund(c: Caller, id: string) {
  const own = await ownSession(c, id);
  if (!own) return [404, 'no such session for this product'];
  if (own.row.basket) return [409, "a basket's payment is refunded per line (POST /api/pay/line/refund)"];
  const held = refundGuards.map(g => g(c, id)).find(Boolean);
  if (held) return [409, held];
  askingNow.set(id, (askingNow.get(id) ?? 0) + 1);   // in the same step as the guard: nothing can slip in between
  askedMark(id, true);
  try { const r = await refundAsked(c, id, own); askedMark(id, false); return r; }   // Stripe's answer is in our row now
  catch (e) {
    // Stripe said no (nothing was made): the mark goes. No answer, a 5xx, or a request still in progress (409): it stays.
    if (e instanceof StripeError && e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 429) askedMark(id, false);
    throw e;
  }
  finally { const n = (askingNow.get(id) ?? 1) - 1; if (n > 0) askingNow.set(id, n); else askingNow.delete(id); }
}
// a refund that succeeded can still fail later (Stripe: up to 30 days); a tool reads one again
export async function recheckRefund(c: Caller, id: string) {
  const row = db.prepare('select * from payments where id = ? and product = ? and mode = ?').get(id, c.slug, c.mode) as any;
  if (!row?.refund) return null;
  return noteRefund(row, await stripe(c.mode, 'GET', `/v1/refunds/${encodeURIComponent(row.refund)}`)).refund_status as string;
}
async function refundAsked(c: Caller, id: string, own: { row: any; s: any }) {
  const { s } = own, row = await refreshRefund(c, own.row);
  if (row.refund && !ENDED.has(row.refund_status)) return view(row, s);   // succeeded, or still on its way
  if (s.status !== 'complete' || s.payment_status !== 'paid' || !s.payment_intent) return [409, 'this session is not paid'];
  // the whole amount, once: the idempotency key makes a retry return the same refund instead of a second one, and only
  // after a refund failed does a new key (named after the failed one) ask Stripe again
  const r = await stripe(c.mode, 'POST', '/v1/refunds', { payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id,
    metadata: { product: c.slug, reference: row.reference } }, row.refund ? `refund-${id}-after-${row.refund}` : `refund-${id}`);
  return view(noteRefund(row, r), s);
}

// ---- the basket
// A line is one product's order, registered by the product with its price; the browser only ever names it, with the
// claim the product gave its page. The front puts lines in a basket and opens one session over them. Every change to a
// basket's lines and its checkout runs in that basket's queue, so a session never charges a line as it was before a
// change: a change ends the basket's open session first (Stripe's expire), and a session paid meanwhile refuses it.
export type Line = { id: string; created: string; product: string; mode: 'test' | 'live'; reference: string; amount: number;
  currency: string; description: string; detail: string | null; voucher: number | null; voucher_value: number | null; ships_in: number;
  cutoff: number; order_url: string | null; basket: string | null; position: number | null; status: 'open' | 'paid' | 'cancelled';
  session: string | null; card: number | null; saved: number | null; paid_at: string | null; refund: string | null;
  refund_status: string | null; refund_asked: string | null; updated: string;
  offer: number | null; code_saved: number | null; basket_counted: string | null; checkout_counted: string | null;
  goes_with: string | null; picture: string | null; number: string | null; kept_until: string | null; quantity: number };
// A refusal: its status, the reason in English, and for one a shop's customer can reach, why: a code the shop says in the
// customer's language, and what those words need to say it (a code's minimum).
// (a voucher's stall's name for voucher_no_line)
export type Refused = [status: number, error: string, why?: string, needs?: { minimum?: number; shop?: string; cap?: number }];   // exported:
// a line's copies each count (thingsIn)
const MAX_THINGS = 20;
const SHIPS_IN = 3, CUTOFF = 12;   // when a product doesn't say: Print API's usual making time and cut-off hour
// What a company's own tools add: a guard on a line's refund (a voucher it funds, say), and what a voucher on a line is
// worth (the vouchers kit: its value if it was spent on that order by that product, else why not).
export const lineRefundGuards: ((c: Caller, line: Line) => string | null)[] = [];
export const lineVoucher: ((c: Caller, reference: string, voucher: number) => number | string)[] = [];
// A stall's voucher typed in the shop's code box, from the company's vouchers kit.
// find: the voucher a typed code is, with its stall, or undefined when it's no stall's (counting nothing: the code box
// counts its wrong tries); spend: spends it on a line's order and answers what it pays, or why not; move: a changed
// design's line takes the place of the one its voucher pays (addToBasket's replaces), so the voucher pays the new line's
// order instead and answers what it pays there, or why not.
type StallVoucherStatus = 'unused' | 'spent' | 'refunding' | 'refunded' | 'refund_failed' | 'settled';
export type StallVoucher = { product: string; voucher: number; value: number; usable: boolean; spent_on: string | null; status: StallVoucherStatus };
export const basketVoucher: {
  find?: (mode: 'test' | 'live', typed: unknown) => StallVoucher | undefined;
  spend?: (line: Line, typed: unknown) => number | Refused;
  move?: (from: Line, to: Line) => number | Refused;
} = {};
// Tester vouchers pay in test mode on their product's preview, in a basket or for a plan (plans.ts).
// find: the typed voucher's code on that product (the shop unless named), or undefined. It counts no wrong tries.
// viewer: its owner's X-Viewer on that product. unusable: why it cannot pay now (used, invite ended or job run ended),
// or null. cap: the most it pays in cents, delivery included, from its invite or the player's default amount.
// use: spends it on the basket or plan's session inside the payment step, or says why not.
// retake: assigns it to a session whose cancelled parcel goes again by hand. Returns null, or the other session it
// paid since. Player vouchers never pay baskets, so they keep their spent session.
// Each kind registers a source in testerVoucherSources: tester invites in shares.ts, job players in players.ts.
// holds says whether a code belongs to that source. testerVoucher passes each call to the source that holds the code.
type TesterVoucherSource = {
  find: (code: string, product: string) => string | undefined;
  holds: (code: string) => boolean;
  viewer: (code: string) => string | null;
  unusable: (code: string) => Refused | null;
  cap: (code: string) => number;
  use: (code: string, session: string) => Refused | null;
  retake: (code: string, session: string) => string | null;
};
export const testerVoucherSources: TesterVoucherSource[] = [];
const voucherSource = (code: string) => testerVoucherSources.find(s => s.holds(code));
export const noSuchCode: Refused = [404, 'no such code', 'code_unknown'];
export const testerVoucher: Omit<TesterVoucherSource, 'holds' | 'find'> & {
  find: (typed: unknown, product?: string) => string | undefined;
} = {
  find: (typed, product = FRONT) => {
    const code = squeezedCode(typed);
    return /^TESTER[A-Z0-9]{12}$/.test(code)
      ? testerVoucherSources.map(source => source.find(code, product)).find(found => found)
      : undefined;
  },
  viewer: code => voucherSource(code)?.viewer(code) ?? null,
  unusable: code => {
    const source = voucherSource(code);
    return source ? source.unusable(code) : noSuchCode;
  },
  cap: code => {
    const source = voucherSource(code);
    if (!source) throw new Error('no tester voucher source holds this code');
    return source.cap(code);
  },
  use: (code, session) => {
    const source = voucherSource(code);
    return source ? source.use(code, session) : noSuchCode;
  },
  retake: (code, session) => voucherSource(code)?.retake(code, session) ?? null,
};
// Called when a basket's session turns paid (once: the row's status keeps it), with its lines as paid.
export const basketPaid: ((pay: any, s: any, lines: Line[]) => void)[] = [];
// the one parcel (parcels.ts) adds its part to a line's view, and keeps a basket's
// delivery address while its parcel may still be placed (again)
export const lineParts: ((line: Line) => Record<string, unknown> | null)[] = [];
// A thing's steps between its stall and its payment, for the stalls' funnels (metrics.ts), each once a line: basket, once
// it joined a basket of the shop's (a changed design taking its old line's place has its count; a line of the shop's own
// counts none); checkout, once a checkout HQ opened charges it (vouchers paying in full count too). n is 1 when a step is
// counted, at its time, and -1 when it's taken back, at the time it was counted: a basket that turns a test or a
// tester's takes back what its things counted (countSteps). Called inside the basket's change, all or nothing.
type LineStep = 'basket' | 'checkout';
export const lineSteps: ((line: Line, step: LineStep, at: string, n: 1 | -1) => void)[] = [];
// The steps of a basket's things as the basket now is, inside atOnce: in a real basket each thing counts the step once;
// in a test or a tester's basket, the steps its things counted are taken back and none is counted.
function countSteps(basket: string, step: LineStep) {
  const real = !isTestBasket(basket) && !testerOf(basket);
  for (const line of basketLines(basket).filter(l => !l.goes_with))
    for (const s of real ? [step] : (['basket', 'checkout'] as const)) {
      const counted = line[`${s}_counted`];
      if ((counted !== null) === real) continue;   // already counted in a real basket, or nothing to take back in a test one
      const at = counted ?? stamp();
      for (const hook of lineSteps) hook(line, s, at, real ? 1 : -1);
      db.prepare(`update pay_lines set ${s}_counted = ? where id = ?`).run(real ? at : null, line.id);
    }
}
export const keepAddress: ((session: string) => boolean)[] = [];
// a line its customer asked us to delete (forgetLine): parcels.ts deletes its print files at once, or as soon as no
// parcel needs them.
export const lineForgotten: ((line: Line) => Promise<void>)[] = [];
// a paid basket's records ending, past the years the law keeps them (records.ts): each module ends its own records of
// that session in the same step (its parcel, its emails), before its payment and lines go.
export const recordsEnded: ((session: string) => void)[] = [];
// the basket's code (codes.ts fills this). off: what the code takes off each line,
// given what each costs after its voucher. shown: the code a basket (open) or a session (its checkout, or paid) has, for
// the view, and dropped the code that left an open basket (and why). Before a checkout: refresh reads the session holding
// the basket's code, unusable says why the code can't go (and takes it out of the basket), hold holds it for the session
// about to open. paid: the session's payment, in the same step as its lines.
export type ShownCode = { code: string; kind: string; until: string; percent: number | null; off: number | null; minimum: number;
  cap: number | null };
export const basketCode: {
  off?: (basket: string, lines: { line: Line; due: number }[]) => number[];
  shown?: (where: { basket?: string; session?: string }) => ShownCode | null;
  dropped?: (basket: string) => { code: string; why: string } | null;
  refresh?: (basket: string) => Promise<void>;
  unusable?: (basket: string) => Refused | null;
  hold?: (basket: string) => { held: (session: string) => void; release: () => void };
  paid?: (pay: any) => void;
} = {};

// the shop's own lines. A company's kit may put a line of the front's own in a basket,
// going with one of its things (goes_with: a gift made of it, say; addOwnLine). price says what each costs now, given the
// basket's things, worked out again each time the basket is priced; at the checkout that price is the line's amount. They
// take no postage saved and no code, count toward no code's minimum, and leave the basket (cancelled) with their thing.
export const ownLines: { price?: (basket: string, things: Line[], own: Line[]) => number[] } = {};

const lineRow = (id: string) => db.prepare('select * from pay_lines where id = ?').get(id) as Line | undefined;
export const lineOf = (c: Caller, reference: string) =>
  db.prepare('select * from pay_lines where product = ? and mode = ? and reference = ?').get(c.slug, c.mode, reference) as Line | undefined;
const claimOf = (id: string) => signed(`line:${id}`);
const basketKey = (mode: string, basket: string) => `${FRONT}:${mode}:${basket}`;
const stamp = () => new Date().toISOString();
const text = (v: unknown) => String(v ?? '').replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim();
export const langOf = (locale: unknown) => { const l = String(locale ?? '').slice(0, 2); return LOCALES.has(l) && l !== 'auto' ? l : null; };   // exported:
export const shopName = (slug: string) => { const n = manifest(slug)?.name; return typeof n === 'string' && n.length <= 60 ? n : slug; };
// The front's manifest says where the shop delivers, what one parcel saves per country, in cents off each thing but one
// (priced()), how long an unpaid basket lives, as long as the shop's cookie naming it (30 days unless it says), and how
// many copies of one thing a line may hold (1 unless it says):
// basket: {countries: [NL, BE, DE], postage_saved: {NL: 400, BE: 400, DE: 400}, days: 30, copies: 10}.
function basketRules() {
  const b = manifest(FRONT)?.basket as any;
  const countries: string[] = Array.isArray(b?.countries) ? b.countries.map(String).filter((x: string) => /^[A-Z]{2}$/.test(x)) : [];
  const saved = (country: string) => { const v = b?.postage_saved?.[country]; return Number.isInteger(v) && v > 0 ? v as number : 0; };
  const days = Number.isInteger(b?.days) && b.days > 0 ? b.days as number : 30;
  const copies = Number.isInteger(b?.copies) && b.copies > 0 ? Math.min(b.copies as number, MAX_THINGS) : 1;
  return { countries, saved, days, copies };
}
// What the card pays for each line, in basket order: its amount for each copy less its voucher, then less what the
// basket's code takes, and the postage one parcel saves on every thing but one (each copy a thing), at most half of
// what's left, so each line keeps an amount of its own to refund. The line whose copy goes without is the one that loses
// least by it (a voucher-paid or cheap one; of equals the first), so the total is the same whatever order the lines
// went in. The shop's own lines (ownLines) cost what the company's price says now, nothing
// taken off. (Copies:)
type Priced = { line: Line; card: number; saved: number; code_saved: number };
// A test basket is priced as a real one, so its pages show what a customer's would. Its checkout charges nothing (paidAsTest).
// A tester's basket (tester) costs the card nothing: the voucher pays every line, the shop's own too.
function priced(all: Line[], country: string | null, tester = false): Priced[] {
  if (tester) return all.map(line => ({ line, card: 0, saved: 0, code_saved: 0 }));
  const lines = all.filter(line => !line.goes_with), own = all.filter(line => line.goes_with);
  const perLine = country ? basketRules().saved(country) : 0;
  const afterVoucher = lines.map(line => line.amount * line.quantity - (line.voucher_value ?? 0));
  const off = lines.length && basketCode.off ? basketCode.off(lines[0].basket!, lines.map((line, i) => ({ line, due: afterVoucher[i] }))) : [];
  const due = afterVoucher.map((d, i) => d - (off[i] ?? 0));
  const savedOn = (i: number, copies: number) => Math.min(perLine * copies, Math.floor(due[i] / 2));
  const lost = lines.map((line, i) => savedOn(i, line.quantity) - savedOn(i, line.quantity - 1));
  const without = lost.indexOf(Math.min(...lost));
  const things = lines.map((line, i) => {
    const saved = savedOn(i, i === without ? line.quantity - 1 : line.quantity);
    return { line, saved, code_saved: off[i] ?? 0, card: due[i] - saved };
  });
  const prices = own.length && ownLines.price ? ownLines.price(own[0].basket!, lines, own) : own.map(line => line.amount);
  const owned = own.map((line, i) => ({ line: { ...line, amount: prices[i] }, saved: 0, code_saved: 0, card: prices[i] }));
  return all.map(line => (line.goes_with ? owned[own.indexOf(line)] : things[lines.indexOf(line)]));
}
// The day the printer should ship a line: its making time in working days (the company's calendar, as Care counts them),
// counted from the day it was paid (or today), or from the next working day after the printer's cut-off hour.
// placed: when a test order went through, for its lines, which are never paid.
const DAY_MS = 864e5;
export const shipBy = (line: Line, placed: string | null = null) => {
  const from = line.paid_at ?? placed, at = from ? Date.parse(from) : Date.now();
  const own = shipDay(at, line.ships_in, line.cutoff);
  return line.basket ? latest([own, ...everyParcel.map(x => shipDay(at, x.days, x.cutoff))])! : own;
};
// What every basket's parcel also holds, at Print API's standard speed: working days to make it and its cut-off hour (a
// company's document in each, parcels.ts documents; its kit keeps this as Print API says). A basket's line ships no
// sooner.
export const everyParcel: { days: number; cutoff: number }[] = [];
// (the same sum for an item a company adds to a parcel: parcels.ts extras; and for a parcel placed again at express speed:
// parcels.ts hurryQuote)
export function shipDay(from: number, days: number, cutoff: number) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timeZone(), hour: 'numeric', hourCycle: 'h23' }).format(from));
  const workday = workingDaysBetween(from - DAY_MS, from) === 1;
  const start = workday && hour < cutoff ? from : addWorkingDays(from, 1) + DAY_MS / 2;
  return new Date(addWorkingDays(start, days)).toISOString().slice(0, 10);
}
const latest = (days: string[]) => days.reduce((a, b) => (b > a ? b : a), '') || null;

// ---- lines: the product's side
async function registerLine(c: Caller, b: any) {
  const reference = String(b.reference ?? ''), amount = b.amount, description = text(b.description);
  const detail = b.detail == null || b.detail === '' ? null : text(b.detail);
  const shipsIn = b.ships_in == null ? SHIPS_IN : b.ships_in, cutoff = b.cutoff == null ? CUTOFF : b.cutoff;
  const orderUrl = ownUrl(b.order_url, c.slug)?.href ?? null;
  // none (null), or its address on the product's own host (undefined: an address that isn't)
  const picture = b.picture == null || b.picture === '' ? null : ownUrl(b.picture, c.slug)?.href;
  if (picture === undefined || (picture && picture.length > 500)) return [400, "picture: its design's picture, https, on this product's own address, or none"];
  const known = REF.test(reference) ? lineOf(c, reference) : undefined;
  // A voucher spent on this order in the shop's basket stays on its line until the order gives it back. The stall may
  // register the line again before it has heard of it (payLineByVoucher).
  const given = b.voucher == null || b.voucher === '' ? null : b.voucher;
  const voucherToKeep = (line: Line | undefined) => {
    if (given !== null) return given;
    if (line?.voucher == null) return null;
    const stillPays = typeof voucherWorth(c, reference, line.voucher, line.amount * line.quantity) === 'number';
    return stillPays ? line.voucher : null;
  };
  const voucher = voucherToKeep(known);
  const offer = b.offer == null ? false : b.offer;
  const number = b.number == null || b.number === '' ? null : b.number;
  if (!REF.test(reference)) return [400, 'reference: 1-64 letters, digits, _ or -'];
  if (!Number.isInteger(amount) || amount < MIN || amount > MAX) return [400, `amount: whole cents from ${MIN} to ${MAX}`];
  if (!description || description.length > 120) return [400, 'description: 1-120 characters'];
  if (detail !== null && (!detail || detail.length > 120)) return [400, 'detail: 1-120 characters, or none'];
  if (!Number.isInteger(shipsIn) || shipsIn < 1 || shipsIn > 30) return [400, 'ships_in: working days to make it, 1 to 30'];
  if (!Number.isInteger(cutoff) || cutoff < 0 || cutoff > 23) return [400, "cutoff: the printer's cut-off hour, 0 to 23"];
  if (!orderUrl) return [400, "order_url: the item's order page, https, on this product's own address"];
  if (voucher !== null && (!Number.isInteger(voucher) || voucher < 1)) return [400, 'voucher: the id of a voucher spent on this order'];
  if (typeof offer !== 'boolean') return [400, 'offer: true when the amount is an offer price, else false'];
  if (number !== null && (typeof number !== 'string' || !ORDER_NUMBER.test(number))) return [400, 'number: the order number its customer is told, 1-32 letters, digits or -'];
  if (number !== null && known?.number && known.number !== number) return [409, 'number: this line already has another', 'number_set'];
  const voucherValue = voucher === null ? null : voucherWorth(c, reference, voucher, amount * (known?.quantity ?? 1));
  if (Array.isArray(voucherValue)) return voucherValue;
  const fields = { amount, description, detail, voucher, voucher_value: voucherValue, ships_in: shipsIn, cutoff, order_url: orderUrl, offer: offer ? 1 : 0, picture };
  if (!known) {
    const id = `ln_${randomBytes(12).toString('hex')}`, now = stamp();
    db.prepare(`insert into pay_lines (id, created, product, mode, reference, amount, currency, description, detail, voucher, voucher_value,
      ships_in, cutoff, order_url, offer, picture, status, updated) values (?, ?, ?, ?, ?, ?, 'eur', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(id, now, c.slug, c.mode, reference, amount, description, detail, voucher, voucherValue, shipsIn, cutoff, orderUrl, fields.offer, picture, now);
    log(`${c.slug} registered a ${c.mode} line of ${euros(amount, 'eur')} for ${reference}.`);
    numberLine(id, number);
    return lineView(c, lineRow(id)!);
  }
  numberLine(known.id, number);
  const same = (Object.keys(fields) as (keyof typeof fields)[]).every(k => known[k] === fields[k]);
  if (same && known.status !== 'cancelled') return lineView(c, known);
  const changed = await changeLine(known, line => {
    // Read the line again: while this waited in the basket's queue, a release may have freed its voucher, or the basket may
    // have spent one on it.
    const onLine = voucherToKeep(line);
    const value = onLine === null ? null : voucherWorth(c, reference, onLine, amount * line.quantity);
    if (Array.isArray(value)) return value;
    db.prepare(`update pay_lines set amount = ?, description = ?, detail = ?, voucher = ?, voucher_value = ?, ships_in = ?, cutoff = ?,
      order_url = ?, offer = ?, picture = ?, updated = ? where id = ?`).run(amount, description, detail, onLine, value, shipsIn, cutoff, orderUrl, fields.offer, picture, stamp(), line.id);
  });
  return changed ?? lineView(c, lineRow(known.id)!);
}
// The order number a line's customer was told, set once: it never changes the line's checkout
export const ORDER_NUMBER = /^[A-Za-z0-9-]{1,32}$/;
export const numberLine = (id: string, number: string | null) =>
  number !== null && db.prepare('update pay_lines set number = ? where id = ? and number is null').run(number, id).changes > 0;
// What a voucher pays on this order (the company's hook), or why it can't go on the line: amount is the whole line's,
// every copy.
function voucherWorth(c: Caller, reference: string, voucher: number, amount: number): number | [number, string] {
  const worth = lineVoucher.map(h => h(c, reference, voucher)).find(v => v !== undefined);
  if (worth === undefined) return [409, 'vouchers are not available here'];
  if (typeof worth === 'string') return [409, worth];
  if (amount < worth) return [409, `amount: this voucher pays ${worth} cents, on an order costing at least that`];
  return worth;
}

async function getLine(c: Caller, id: string) {
  const own = await ownLine(c, id);
  return own ? lineView(c, own.line, own) : [404, 'no such line for this product'];
}

async function cancelLine(c: Caller, id: string) {
  const own = await ownLine(c, id);
  if (!own) return [404, 'no such line for this product'];
  if (own.line.status === 'cancelled') return lineView(c, own.line);
  const changed = await changeLine(own.line, line => {
    cancel(line.id);
    log(`${c.slug} cancelled its ${c.mode} line for ${line.reference} before it was paid.`);
  });
  return changed ?? lineView(c, lineRow(id)!);
}

// A change to an unpaid line, in its basket's queue: the basket's open session ends first. null when it's done, else why
// not (apply may refuse too).
function changeLine(known: Line, apply: (line: Line) => Refused | void): Promise<Refused | null> {
  return serial(known.basket ? basketKey(known.mode, known.basket) : `line:${known.id}`, async () => {
    const line = lineRow(known.id)!;
    if (line.basket !== known.basket) return changeLine(line, apply);   // it moved basket while this waited
    if (line.status === 'paid') return [409, 'this order is already paid', 'line_paid'];
    if (line.status === 'cancelled') return [409, 'this order was cancelled: a new order needs a reference of its own', 'line_cancelled'];
    const open = line.basket ? openSessionOf(line.basket, line.mode) : undefined;
    const ended = open ? await endSession(open) : true;
    if (ended !== true) return ended;
    return apply(line) ?? null;
  });
}
// A cancel changes no clock: what the customer made, and the key to it (its order page, where the cancel can be taken
// back), stay until 90 days after the line's making (tick), as for any order, or until the customer asks the product to
// delete them (forgetLine) (DECISIONS, 2026-10-13 and 2026-10-14). The shop's own lines going with it are cancelled with
// it.
const cancel = (id: string) => {
  db.prepare(`update pay_lines set status = 'cancelled', updated = ? where id = ? or (goes_with = ? and status = 'open')`).run(stamp(), id, id);
  forgetHeldWords();   // what the board was shown of a held line
};

// The line, if it's the caller's; a payment made meanwhile is read first. Once paid: its session's row and Stripe's session.
export async function ownLine(c: Caller, id: string): Promise<{ line: Line; pay: any | null; s: any | null } | null> {
  if (!LINE.test(id)) return null;
  let line = lineRow(id);
  if (!line || line.product !== c.slug || line.mode !== c.mode) return null;
  const open = line.status === 'open' && line.basket ? openSessionOf(line.basket, line.mode) : undefined;
  if (open) { await readSession(open); line = lineRow(id)!; }
  if (line.status !== 'paid' || !line.session) return { line, pay: null, s: null };
  const pay = db.prepare('select * from payments where id = ?').get(line.session) as any;
  const s = await sessionOf(c.mode, line.session);
  if (s?.metadata?.product !== FRONT || s.metadata.reference !== pay?.reference || s.livemode !== (c.mode === 'live')) return null;
  return { line, pay, s };
}

async function lineView(c: Caller, known: Line, own?: { line: Line; pay: any | null; s: any | null }) {
  const { pay, s } = own ?? await ownLine(c, known.id) ?? { pay: null, s: null };
  let line = own?.line ?? lineRow(known.id)!;
  if (line.status === 'paid') line = await refreshLineRefund(line);
  const open = line.status === 'open' && line.basket ? openSessionOf(line.basket, line.mode) : undefined;
  const charged = open ? db.prepare('select card, saved, code_saved from session_lines where session = ? and line = ?').get(open.id, line.id) as any : null;
  // refunded: by its card, or closed with no card refund at all (a voucher paid it)
  const paid = line.status === 'paid', refunded = line.refund_status === 'succeeded';
  return { line: line.id, reference: line.reference, claim: claimOf(line.id), status: charged ? 'checkout' : line.status,
    amount: line.amount, currency: line.currency, description: line.description, detail: line.detail, voucher: line.voucher, voucher_value: line.voucher_value,
    offer: !!line.offer, code_saved: paid ? line.code_saved ?? 0 : charged?.code_saved ?? null,
    card: paid ? line.card : charged?.card ?? null, saved: paid ? line.saved : charged?.saved ?? null,
    in_basket: line.status === 'open' && !!line.basket, paid_at: line.paid_at, ship_by: shipBy(line),
    // the copies its customer asked for: HQ makes its items that many times in the parcel
    quantity: line.quantity,
    // the basket's order number, the one its customer is told
    order_number: line.session ? orderNumber(line.session) : null,
    deliver_to: paid && !refunded && pay?.deliver ? JSON.parse(pay.deliver) : null,
    email: paid ? address(s?.customer_details?.email) : null, lang: paid ? langOf(s?.locale) : null,
    // a voucher line closed with no Stripe refund says succeeded too (closeVoucherLine)
    refunded, refund_status: line.refund_status ?? (line.refund ? 'pending' : null), ...Object.assign({}, ...lineParts.map(part => part(line))) };
}

// ---- line refunds: what the card paid for the line, back to the basket's payment. Like refund() above, the guards and the
// mark are one step, and the mark stays until Stripe's answer is in. Refunds of one payment go one at a time (refundQueue),
// so two products refunding their lines of one basket never race.
const lineAskingNow = new Map<string, number>();
export const lineAsking = (id: string) => (lineAskingNow.get(id) ?? 0) > 0;
export const refundQueue = <T>(session: string, run: () => Promise<T>) => serial(`refund:${session}`, run);
const lineAskedMark = (id: string, on: boolean) => db.prepare('update pay_lines set refund_asked = ? where id = ?').run(on ? stamp() : null, id);
export async function refundLine(c: Caller, id: string) {
  const own = await ownLine(c, id);
  if (!own) return [404, 'no such line for this product'];
  if (own.line.status !== 'paid' || !own.s) return [409, 'this line is not paid'];
  return refundQueue(own.line.session!, async () => {
    const line = lineRow(id)!, asked = !!line.refund_asked;
    const held = lineRefundGuards.map(g => g(c, line)).find(Boolean);
    if (held) return [409, held];
    if (!line.card) return closeVoucherLine(c, line);
    lineAskingNow.set(id, (lineAskingNow.get(id) ?? 0) + 1);   // in the same step as the guards
    lineAskedMark(id, true);
    try { const r = await lineRefundAsked(c, line, own.s, asked); lineAskedMark(id, false); return r; }
    catch (e) {
      if (e instanceof StripeError && e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 429) lineAskedMark(id, false);
      throw e;
    }
    finally { const n = (lineAskingNow.get(id) ?? 1) - 1; if (n > 0) lineAskingNow.set(id, n); else lineAskingNow.delete(id); }
  });
}
// A line its voucher paid in full: the card has nothing to give back, so once the product has released the voucher the
// line counts as refunded, and is kept as any refunded line (refundedLine). A voucher no tool answers for counts as still
// spent: the line stays as it is.
function closeVoucherLine(c: Caller, line: Line) {
  if (line.refund_status === 'succeeded') return lineView(c, line);
  const worth = line.voucher === null ? 'no voucher' : lineVoucher.map(h => h(c, line.reference, line.voucher!)).find(v => v !== undefined);
  if (worth === undefined) return [409, 'nothing here can tell whether the voucher is released: the line stays as it is'];
  if (typeof worth === 'number') return [409, 'the card paid nothing for this line: release the voucher first, then close the line'];
  db.prepare("update pay_lines set refund_status = 'succeeded', updated = ? where id = ?").run(stamp(), line.id);
  refundedLine(line);
  log(`${line.product} cancelled its ${line.mode} line for ${line.reference}, paid by a voucher it released.`);
  return lineView(c, lineRow(line.id)!);
}
async function lineRefundAsked(c: Caller, known: Line, s: any, askedBefore: boolean) {
  let line = await refreshLineRefund(known);
  if (line.refund && !ENDED.has(line.refund_status ?? '')) return lineView(c, line);   // succeeded, or on its way
  if (s.status !== 'complete' || s.payment_status !== 'paid' || !s.payment_intent) return [409, 'this basket is not paid'];
  const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id;
  // asked before and never answered: a refund Stripe made then (its key may be forgotten) is this line's, found by its line
  const lost = askedBefore ? (await stripe(c.mode, 'GET', `/v1/refunds?payment_intent=${encodeURIComponent(pi)}&limit=100`))?.data
    ?.find((r: any) => r?.metadata?.line === line.id && !ENDED.has(r?.status) && r.id !== line.refund) : null;
  const r = lost ?? await stripe(c.mode, 'POST', '/v1/refunds', { payment_intent: pi, amount: line.card,
    metadata: { product: c.slug, reference: line.reference, line: line.id } }, line.refund ? `refund-${line.id}-after-${line.refund}` : `refund-${line.id}`);
  line = noteLineRefund(line, r);
  return lineView(c, line);
}
function noteLineRefund(line: Line, r: any): Line {
  if (r.id === line.refund && r.status === line.refund_status) return line;
  db.prepare('update pay_lines set refund = ?, refund_status = ?, updated = ? where id = ?').run(r.id, r.status, stamp(), line.id);
  forgetHeldWords();   // a refund asked takes a held line off the board's list
  if (r.status === 'succeeded') refundedLine(line);
  const what = `${line.reference} (${line.mode}, ${euros(line.card ?? 0, line.currency)} of a basket)`;
  if (r.status === 'succeeded') log(`${line.product} refunded ${what}.`);
  else if (ENDED.has(r.status)) log(`${line.product}: the refund of ${what} ${r.status}. The customer does NOT have the money back; the product can refund again, or the owner should look.`);
  else log(`${line.product} asked for a refund of ${what}: ${r.status} at Stripe.`);
  return { ...line, refund: r.id, refund_status: r.status };
}
// A refunded line is a cancelled order, and a cancel changes no clock: what the customer made and its order page stay
// as for any paid line (90 days after the payment, tick), and so does the basket's address (14 days, at most 30) (as
// cancel() above). The shop's own lines going with it that are free close as refunded: there's nothing to give back.
function refundedLine(line: Line) {
  db.prepare("update pay_lines set refund_status = 'succeeded', updated = ? where goes_with = ? and status = 'paid' and card = 0 and refund_status is null")
    .run(stamp(), line.id);
  forgetHeldWords();   // a voucher-paid line closes here, not through noteLineRefund
}
// A deletion request, the product's own forgetNow: no grace (GDPR art. 17(1), "without undue delay"; the product's page
// confirmed it once). The line's words and order page go now, the shop's own lines' copies with them; the basket's
// address and payer email, and the line's print files, as soon as no parcel needs them (tick), at once if none does. The line's price and
// reference stay, for the books.
async function forgetLine(c: Caller, id: string) {
  const line = LINE.test(id) ? lineRow(id) : undefined;
  if (!line || line.product !== c.slug || line.mode !== c.mode) return [404, 'no such line for this product'];
  atOnce(() => {
    // and its keeping, and the basket's payer hash (never to be had again)
    db.prepare("update pay_lines set description = '', detail = null, order_url = null, picture = null, kept_until = null where id = ? or goes_with = ?").run(id, id);
    if (line.session) db.prepare("update payments set forget_asked = ?, payer_hash = '' where id = ?").run(stamp(), line.session);
  });
  forgetHeldWords();
  forgetAskedAddresses();
  // a basket whose address and payer email already went (tick) waits for no parcel: the imitation's copy of the email goes now
  if (line.session && !db.prepare('select 1 from payments where id = ? and (deliver is not null or payer is not null)').get(line.session))
    forgetImitationEmail(line.session);
  for (const forget of lineForgotten) await forget(line);
  log(`${c.slug} deleted its ${c.mode} line for ${line.reference}'s details, as its customer asked.`);
  return { line: id };
}
// The addresses and payer emails of baskets whose customer asked, once no parcel needs the address (keepAddress)
function forgetAskedAddresses() {
  for (const asked of db.prepare('select id from payments where forget_asked is not null and (deliver is not null or payer is not null)').all() as { id: string }[])
    if (!keepAddress.some(keep => keep(asked.id))) {
      db.prepare('update payments set deliver = null, payer = null where id = ?').run(asked.id);
      forgetImitationEmail(asked.id);
    }
}
async function refreshLineRefund(line: Line) {
  if (!line.refund || line.refund_status === 'succeeded' || ENDED.has(line.refund_status ?? '')) return line;
  return noteLineRefund(line, await stripe(line.mode, 'GET', `/v1/refunds/${encodeURIComponent(line.refund)}`));
}
// a refund that succeeded can still fail later (Stripe: up to 30 days); a tool reads one again
export async function recheckLineRefund(c: Caller, id: string) {
  const line = lineRow(id);
  if (!line?.refund || line.product !== c.slug || line.mode !== c.mode) return null;
  return noteLineRefund(line, await stripe(c.mode, 'GET', `/v1/refunds/${encodeURIComponent(line.refund)}`)).refund_status;
}

// ---- baskets: the front's side
const basketRow = (id: string) => db.prepare('select * from baskets where id = ?').get(id) as { id: string; mode: string; status: string; test: number | null;
  tester: string | null } | undefined;
export const ownBasket = (c: Caller, id: unknown) => { const b = BASKET.test(String(id ?? '')) ? basketRow(String(id)) : undefined; return b?.mode === c.mode ? b : undefined; };
const openSessionOf = (basket: string, mode: string) => db.prepare(`select * from payments where product = ? and mode = ? and reference = ?
  and status in ('open', 'complete') order by created desc limit 1`).get(FRONT, mode, basket) as any;
export const basketLines = (basket: string) =>   // exported:
  db.prepare("select * from pay_lines where basket = ? and status = 'open' order by position").all(basket) as Line[];
// Whether a paid basket's buyer had a paid basket before (codes.ts's buyer key fills this, kept 12 months after a buyer's
// last order): null when it isn't known.
export const basketBuyer: { returning?: (session: string) => boolean | null } = {};
// The shop's paid baskets per Dutch day from..to, for Numbers: how many the card paid something for (a basket its
// vouchers paid in full is a replacement, and a test order is never paid), how many held more than one thing (a line of
// the shop's own, going with a thing, isn't one), and how many came from a buyer who paid for one before, among those
// whose buyer is known. Counts only.
export function basketsByDay(mode: 'test' | 'live', from: string, to: string) {
  // a margin around the days asked for, so a Dutch day's baskets are all inside whatever the offset from UTC
  const since = new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS).toISOString();
  const until = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  // (things count copies)
  const paidBaskets = db.prepare(`select p.id, min(l.paid_at) paid_at, sum(case when l.goes_with is null then l.quantity else 0 end) things
    from payments p join session_lines sl on sl.session = p.id
    join pay_lines l on l.id = sl.line where p.product = ? and p.mode = ? and p.basket is not null and p.status in ('paid', 'refunded') and p.amount > 0
    and l.paid_at >= ? and l.paid_at < ? group by p.id`).all(FRONT, mode, since, until) as { id: string; paid_at: string; things: number }[];
  const days = new Map<string, { day: string; paid: number; several: number; returning: number; known: number }>();
  for (const basket of paidBaskets) {
    const day = companyDay(Date.parse(basket.paid_at));
    if (day < from || day > to) continue;
    let count = days.get(day);
    if (!count) {
      count = { day, paid: 0, several: 0, returning: 0, known: 0 };
      days.set(day, count);
    }
    const back = basketBuyer.returning?.(basket.id) ?? null;
    count.paid += 1;
    count.several += basket.things > 1 ? 1 : 0;
    count.known += back === null ? 0 : 1;
    count.returning += back ? 1 : 0;
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}
export function paidLines(session: string): Line[] {
  return (db.prepare(`select l.*, sl.card paid_card, sl.saved paid_saved, sl.code_saved paid_code_saved from session_lines sl join pay_lines l on l.id = sl.line
    where sl.session = ? order by sl.position`).all(session) as any[])
    .map(({ paid_card, paid_saved, paid_code_saved, ...line }) => ({ ...line, card: paid_card, saved: paid_saved, code_saved: paid_code_saved }));
}

async function addToBasket(c: Caller, b: any) {
  const id = String(b.line ?? ''), claim = String(b.claim ?? '');
  const proven = LINE.test(id) && /^[a-f0-9]{64}$/.test(claim) && timingSafeEqual(Buffer.from(claimOf(id)), Buffer.from(claim));
  const line = proven ? lineRow(id) : undefined;
  if (!line || line.mode !== c.mode) return [404, 'no such line'];   // a test line never joins a live basket
  if (c.mode === 'live' && !approved(`live:${line.product}`)) return [403, `${line.product} isn't approved for launch`, 'not_approved'];
  if (line.status !== 'open') return notOpen(line);
  let basket = ownBasket(c, b.basket);
  if (!basket || basket.status !== 'open') {
    const now = stamp();
    basket = { id: `bk_${randomBytes(16).toString('hex')}`, mode: c.mode, status: 'open', test: null, tester: null };
    db.prepare("insert into baskets (id, mode, created, updated, status) values (?, ?, ?, ?, 'open')").run(basket.id, c.mode, now, now);
  }
  const to = basket.id;
  if (line.basket === to) return basketView(c, to);
  // in another basket (another tab, a lost cookie): out of that one first, ending its open session
  if (line.basket) {
    const out = await changeLine(line, moved => { leave(moved.id); });
    if (out) return out;
  }
  const added = await serial(basketKey(c.mode, to), async () => {
    const now = lineRow(id)!;
    if (now.status !== 'open') return notOpen(now);
    if (now.basket && now.basket !== to) return [409, 'this order just went into another basket', 'line_elsewhere'] as Refused;
    if (basketRow(to)!.status !== 'open') return [409, 'this basket is already paid', 'already_paid'] as Refused;
    const old = replaced(b.replaces, now, to);
    // (a line with a voucher comes with its copies: leave())
    if (!old && thingsIn(to) + now.quantity > MAX_THINGS) return basketFull;
    const open = openSessionOf(to, c.mode), ended = open ? await endSession(open) : true;
    if (ended !== true) return ended;
    const still = old && replaced(b.replaces, now, to);
    if (!still && thingsIn(to) + now.quantity > MAX_THINGS) return basketFull;
    const position = still?.position
      ?? (db.prepare('select coalesce(max(position), 0) + 1 p from pay_lines where basket = ?').get(to) as { p: number }).p;
    return joinBasketLine(c, now, to, position, still);
  });
  return added ?? basketView(c, to);
}
// The line joins its basket, in the place of the one it replaces (still) when there is one: that line's copies and its
// shop-own lines go with the new one, in its words, and the old one leaves (a voucher on it pays the new one, or nothing
// changes). All or nothing, inside the basket's queue. (Copies:)
function joinBasketLine(c: Caller, line: Line, basket: string, position: number, still: Line | null): Refused | null {
  let refused: Refused | null = null;
  // a voucher of the line's own stays on it in the old line's place (that one has none to pay it): the old line's copies
  // must cost at least what it pays, as setQuantity asks
  if (still && still.voucher === null && line.voucher_value !== null && line.amount * still.quantity < line.voucher_value)
    return [409, `this voucher pays ${line.voucher_value} cents, on copies costing at least that`, 'voucher_copies'];
  atOnce(() => {
    // the line may have gone into another basket (and its checkout) while the session ended: only a line still free joins
    const joined = db.prepare("update pay_lines set basket = ?, position = ?, updated = ? where id = ? and status = 'open' and basket is null")
      .run(basket, position, stamp(), line.id).changes;
    if (!joined) return void (refused = [409, 'this order just went into another basket', 'line_elsewhere']);
    if (still) {
      // the old line's copies, then a voucher on the old design pays the new one instead, or the basket keeps the old
      // design and its voucher
      db.prepare('update pay_lines set quantity = ?, basket_counted = ?, checkout_counted = ? where id = ?')
        .run(still.quantity, still.basket_counted, still.checkout_counted, line.id);
      if (still.voucher !== null) {
        const moved = basketVoucher.move?.(still, lineRow(line.id)!) ?? ([409, 'vouchers are not available here'] as Refused);
        if (Array.isArray(moved)) { refused = moved; return false; }
        db.prepare('update pay_lines set voucher = null, voucher_value = null where id = ?').run(still.id);
        db.prepare('update pay_lines set voucher = ?, voucher_value = ? where id = ?').run(still.voucher, moved, line.id);
      }
      db.prepare("update pay_lines set goes_with = ?, detail = ?, order_url = ?, updated = ? where goes_with = ? and status = 'open'")
        .run(line.id, line.detail, line.order_url, stamp(), still.id);
      // its counts went to the new line: the old one, put in again, counts as a new order
      db.prepare('update pay_lines set basket = null, position = null, quantity = 1, basket_counted = null, checkout_counted = null, updated = ? where id = ?')
        .run(stamp(), still.id);
      log(`${shopName(line.product)}'s changed design took its old line's place in a ${c.mode} basket.`);
    }
    countSteps(basket, 'basket');
    db.prepare('update baskets set updated = ? where id = ?').run(stamp(), basket);
  });
  return refused;
}
const basketFull: Refused = [409, `a basket takes ${MAX_THINGS} things at most`, 'basket_full'];
const thingsIn = (basket: string) => basketLines(basket).reduce((n, line) => n + line.quantity, 0);
// The line a changed design replaces (replaces: its id, the stall's /line answer): only an open thing of the same product
// in this basket, never the shop's own line nor the new line itself; anything else adds the new line as any line. A
// voucher on it moves to the new line (joinBasketLine).
function replaced(asked: unknown, line: Line, basket: string) {
  const old = LINE.test(String(asked ?? '')) && asked !== line.id ? lineRow(String(asked)) : undefined;
  return old && old.basket === basket && old.status === 'open' && old.product === line.product && !old.goes_with ? old : null;
}
const notOpen = (line: Line): Refused => line.status === 'paid' ? [409, 'this order is already paid', 'line_paid']
  : [409, 'this order was cancelled', 'line_cancelled'];

async function removeFromBasket(c: Caller, b: any) {
  const basket = ownBasket(c, b.basket), line = LINE.test(String(b.line ?? '')) ? lineRow(String(b.line)) : undefined;
  if (!basket) return [404, 'no such basket', 'basket_gone'];
  if (!line || line.basket !== basket.id || line.status !== 'open') return basketView(c, basket.id);   // gone already
  const out = await changeLine(line, gone => { leave(gone.id); });
  return out ?? basketView(c, basket.id);
}
// How many copies of a thing the basket holds: the same design made that many times, each copy a thing of its own
// (priced()), from 1 to the manifest's copies (basketRules). Like a remove, a line gone already gives the basket's view
async function setQuantity(c: Caller, b: any) {
  const basket = ownBasket(c, b.basket), line = LINE.test(String(b.line ?? '')) ? lineRow(String(b.line)) : undefined;
  const quantity = b.quantity, copies = basketRules().copies;
  if (!basket) return [404, 'no such basket', 'basket_gone'];
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > copies) return [400, `quantity: 1 to ${copies}`];
  if (!line || line.basket !== basket.id || line.status !== 'open' || line.goes_with) return basketView(c, basket.id, b.country);
  const out = await changeLine(line, now => {
    if (now.basket !== basket.id) return;
    if (thingsIn(basket.id) - now.quantity + quantity > MAX_THINGS) return basketFull;
    // a voucher on the line pays its whole value: the copies left must cost at least that (voucherWorth)
    if (now.voucher_value !== null && now.amount * quantity < now.voucher_value)
      return [409, `this voucher pays ${now.voucher_value} cents, on copies costing at least that`, 'voucher_copies'];
    db.prepare('update pay_lines set quantity = ?, updated = ? where id = ?').run(quantity, stamp(), now.id);
    db.prepare('update baskets set updated = ? where id = ?').run(stamp(), basket.id);
  });
  return out ?? basketView(c, basket.id, b.country);
}

// A line out of its basket; the shop's own lines going with it are cancelled, and one
// of the shop's own is cancelled as it leaves (it means nothing outside its basket). Their words stay as a cancel's do
// (cancel()).
function leave(id: string) {
  if (lineRow(id)?.goes_with) return void cancel(id);
  // out of the basket, its copies go back to one, but for a line with a voucher: that was spent on its copies, so it
  // comes back with them
  db.prepare(`update pay_lines set basket = null, position = null, quantity = case when voucher is null then 1 else quantity end,
    updated = ? where id = ?`).run(stamp(), id);
  db.prepare("update pay_lines set status = 'cancelled', updated = ? where goes_with = ? and status = 'open'").run(stamp(), id);
}

// a line of the shop's own going with a thing of the basket, for a company's kit, inside
// changeBasket's apply (the basket's queue, its open session ended). Its amount is the price it has as it's added; its
// order page its thing's; its detail its thing's.
export function addOwnLine(basket: string, a: { goes_with: string; description: string; amount: number; ships_in: number; cutoff: number }): Refused | null {
  const thing = lineRow(a.goes_with);
  if (!thing || thing.basket !== basket || thing.status !== 'open' || thing.goes_with) return [409, 'goes_with: a thing in this basket', 'own_thing'];
  if (thingsIn(basket) >= MAX_THINGS) return basketFull;
  const id = `ln_${randomBytes(12).toString('hex')}`, now = stamp();
  const position = (db.prepare('select coalesce(max(position), 0) + 1 p from pay_lines where basket = ?').get(basket) as { p: number }).p;
  db.prepare(`insert into pay_lines (id, created, product, mode, reference, amount, currency, description, detail, ships_in, cutoff, order_url,
    basket, position, offer, goes_with, status, updated) values (?, ?, ?, ?, ?, ?, 'eur', ?, ?, ?, ?, ?, ?, ?, 0, ?, 'open', ?)`)
    .run(id, now, FRONT, thing.mode, `own_${id.slice(3)}`, a.amount, text(a.description).slice(0, 120), thing.detail, a.ships_in, a.cutoff,
      thing.order_url, basket, position, thing.id, now);
  db.prepare('update baskets set updated = ? where id = ?').run(now, basket);
  return null;
}

// A change to the basket itself (its code: codes.ts), in its queue like a line's: its open session ends first, then apply
// runs. The basket's view after, or why not (apply may refuse too).
export async function changeBasket(c: Caller, id: unknown, apply: (basket: string) => Refused | void, country?: unknown) {
  const basket = ownBasket(c, id);
  if (!basket) return [404, 'no such basket', 'basket_gone'] as Refused;
  const out = await serial(basketKey(c.mode, basket.id), async () => {
    if (basketRow(basket.id)?.status !== 'open') return [409, 'this basket is already paid', 'already_paid'] as Refused;
    const open = openSessionOf(basket.id, c.mode), ended = open ? await endSession(open) : true;
    if (ended !== true) return ended;
    return apply(basket.id) ?? null;
  });
  return out ?? basketView(c, basket.id, country);
}

// A stall's voucher typed in the shop's code box: spent on the basket's open
// line of its stall that it fits, which the card then pays that much less for, as if the stall had redeemed it itself
// (lineVoucher); the stall finds it on its line. It stays with that order: taking the thing out of the basket gives it
// back when the line ends, as the stall's own release does. The basket's view, why not, or undefined when the code is
// no stall's voucher.
export async function payLineByVoucher(c: Caller, basket: string, typed: unknown, country?: unknown) {
  const found = basketVoucher.find?.(c.mode, typed);
  if (!found) return undefined;
  const before = linesForVoucher(found, basket);
  if (before === 'paying') return basketView(c, basket, country);
  if (Array.isArray(before)) return before;
  return changeBasket(c, basket, id => {
    const now = basketVoucher.find?.(c.mode, typed);   // read again: the basket's open session ended meanwhile
    const fits = now ? linesForVoucher(now, id) : ([404, 'no such voucher', 'code_unknown'] as Refused);
    if (fits === 'paying') return;
    if (Array.isArray(fits)) return fits;
    // voucher_second: that line's order has another voucher already, spent on the stall's own page; the next may not
    let refused: Refused | undefined;
    for (const line of fits.lines) {
      const paid = basketVoucher.spend!(line, typed);
      if (Array.isArray(paid) && paid[2] === 'voucher_second') { refused = paid; continue; }
      if (Array.isArray(paid)) return paid;
      db.prepare('update pay_lines set voucher = ?, voucher_value = ?, updated = ? where id = ?').run(now!.voucher, paid, stamp(), line.id);
      log(`The shop's basket spent ${line.product}'s voucher V${now!.voucher} on ${line.reference}.`);
      return;
    }
    return refused;
  }, country);
}
// The basket's open lines of the voucher's stall it can pay (no voucher on them yet, their copies costing at least the
// voucher's value), 'paying' when it already pays one of them, or why not, in words the shop can say.
function linesForVoucher(v: StallVoucher, basket: string): { lines: Line[] } | 'paying' | Refused {
  const ones = basketLines(basket).filter(l => l.product === v.product && !l.goes_with);
  if (ones.some(l => l.voucher === v.voucher && l.reference === v.spent_on)) return 'paying';
  if (!v.usable) {
    if (v.status === 'spent') return [409, 'this voucher is already used', 'voucher_used'];
    if (v.status === 'unused') return [409, 'this voucher has passed its end date', 'voucher_expired'];
    return [409, `this voucher is ${v.status}`, 'voucher_gone'];
  }
  const free = ones.filter(l => l.voucher === null), lines = free.filter(l => l.amount * l.quantity >= v.value);
  if (lines.length) return { lines };
  if (free.length) return [409, `this voucher pays ${v.value} cents, on an order costing at least that`, 'voucher_cheaper'];
  return [409, `this voucher pays for an order of ${v.product}'s, and none without a voucher is in this basket`, 'voucher_no_line', { shop: shopName(v.product) }];
}

export async function basketView(c: Caller, id: string, asked?: unknown) {   // exported:
  const open = openSessionOf(id, c.mode);
  if (open) await readSession(open);   // a payment made meanwhile settles the basket first
  const basket = basketRow(id)!, rules = basketRules(), stillOpen = openSessionOf(id, c.mode);
  const country = rules.countries.includes(String(asked)) ? String(asked) : stillOpen?.country ?? null;
  const paid = basket.status === 'paid' ? db.prepare("select id, country, status, created from payments where reference = ? and status in ('paid', 'test') and basket = ?").get(id, id) as any : null;
  const tester = paid ? isTesterOrder(paid.id) : !!basket.tester;
  const lines = paid ? paidLines(paid.id).map(line => ({ line, card: line.card!, saved: line.saved!, code_saved: line.code_saved ?? 0 })) : priced(basketLines(id), country, tester);
  // an open tester's basket: what its voucher pays at most, and whether the basket comes to more (testerWorth)
  const cap = !paid && basket.tester ? testerVoucher.cap?.(basket.tester) ?? null : null;
  const capped = cap === null ? {} : { tester_cap: { cap, over: testerWorth(lines) > cap } };
  const code = basketCode.shown?.(paid ? { session: paid.id } : { basket: id }) ?? null;
  const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
  // a paid basket dropped nothing: a test order's lines are cancelled as it goes through.
  // A line of the shop's own was cancelled by the customer taking it or its thing out, never by a stall
  const dropped = paid ? [] : (db.prepare(`select id, product from pay_lines where basket = ? and status = 'cancelled' and goes_with is null and updated > ?
    order by position`).all(id, dayAgo) as any[])
    .map(l => ({ line: l.id, shop: shopName(l.product), why: 'cancelled' }));
  return { basket: id, status: paid ? 'paid' : stillOpen ? 'checkout' : 'open', countries: rules.countries, country: paid?.country ?? country,
    copies: rules.copies,
    ...summary(lines, code, !!basket.test, paid?.status === 'test' ? paid.created : null, tester), ...capped, dropped,
    code_dropped: paid ? null : basketCode.dropped?.(id) ?? null };
}
// code: the basket's code and what it saved in all, and per line offer and code_saved
// test: the basket holds the shop's test code. Its prices and ship days are a real order's, so the shop shows the page a
// customer sees. Nothing of it is charged, made or sent.
// placed: a test order's time, its ship days' start (shipBy)
// tester: the basket holds a tester's voucher, or its order did: the card pays nothing for any line, and it's made for real
// (each line's quantity)
const summary = (lines: Priced[], code: ShownCode | null, test = false, placed: string | null = null, tester = false) => ({
  lines: lines.map(({ line, card, saved, code_saved }) => ({ line: line.id, product: line.product, shop: shopName(line.product),
    description: line.description, detail: line.detail, amount: line.amount, quantity: line.quantity, voucher_value: line.voucher_value,
    offer: !!line.offer, code_saved, saved, card,
    goes_with: line.goes_with ?? null,
    ship_by: shipBy(line, placed), order_url: line.order_url, picture: line.picture ?? null,
    refund_status: line.refund_status })),   // set: its product cancelled it and asked for its money back
  total: lines.reduce((n, l) => n + l.card, 0), saved: lines.reduce((n, l) => n + l.saved, 0), ship_by: latest(lines.map(l => shipBy(l.line, placed))),
  code: code && { ...code, saved: lines.reduce((n, l) => n + l.code_saved, 0) }, test, tester,
  revision: revisionOf(lines, code, test, tester) });
// What a checkout would charge, in short: its lines in order, what the card pays for each, and the code that takes part
// (a basket without one keeps the revision it had before codes)
// (and a test order's mark, so a page that showed a test order never pays the real basket, nor the reverse: basket_changed;
// (a line of copies carries its quantity)
const revisionOf = (lines: { line: Line; card: number }[], code: ShownCode | null, test = false, tester = false) => {
  const charged = lines.map(l => (l.line.quantity > 1 ? [l.line.id, l.card, l.line.quantity] : [l.line.id, l.card]));
  const marked = tester ? [charged, 'tester'] : test ? [charged, 'test'] : code ? [charged, code.code] : charged;
  return createHash('sha256').update(JSON.stringify(marked)).digest('hex').slice(0, 16);
};

async function checkoutBasket(c: Caller, b: any) {
  const basket = ownBasket(c, b.basket);
  if (!basket) return [404, 'no such basket', 'basket_gone'];
  const rules = basketRules(), deliver = deliverTo(b.deliver_to);
  const success = returnUrl(b.success_url, FRONT), cancel = returnUrl(b.cancel_url, FRONT);
  const locale = b.locale == null || b.locale === '' ? 'auto' : String(b.locale), email = address(b.email);
  if (!rules.countries.length) return [503, "the shop names no countries it delivers to (the front's manifest: basket.countries)"];
  if (Array.isArray(deliver)) return deliver;
  if (!rules.countries.includes(deliver.country)) return [400, `deliver_to.country: one of ${rules.countries.join(', ')}`, 'country_not_delivered'];
  if (!email) return [400, 'email: an email address', 'email_invalid'];
  if (!LOCALES.has(locale)) return [400, "locale: one of Stripe Checkout's (auto, en, nl, de, fr...)"];
  if (!success || !cancel) return [400, "success_url and cancel_url: https, on the shop's own address"];
  return serial(basketKey(c.mode, basket.id), async () => {
    if (basketRow(basket.id)!.status !== 'open') return [409, 'this basket is already paid', 'already_paid'];
    const lines = basketLines(basket.id);
    if (!lines.some(line => !line.goes_with)) return [409, 'the basket is empty', 'basket_empty'];   // own lines:
    const unapproved = c.mode === 'live' ? lines.find(l => !approved(`live:${l.product}`)) : undefined;
    if (unapproved) return [403, `${unapproved.product} isn't approved for launch`, 'not_approved'];
    if (isTestBasket(basket.id)) {
      const charges = priced(lines, deliver.country);
      if (b.revision != null && b.revision !== revisionOf(charges, null, true))
        return [409, "the basket changed since its page showed it: show it again (GET /api/pay/basket)", 'basket_changed'];
      return paidAsTest(c, basket.id, charges, { success, locale, country: deliver.country });
    }
    const tester = basketRow(basket.id)!.tester;
    if (tester) {
      const charges = priced(lines, deliver.country, true);
      if (b.revision != null && b.revision !== revisionOf(charges, null, false, true))
        return [409, "the basket changed since its page showed it: show it again (GET /api/pay/basket)", 'basket_changed'];
      return paidByTester(c, basket.id, tester, charges, { success, locale, email, deliver });
    }
    // the basket's code, still good (from here to its hold, nothing is awaited)
    await basketCode.refresh?.(basket.id);
    const badCode = basketCode.unusable?.(basket.id);
    if (badCode) return badCode;
    const code = basketCode.shown?.({ basket: basket.id }) ?? null;
    const charges = priced(lines, deliver.country), total = charges.reduce((n, l) => n + l.card, 0);
    if (b.revision != null && b.revision !== revisionOf(charges, code))
      return [409, "the basket changed since its page showed it: show it again (GET /api/pay/basket)", 'basket_changed'];
    if (total > 0 && total < MIN)
      return [409, `the card would pay ${euros(total, 'eur')}, and a card payment is at least ${euros(MIN, 'eur')}: add something to the basket`, 'card_total_low'];
    if (total > MAX) return [409, `the basket comes to ${euros(total, 'eur')}, and one payment is at most ${euros(MAX, 'eur')}: `
      + 'take some orders out, pay for the rest, then put them back in a new basket', 'card_total_high'];
    // (a line of copies: one item at its whole price, "2 × " in its name, since its copies needn't cost the same (one may
    // go without the postage saved))
    const items = charges.filter(l => l.card > 0).map(l => ({ name: `${copiesOf(l.line)}${shopName(l.line.product)}: ${l.line.description}`, amount: l.card }));
    // the names sent to Stripe too: a renamed line gets a new session, and a retry after a lost answer a key of its own
    // (and the code)
    const shaped = code ? [charges.map(l => [l.line.id, l.card, l.saved]), items, deliver, code.code] : [charges.map(l => [l.line.id, l.card, l.saved]), items, deliver];
    const shape = createHash('sha256').update(JSON.stringify(shaped)).digest('hex').slice(0, 16);
    // a code that takes something off is held for the session (codes.ts), from now until the session can't be paid
    const hold = charges.some(l => l.code_saved > 0) ? basketCode.hold?.(basket.id) : undefined;
    const created = (session: string) => {
      const insert = db.prepare('insert into session_lines (session, line, position, card, saved, code_saved) values (?, ?, ?, ?, ?, ?)');
      charges.forEach((l, i) => insert.run(session, l.line.id, i + 1, l.card, l.saved, l.code_saved));
      // the shop's own lines cost what this checkout charges
      for (const l of charges.filter(x => x.line.goes_with)) db.prepare('update pay_lines set amount = ? where id = ?').run(l.card, l.line.id);
      db.prepare('update payments set deliver = ?, country = ? where id = ?').run(JSON.stringify(deliver), deliver.country, session);
      hold?.held(session);
      countSteps(basket.id, 'checkout');
    };
    try {
      if (total === 0) return await paidByVouchers(c, basket.id, { shape, success, locale, email, created });
      return await openSession(c, { reference: basket.id, amount: total, currency: 'eur', items, success, cancel, locale, email,
        basket: { id: basket.id, shape, created } });
    } finally { hold?.release(); }
  });
}
// A basket its vouchers pay in full has nothing for the card: it's paid here, without Stripe, as a session of its own
// (sessionOf), settled at once like a paid one.
async function paidByVouchers(c: Caller, basket: string, a: { shape: string; success: string; locale: string; email: string;
  created: (session: string) => void }) {
  const id = `cs_${c.mode}_vouchers_${randomBytes(12).toString('hex')}`, now = stamp();
  atOnce(() => {
    db.prepare(`insert into payments (id, created, product, mode, reference, amount, currency, status, updated, basket, shape, payer, locale)
      values (?, ?, ?, ?, ?, 0, 'eur', 'open', ?, ?, ?, ?, ?)`).run(id, now, FRONT, c.mode, basket, now, basket, a.shape, a.email, a.locale);
    a.created(id);
  });
  const row = db.prepare('select * from payments where id = ?').get(id) as any;
  view(row, await sessionOf(c.mode, id));
  log(`${FRONT}'s ${c.mode} basket ${basket} was paid in full by vouchers.`);
  return { id, url: a.success.replace('{CHECKOUT_SESSION_ID}', id), expires_at: null };
}
// ---- the shop's test code. A code the board picks and types on the desk phone
// (the server key SHOP_TEST_CODE, 12 to 24 letters and digits, long enough for redact() to mask), never in the repo or on
// any page. Typed in the shop's code box (codes.ts), it makes the basket a test order: its checkout costs nothing and is paid nowhere, and its lines are
// cancelled in the same step, so no product ever holds a paid line of it: nothing is printed or sent, no email goes, no
// remedy or refund can be asked, and no product counts it. A leaked code makes test orders only, TESTS_PER_DAY a day in a
// mode, and a wrong guess is refused as any unknown code is (codes.ts).
// TESTS_PER_DAY: the board tries the shop a few times a day. Someone with a leaked code could otherwise make test orders
// without end, each a basket, lines and an order page kept for days.
const TEST_CODE = 'SHOP_TEST_CODE', TESTS_PER_DAY = 10;
// A code as typed, in capitals without spaces or dashes (codes.ts normalCode reads its word and digits from it)
export const squeezedCode = (typed: unknown) => String(typed ?? '').toUpperCase().replace(/[\s-]+/g, '');
export function isTestCode(typed: unknown) {
  const key = squeezedCode(secret(TEST_CODE)), given = squeezedCode(typed);
  if (!/^[A-Z0-9]{12,24}$/.test(key) || !given) return false;
  const hash = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(hash(key), hash(given));
}
// The basket's mark, from inside changeBasket's apply (codes.ts: it takes the place of the basket's code, one or the other)
// (a basket holds one of a code, the test code or a tester's voucher: either mark takes the other's place, and a code put
// in takes both off with markTest(basket, false))
// (its things' steps follow it: countSteps)
export const markTest = (basket: string, on: boolean) => atOnce(() => {
  db.prepare('update baskets set test = ?, tester = null, updated = ? where id = ?').run(on ? 1 : null, stamp(), basket);
  countSteps(basket, 'basket');
});
export const isTestBasket = (basket: string | null | undefined) => !!basket && !!basketRow(basket)?.test;
// A test order: HQ's own session, in the basket's queue, and its lines cancelled with it, as a stall's own unpaid order is
// (its product gives back a voucher on it). Nothing of the payer is kept, no email and no address; the lines' words stay a
// day for the order page (tick), without their stall's order page: it says a cancelled line is no longer in the basket.
// Its lines keep what a real order would have charged, for that page. The session's amount is 0 and no line is paid, so
// nothing counts or refunds it: anything summing session_lines.card skips status = 'test' sessions.
async function paidAsTest(c: Caller, basket: string, charges: Priced[], a: { success: string; locale: string; country: string }) {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const made = db.prepare("select count(*) n from payments where product = ? and mode = ? and status = 'test' and created > ?").get(FRONT, c.mode, since) as { n: number };
  if (made.n >= TESTS_PER_DAY) return [429, `${TESTS_PER_DAY} test orders a day at most, so a leaked code can't flood the shop: try again tomorrow`, 'test_limit'] as Refused;
  const id = `cs_${c.mode}_test_${randomBytes(12).toString('hex')}`, now = stamp();
  atOnce(() => {
    db.prepare(`insert into payments (id, created, product, mode, reference, amount, currency, status, updated, basket, country, locale)
      values (?, ?, ?, ?, ?, 0, 'eur', 'test', ?, ?, ?, ?)`).run(id, now, FRONT, c.mode, basket, now, basket, a.country, a.locale);
    const insert = db.prepare('insert into session_lines (session, line, position, card, saved, code_saved) values (?, ?, ?, ?, ?, ?)');
    charges.forEach((l, i) => insert.run(id, l.line.id, i + 1, l.card, l.saved, l.code_saved));
    for (const { line } of charges) db.prepare("update pay_lines set status = 'cancelled', order_url = null, picture = null, updated = ? where id = ? and status = 'open'").run(now, line.id);
    db.prepare("update baskets set status = 'paid', updated = ? where id = ?").run(now, basket);
    giveNumber(id);
  });
  log(`${FRONT}'s ${c.mode} basket ${basket} was checked out with the shop's test code: a test order, nothing paid or made.`);
  return { id, url: a.success.replace('{CHECKOUT_SESSION_ID}', id), expires_at: null };
}

// ---- a tester's order. The board's tester invite (shares.ts) gives each person a
// voucher that pays one basket on the preview shop up to the board's amount, postage and the shop's own lines included. Typed in the shop's
// code box (codes.ts), in test mode only, it takes the code's place as the test code does. Its checkout is paid here, as a
// basket its vouchers pay in full is, and spends the voucher in the same step. The order is a real one: its stalls make
// it, and its parcel goes to Print API's live environment (parcels.ts printer), to the address the tester typed. Nothing
// is charged: the board settles what Print API bills for it outside the shop. Its parcel's code card prints a code of
// its own that the live shop knows (codes.ts), as a customer's does. Everywhere else it stays a test-mode order (no live
// numbers, no review invitation), and hq orders and Numbers call it a tester's. One whose parcel went without anything
// sent (parcelCancelled) leaves its voucher free to pay a basket again, and isn't counted.
const TESTER_ORDER = /^cs_test_tester_[a-f0-9]{24}$/;
export const isTesterOrder = (session: string | null | undefined) => !!session && TESTER_ORDER.test(session);
// Whether a basket's parcel was cancelled before anything in it was sent (parcels.ts fills this: Print API cancelled its
// order, every thing was taken out, or it could never be placed)
export const parcelCancelled: ((session: string) => boolean)[] = [];
export const sentNothing = (session: string) => parcelCancelled.some(cancelled => cancelled(session));
// The basket's mark, from inside changeBasket's apply (codes.ts), in place of a code or the test code
export const markTester = (basket: string, code: string) => atOnce(() => {
  db.prepare('update baskets set tester = ?, test = null, updated = ? where id = ?').run(code, stamp(), basket);
  countSteps(basket, 'basket');
});
export const testerOf = (basket: string) => basketRow(basket)?.tester ?? null;
// A tester's order whose cancelled parcel goes again by hand (parcels.ts again) takes its voucher back: null once it has,
// else the other order the voucher has paid since.
export function retakeTesterOrder(session: string): string | null {
  const basket = (db.prepare('select basket from payments where id = ?').get(session) as { basket: string | null } | undefined)?.basket;
  const code = basket ? testerOf(basket) : null;
  return code ? testerVoucher.retake?.(code, session) ?? null : null;
}
// What a tester's basket would have cost: every line as its page shows it, delivery included (each line's amount carries
// its own), less a stall's voucher on it
// (a line's copies)
const testerWorth = (lines: { line: Line }[]) => lines.reduce((n, l) => n + l.line.amount * l.line.quantity - (l.line.voucher_value ?? 0), 0);
async function paidByTester(c: Caller, basket: string, code: string, charges: Priced[], a: { success: string; locale: string; email: string;
  deliver: Record<string, string> }) {
  // what it would have cost: one order's most, as a card's (a tester shops as a customer would)
  const worth = testerWorth(charges);
  if (worth > MAX) return [409, `the basket comes to ${euros(worth, 'eur')}, and one order is at most ${euros(MAX, 'eur')}: take something out`, 'card_total_high'] as Refused;
  // (from here to the voucher spent, nothing is awaited)
  if (c.mode !== 'test') return [404, 'no such code', 'code_unknown'] as Refused;
  const refused = testerVoucher.unusable(code);
  if (refused) return refused;
  // and the most its voucher pays, as its invite says now
  const cap = testerVoucher.cap(code);
  if (worth > cap)
    return [409, `the basket comes to ${euros(worth, 'eur')}, and this voucher pays up to ${euros(cap, 'eur')}, delivery included: take something out`,
      'tester_cap', { cap }] as Refused;
  const id = `cs_test_tester_${randomBytes(12).toString('hex')}`, now = stamp();
  atOnce(() => {
    db.prepare(`insert into payments (id, created, product, mode, reference, amount, currency, status, updated, basket, payer, locale, deliver, country)
      values (?, ?, ?, ?, ?, 0, 'eur', 'open', ?, ?, ?, ?, ?, ?)`).run(id, now, FRONT, c.mode, basket, now, basket, a.email, a.locale, JSON.stringify(a.deliver), a.deliver.country);
    const insert = db.prepare('insert into session_lines (session, line, position, card, saved, code_saved) values (?, ?, ?, 0, 0, 0)');
    charges.forEach((l, i) => insert.run(id, l.line.id, i + 1));
    const why = testerVoucher.use(code, id);
    if (why) throw new Error(`the tester's voucher for basket ${basket} could not be spent: ${why[1]}`);
  });
  const row = db.prepare('select * from payments where id = ?').get(id) as any;
  view(row, await sessionOf(c.mode, id));
  log(`${FRONT}'s test basket ${basket} was paid by a tester's voucher: a tester order, made and sent for real.`);
  return { id, url: a.success.replace('{CHECKOUT_SESSION_ID}', id), expires_at: null };
}
// Tester orders per Dutch day from..to, for Numbers (counts only), apart from the customers' baskets. One that sent
// nothing isn't counted: its voucher's next order is the one
export function testerOrders(from: string, to: string) {
  const since = new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS).toISOString();
  const until = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  return (db.prepare(`select id, created from payments where product = ? and mode = 'test' and id like 'cs\\_test\\_tester\\_%' escape '\\'
    and status in ('paid', 'refunded') and created >= ? and created < ?`).all(FRONT, since, until) as { id: string; created: string }[])
    .filter(p => !sentNothing(p.id)).map(p => companyDay(Date.parse(p.created))).filter(day => day >= from && day <= to).length;
}

// All of it or none: a session's row without its basket's lines, or one stored paid with its lines still open, is never
// put right later (tick() reads only open sessions).
// (run answering false undoes it all)
function atOnce(run: () => unknown) {
  db.exec('begin');
  try { db.exec(run() === false ? 'rollback' : 'commit'); } catch (err) { db.exec('rollback'); throw err; }
}

// The delivery address, as Print API takes one: name, line1, postCode, city and country required, 64 characters at most.
function deliverTo(v: any): Record<string, string> | Refused {
  const shape: Refused = [400, 'deliver_to: {name, line1, line2?, postCode, city, country}, each 64 characters at most', 'address_incomplete'];
  if (!v || typeof v !== 'object') return shape;
  const field = (k: string) => text(v[k]);
  const out = { name: field('name'), line1: field('line1'), line2: field('line2'), postCode: field('postCode').toUpperCase(),
    city: field('city'), country: field('country').toUpperCase() };
  if (!out.name || !out.line1 || !out.city || Object.values(out).some(x => x.length > 64)) return shape;
  if (!/^[A-Z0-9][A-Z0-9 -]{0,11}$/.test(out.postCode)) return [400, 'deliver_to.postCode: up to 12 letters, digits, spaces or -', 'postcode_invalid'];
  if (!/^[A-Z]{2}$/.test(out.country)) return [400, 'deliver_to.country: a two-letter country code', 'country_not_delivered'];
  const { line2, ...rest } = out;
  return line2 ? { ...rest, line2 } : rest;
}

async function basketOrder(c: Caller, id: string) {
  const own = await ownSession(c, id);
  if (!own?.row.basket) return [404, 'no such basket order'];
  const v = view(own.row, own.s);
  const lines = paidLines(id);   // as the session charged them, paid or not
  const code = basketCode.shown?.({ session: id }) ?? null;
  // a test order went through as an order, nothing paid: paid and test
  const test = own.row.status === 'test';
  return { session: id, number: orderNumber(id), basket: own.row.basket, paid: v.paid || test, status: v.status, lang: langOf(own.s.locale), country: own.row.country,
    ...summary(lines.map(line => ({ line, card: line.card!, saved: line.saved!, code_saved: line.code_saved ?? 0 })), code, test, test ? own.row.created : null,
      isTesterOrder(id)) };
}

// ---- reading a basket's session, ending one, and what its payment settles
export async function readSession(row: any) {   // exported:
  try { return view(row, await sessionOf(row.mode, row.id)); }
  catch (err) {
    if (!(err instanceof StripeError && err.status === 404)) throw err;   // gone at Stripe: it can't be paid
    db.prepare("update payments set status = 'expired', updated = ? where id = ?").run(stamp(), row.id);
    return null;
  }
}
// Ends an open session before its basket changes: true once it can't be paid, else why the change can't go ahead.
async function endSession(row: any): Promise<true | Refused> {
  let s;
  try { s = await stripe(row.mode, 'POST', `/v1/checkout/sessions/${row.id}/expire`); }
  catch (err) {
    if (!(err instanceof StripeError) || (err.status !== 400 && err.status !== 404)) throw err;
    if (err.status === 404) { db.prepare("update payments set status = 'expired', updated = ? where id = ?").run(stamp(), row.id); return true; }
    s = await sessionOf(row.mode, row.id);   // not open any more: paid, or expired meanwhile
  }
  const v = view(row, s);
  if (v.paid) return [409, 'this order is already paid', 'already_paid'];
  if (sessionState(s) === 'processing') return [409, 'the payment for this basket is still being processed', 'payment_processing'];
  return true;
}
// A basket's session turned paid: its lines are paid at the amounts it charged, and the basket is closed.
function settle(row: any) {
  const now = stamp();
  for (const charged of db.prepare('select * from session_lines where session = ?').all(row.id) as any[]) {
    const done = db.prepare("update pay_lines set status = 'paid', session = ?, card = ?, saved = ?, code_saved = ?, paid_at = ?, updated = ? where id = ? and status = 'open'")
      .run(row.id, charged.card, charged.saved, charged.code_saved, now, now, charged.line).changes;   // code_saved:
    if (!done && lineRow(charged.line)?.session !== row.id)
      log(`NEEDS A PERSON: basket ${row.reference} was paid (${row.mode}) with line ${charged.line} in it, which was no longer open. Look before anything is made or refunded.`);
  }
  db.prepare("update baskets set status = 'paid', updated = ? where id = ?").run(now, row.basket);
  giveNumber(row.id);
  basketCode.paid?.(row);
}
// Once that's stored: the hooks hear it, with the lines as paid.
function tellPaid(row: any, s: any) {
  const lines = paidLines(row.id);
  for (const hook of basketPaid) {
    try { hook(row, s, lines); } catch (err) { console.error('Payments: a basket-paid hook failed:', err instanceof Error ? err.message : err); }
  }
}

// Every 2 minutes: open basket sessions are read, so a payment settles its lines even when nobody is looking; and what
// the privacy pages promise to delete goes (house rule 7):
// - a delivery address 14 days after the payment, or once its parcel can't be placed again if that's later (at most 30
//   days after), refunded or not; a day after a session ended unpaid; and once no parcel needs it when its customer
//   asked (forgetLine);
// - the payer's email of a basket paid by vouchers 90 days after its order;
// - a line's description, detail and order page (what the customer made, and the key to it) 90 days after it was paid,
//   or after its making if it was never paid: a cancel changes no clock (DECISIONS, 2026-10-14). While its customer
//   keeps it (kept_until, history.ts), not before that time, and at the next tick after it. A line nobody paid
//   within a day of its making is cancelled, as its product's own unpaid order is then too. Its price and reference
//   stay, for the books;
// - a basket nobody paid for, the days the front's manifest names after its start;
// - the log's payment lines (an order's reference, its amount, which emails went), 90 days after they were written
// The one parcel's tick (parcels.ts) deletes the print files of a parcel never placed once its address goes here.
export async function tick(now = Date.now()) {
  const open = db.prepare("select * from payments where basket is not null and status in ('open', 'complete')").all() as any[];
  for (const row of open) {
    try { await readSession(row); } catch (err) { console.error(`Payments: could not read basket ${row.reference}'s session:`, err instanceof Error ? err.message : err); }
  }
  const dayAgo = new Date(now - DAY_MS).toISOString(), longAgo = new Date(now - 90 * DAY_MS).toISOString();

  db.prepare("update payments set deliver = null where deliver is not null and status not in ('open', 'complete', 'paid', 'refunded') and updated < ?").run(dayAgo);
  // paid, refunded or not: 14 days after, or later while its parcel may still be placed again (at most 30 days after)
  const paidBefore = (days: number) => new Date(now - days * DAY_MS).toISOString();
  for (const paid of db.prepare("select id, updated, forget_asked from payments where deliver is not null and status in ('paid', 'refunded') and updated < ?").all(paidBefore(14)) as any[])
    if (paid.updated < paidBefore(30) || !keepAddress.some(keep => keep(paid.id))) {
      db.prepare('update payments set deliver = null where id = ?').run(paid.id);
      // a basket whose customer asked while its parcel held the address: the imitation's copy of the email goes with it
      if (paid.forget_asked) forgetImitationEmail(paid.id);
    }
  forgetAskedAddresses();
  db.prepare('update payments set payer = null where payer is not null and created < ?').run(longAgo);
  db.prepare("delete from events where type = 'log' and text like 'Payments: %' and ts < ?").run(longAgo);
  for (const unpaid of db.prepare("select * from pay_lines where status = 'open' and created < ?").all(dayAgo) as Line[])
    await expireLine(unpaid);
  // (detail; kept_until)
  db.prepare(`update pay_lines set description = '', detail = null, order_url = null, picture = null
    where (description != '' or detail is not null or order_url is not null or picture is not null)
    and ((status = 'paid' and paid_at < ?) or (status != 'paid' and created < ?)) and (kept_until is null or kept_until <= ?)`)
    .run(longAgo, longAgo, new Date(now).toISOString());
  forgetHeldWords(longAgo);
  // a test order's lines a day after it, once its order page has shown them
  db.prepare(`update pay_lines set description = '', detail = null where (description != '' or detail is not null)
    and status = 'cancelled' and id in (select sl.line from session_lines sl join payments p on p.id = sl.session where p.status = 'test' and p.created < ?)`).run(dayAgo);
  await forgetOldBaskets(now);
}
// In its basket's queue, and not while a session over it is open: the customer may be paying it right now (Stripe ends
// a session within a day, so the next tick after that takes it).
const expireLine = (known: Line) => serial(known.basket ? basketKey(known.mode, known.basket) : `line:${known.id}`, async () => {
  const line = lineRow(known.id)!;
  if (line.status !== 'open' || line.basket !== known.basket || (line.basket && openSessionOf(line.basket, line.mode))) return;
  cancel(line.id);
});
// A basket nobody paid for within its days (basketRules) is deleted with everything in it (the privacy pages), as the
// shop's cookie naming it runs out: its lines still open are cancelled and leave it. In its queue, and not while a session
// over it is open or its payment still being processed.
async function forgetOldBaskets(now: number) {
  const started = new Date(now - basketRules().days * DAY_MS).toISOString();
  for (const old of db.prepare("select id, mode from baskets where status = 'open' and created < ?").all(started) as { id: string; mode: string }[])
    await serial(basketKey(old.mode, old.id), async () => {
      if (basketRow(old.id)?.status !== 'open' || openSessionOf(old.id, old.mode)) return;
      atOnce(() => {
        for (const line of basketLines(old.id)) cancel(line.id);
        db.prepare('update pay_lines set basket = null, position = null where basket = ?').run(old.id);
        db.prepare('delete from baskets where id = ?').run(old.id);
      });
    });
}
export const start = () => { setInterval(() => tick().catch(err => console.error('Payments: the basket check failed:', err)), 2 * 60_000); };

export const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
// A refusal as the caller gets it: the reason, its why, and what the why's words need
export const refusal = (res: ServerResponse, [status, error, why, needs]: Refused) =>
  json(res, status, { error, ...(why ? { why } : {}), ...needs });
// The shop's own server as a company's route's caller, or the refusal; and a route's answer, a refusal or its json
export function shopCaller(req: IncomingMessage): Caller | Refused {
  const c = caller(req);
  return Array.isArray(c) || c.slug === FRONT ? c : [403, 'the shop only'];
}
export const reply = (res: ServerResponse, r: unknown) => Array.isArray(r) ? refusal(res, r as Refused) : json(res, 200, r);
// A product request's body at most: a route that takes more passes its own.
export const BODY_BYTES = 8192;
// A product server's request: its caller, and its body (a POST's JSON, else the query's fields). post: a route that
// takes only POST. limit: BODY_BYTES unless it says. Answers a refusal itself, and returns null then.
export async function productRequest(req: IncomingMessage, res: ServerResponse, { post = false, limit = BODY_BYTES } = {}) {
  const c = caller(req);
  if (Array.isArray(c) || (post && req.method !== 'POST')) {
    req.resume();
    const [status, error] = Array.isArray(c) ? c : [405, 'POST'];
    json(res, status, { error });
    return null;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const body = req.method === 'POST' ? await readJsonBody(req, limit) : Object.fromEntries(url.searchParams);
  if (!body || typeof body !== 'object') {
    json(res, 400, { error: 'json body' });
    return null;
  }
  return { caller: c, body };
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x'), route = `${req.method} ${url.pathname}`;
  const asked = await productRequest(req, res);
  if (!asked) return;
  const { caller: c, body: b } = asked;
  try {
    const r = route === 'POST /api/pay/checkout' ? await checkout(c, b)
      : route === 'GET /api/pay/session' ? await session(c, String(b.id ?? ''))
      : route === 'POST /api/pay/expire' ? await expire(c, String(b.id ?? ''))
      : route === 'POST /api/pay/expire/open' ? await expireOpen(c)
      : route === 'POST /api/pay/refund' ? await refund(c, String(b.id ?? ''))
      : route === 'POST /api/pay/retire' ? await retire(c, b)
      : route === 'GET /api/pay/methods' ? { methods: methods(c.slug) }
      : route === 'GET /api/pay/ready' ? await ready(c)
      : route === 'POST /api/pay/payer' ? await matchPayer(c, b)
      : route === 'POST /api/pay/payer/sessions' ? await listPayerSessions(c, b)
      : route === 'POST /api/pay/line' ? await registerLine(c, b)
      : route === 'GET /api/pay/line' ? await getLine(c, String(b.id ?? ''))
      : route === 'POST /api/pay/line/cancel' ? await cancelLine(c, String(b.id ?? ''))
      : route === 'POST /api/pay/line/refund' ? await refundLine(c, String(b.id ?? ''))
      : route === 'POST /api/pay/line/forget' ? await forgetLine(c, String(b.id ?? ''))
      : url.pathname.startsWith('/api/pay/basket') && c.slug !== FRONT ? [403, "baskets are the shop's (the front's)"]
      : route === 'POST /api/pay/basket/add' ? await addToBasket(c, b)
      : route === 'POST /api/pay/basket/remove' ? await removeFromBasket(c, b)
      : route === 'POST /api/pay/basket/quantity' ? await setQuantity(c, b)
      : route === 'GET /api/pay/basket' ? (ownBasket(c, b.id) ? await basketView(c, String(b.id), b.country) : [404, 'no such basket', 'basket_gone'])
      : route === 'POST /api/pay/basket/checkout' ? await checkoutBasket(c, b)
      : route === 'GET /api/pay/basket/order' ? await basketOrder(c, String(b.id ?? ''))
      : [404, 'not found'];
    return reply(res, r);
  } catch (err) {
    if (err instanceof StripeError) return json(res, err.status, { error: err.message });
    throw err;
  }
}

// ---- The imitation: Stripe's Checkout, sessions, refunds and monthly subscriptions with the same shapes and rules, for
// test mode until the board has entered a test key (and for the tests). Its payment page is on HQ (/pay/imitation/<id>)
// and says plainly that no money moves.
type Fake = Record<string, any>;
// Its sessions and refunds outlive a restart, as Stripe's do: an order paid before a deploy is still paid after it, so
// it can be refunded and its emails sent (a company test purchase withdrawn during a deploy came back unavailable).
// What it holds of an order goes when HQ retires the order or the order's records end (forgetImitation), and a session's
// payer email when its customer's deletion request takes the basket's (forgetImitationEmail). Its idempotency keys last
// one run.
db.exec('create table if not exists imitation_records (kind text not null, id text not null, record text not null, primary key (kind, id))');
const kept = (kind: 'session' | 'refund') => ({
  get: (id: string): Fake | undefined => {
    const row = db.prepare('select record from imitation_records where kind = ? and id = ?').get(kind, id) as { record: string } | undefined;
    return row && JSON.parse(row.record);
  },
  // (an upsert keeps the record's rowid, so the lists stay in the order the records were made)
  set: (record: Fake) => db.prepare(`insert into imitation_records (kind, id, record) values (?, ?, ?)
    on conflict (kind, id) do update set record = excluded.record`).run(kind, record.id, JSON.stringify(record)),
  values: () => (db.prepare('select record from imitation_records where kind = ? order by rowid').all(kind) as { record: string }[])
    .map(row => JSON.parse(row.record) as Fake),
  ofIntent: (pi: string | null) => (db.prepare("select record from imitation_records where kind = ? and json_extract(record, '$.payment_intent') = ? order by rowid")
    .all(kind, pi) as { record: string }[]).map(row => JSON.parse(row.record) as Fake),
});
const fake = { sessions: kept('session'), refunds: kept('refund'), keys: new Map<string, { asked: string; out: Fake }>() };
function forgetImitation(sessions: string[]) {
  for (const id of sessions) {
    const pi = fake.sessions.get(id)?.payment_intent;
    if (pi) db.prepare("delete from imitation_records where kind = 'refund' and json_extract(record, '$.payment_intent') = ?").run(pi);
    db.prepare("delete from imitation_records where kind = 'session' and id = ?").run(id);
  }
}
recordsEnded.push(session => forgetImitation([session]));
// the payment state stays, for the books
function forgetImitationEmail(session: string) {
  const s = fake.sessions.get(session);
  if (!s) return;
  s.customer_email = null;
  if (s.customer_details) s.customer_details.email = null;
  fake.sessions.set(s);
}
// an open session past its time is expired, as Stripe reads it
function expiring(s: Fake, now: number) {
  if (s.status !== 'open' || s.expires_at >= now) return;
  s.status = 'expired';
  fake.sessions.set(s);
}
// Its subscriptions outlive a restart, as Stripe's do: a held plan reads its own after one, to see it renewed or ended.
db.exec('create table if not exists imitation_subscriptions (id text primary key, sub text not null)');
const fakeSubscription = (id: string): Fake | undefined => {
  const row = db.prepare('select sub from imitation_subscriptions where id = ?').get(id) as { sub: string } | undefined;
  return row && JSON.parse(row.sub);
};
const keepSubscription = (sub: Fake) => db.prepare('insert or replace into imitation_subscriptions (id, sub) values (?, ?)').run(sub.id, JSON.stringify(sub));
const fakeId = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
const fail = (status: number, message: string): never => { throw new StripeError(status, `Stripe: ${message}`); };
// what the imitation's dashboard has on, as Stripe's test account had by itself on 2026-10-08 (and iDEAL)
const DASHBOARD = ['card', 'ideal', 'bancontact', 'eps', 'klarna', 'link', 'mb_way', 'amazon_pay', 'satispay'];

// One page of a list, newest first, as Stripe pages it: limit (10 unless asked) after starting_after's item
function listPage(q: URLSearchParams, items: Fake[]): Fake {
  const limit = Number(q.get('limit') ?? 10), after = q.get('starting_after');
  const start = after ? items.findIndex(x => x.id === after) + 1 : 0;
  return { object: 'list', has_more: items.length > start + limit, data: items.slice(start, start + limit) };
}

// A session's payment as Stripe has it: settled when charged, a held one (capture manual) until HQ charges or releases it.
// Its charge carries the card's issuing country, or Link's funding country for a Link payment.
function intentOf(s: Fake): Fake {
  const status = s.intent_status ?? 'succeeded', charged = status === 'succeeded';
  const method = s.method ?? 'card';
  // Stripe's standard EEA card price: 1.5% + €0.25
  const fee = Math.round(s.amount_total * 0.015) + 25;
  // amount_received: what a retirement weighs refunds against
  return { id: s.payment_intent, object: 'payment_intent', amount: s.amount_total, amount_received: charged ? s.amount_total : 0, currency: s.currency, status,
    latest_charge: { id: `ch_${s.payment_intent.slice(3)}`, object: 'charge', captured: charged,
      payment_method_details: { type: method, [method]: { country: s.card_country } },
      balance_transaction: charged ? { object: 'balance_transaction', amount: s.amount_total, currency: s.currency, fee, net: s.amount_total - fee } : null } };
}

export function imitation(method: string, path: string, p: URLSearchParams, idempotency?: string): Fake {
  // as Stripe: a key answers the same again, and only for the same request
  const asked = `${method} ${path} ${p}`, known = idempotency ? fake.keys.get(idempotency) : undefined;
  if (known && known.asked !== asked) fail(400, `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${idempotency}' if you meant to execute a different request.`);
  if (known) return structuredClone(known.out);
  const now = Math.floor(Date.now() / 1000), m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/);
  const hold = method === 'POST' ? path.match(/^\/v1\/payment_intents\/([^/]+)\/(capture|cancel)$/) : null;
  const subscription = path.match(/^\/v1\/subscriptions\/([^/?]+)$/);
  let out: Fake;
  if (method === 'POST' && path === '/v1/checkout/sessions') {
    for (const k of ['mode', 'success_url', 'cancel_url', 'line_items[0][quantity]', 'line_items[0][price_data][currency]',
      'line_items[0][price_data][unit_amount]', 'line_items[0][price_data][product_data][name]'])
      if (!p.get(k)) fail(400, `Missing required param: ${k}.`);
    const expires = Number(p.get('expires_at') ?? now + 86400);
    if (expires < now + 1800 || expires > now + 86400) fail(400, 'expires_at must be between 30 minutes and 24 hours from now.');
    const mode = p.get('mode')!;
    if (mode !== 'payment' && mode !== 'subscription') fail(400, `Invalid mode: must be one of payment, setup, or subscription`);
    if (mode === 'subscription' && [...p.keys()].some(k => k.startsWith('payment_intent_data['))) fail(400, 'You can not pass `payment_intent_data` in `subscription` mode.');
    const id = fakeId('cs_test'), meta: Fake = {}, excluded: string[] = [];
    for (const [k, v] of p) {
      const mk = k.match(/^metadata\[(.+)\]$/); if (mk) meta[mk[1]] = v;
      // as Stripe since 2026: no list of methods, only ones to leave out of the dashboard's
      if (k.startsWith('payment_method_types[')) fail(400, 'The `payment_method_types` parameter is no longer supported when creating a Checkout Session.');
      if (k.startsWith('excluded_payment_method_types[')) {
        if (!EXCLUDABLE.includes(v)) fail(400, `Invalid ${k}: must be one of ${EXCLUDABLE.slice(0, -1).join(', ')}, or ${EXCLUDABLE.at(-1)}`);
        excluded.push(v);
      }
    }
    // every line item, as a basket sends several; a subscription's recur every month
    const items: { name: string; amount: number }[] = [];
    let recurring = 0;
    for (let i = 0; p.has(`line_items[${i}][quantity]`); i++) {
      const unit = Number(p.get(`line_items[${i}][price_data][unit_amount]`)), quantity = Number(p.get(`line_items[${i}][quantity]`));
      if (!Number.isInteger(unit) || unit < 0 || !Number.isInteger(quantity) || quantity < 1) fail(400, `Invalid line_items[${i}].`);
      const interval = p.get(`line_items[${i}][price_data][recurring][interval]`);
      if (interval && interval !== 'month') fail(400, `Invalid line_items[${i}][price_data][recurring][interval]: the imitation recurs by the month only`);
      if (interval) recurring++;
      items.push({ name: String(p.get(`line_items[${i}][price_data][product_data][name]`) ?? ''), amount: unit * quantity });
    }
    if (mode === 'payment' && recurring) fail(400, 'You must be in subscription mode to specify recurring prices.');
    if (mode === 'subscription' && !recurring) fail(400, 'You must specify at least one recurring price in `subscription` mode when using prices.');
    const subscribed: Fake = {};
    for (const [k, v] of p) { const mk = k.match(/^subscription_data\[metadata\]\[(.+)\]$/); if (mk) subscribed[mk[1]] = v; }
    out = { id, object: 'checkout.session', created: now, mode, livemode: false, subscription: null, subscribed, status: 'open', payment_status: 'unpaid',
      amount_total: items.reduce((n, item) => n + item.amount, 0),
      currency: p.get('line_items[0][price_data][currency]'), client_reference_id: p.get('client_reference_id'), metadata: meta,
      success_url: p.get('success_url'), cancel_url: p.get('cancel_url'), expires_at: expires, payment_intent: null,
      name: items[0].name, items, url: `${ORIGIN}/pay/imitation/${id}`,
      payment_method_types: DASHBOARD.filter(m => !excluded.includes(m)), locale: p.get('locale'), customer_email: p.get('customer_email'),
      capture: p.get('payment_intent_data[capture_method]') ?? 'automatic', billing: p.get('billing_address_collection') ?? 'auto' };
    fake.sessions.set(out);
  } else if (m) {
    const s = fake.sessions.get(m[1]) ?? fail(404, `No such checkout.session: '${m[1]}'`);
    expiring(s, now);
    if (method === 'POST' && m[2]) {
      if (s.status !== 'open') fail(400, 'Only Checkout Sessions with a status of open can be expired.');
      s.status = 'expired';
      fake.sessions.set(s);
    } else if (method !== 'GET') fail(404, 'Unrecognized request URL.');
    out = s;
  } else if (method === 'GET' && path.startsWith('/v1/checkout/sessions?')) {   // sessions by the payer's email, or made between two times (created): newest first, a page at a time
    const q = new URLSearchParams(path.split('?')[1]), email = q.get('customer_details[email]'), status = q.get('status');
    const from = Number(q.get('created[gte]') ?? 0), to = Number(q.get('created[lte]') ?? Infinity);
    const sessions = fake.sessions.values();
    for (const x of sessions) expiring(x, now);
    out = listPage(q, sessions.reverse().filter(x => (!email || x.customer_details?.email === email)
      && (!status || x.status === status) && x.created >= from && x.created <= to));
  } else if (hold) {   // a held payment, charged or let go
    const [, pi, decision] = hold;
    const s = fake.sessions.ofIntent(pi)[0] ?? fail(404, `No such payment_intent: '${pi}'`);
    if (s.intent_status !== 'requires_capture') fail(400, `This PaymentIntent could not be ${decision === 'capture' ? 'captured' : 'canceled'} because it has a status of ${s.intent_status ?? 'succeeded'}.`);
    s.intent_status = decision === 'capture' ? 'succeeded' : 'canceled';
    fake.sessions.set(s);
    out = intentOf(s);
  } else if (subscription) {   // a monthly subscription, as its time has moved on; stopping it at its period's end; ending it now
    const sub = fakeSubscription(subscription[1]) ?? fail(404, `No such subscription: '${subscription[1]}'`);
    renew(sub, now);
    if (method === 'POST') {
      if (sub.status === 'canceled') fail(400, 'A canceled subscription can only update its cancellation_details and metadata.');
      if (p.has('cancel_at_period_end')) sub.cancel_at_period_end = p.get('cancel_at_period_end') === 'true';
    } else if (method === 'DELETE') {
      if (sub.status !== 'canceled') Object.assign(sub, { status: 'canceled', canceled_at: now, ended_at: now });
    } else if (method !== 'GET') fail(404, 'Unrecognized request URL.');
    keepSubscription(sub);
    out = sub;
  } else if (method === 'GET' && path.startsWith('/v1/payment_intents/')) {   // a payment and its charge's settlement
    const pi = decodeURIComponent(path.slice('/v1/payment_intents/'.length).split('?')[0]);
    const s = fake.sessions.ofIntent(pi)[0] ?? fail(404, `No such payment_intent: '${pi}'`);
    out = intentOf(s);
  } else if (method === 'GET' && path.startsWith('/v1/refunds?')) {   // a payment's refunds
    const q = new URLSearchParams(path.split('?')[1]), pi = q.get('payment_intent');
    out = listPage(q, fake.refunds.ofIntent(pi).reverse());
  } else if (method === 'GET' && path.startsWith('/v1/refunds/')) {
    const id = decodeURIComponent(path.slice('/v1/refunds/'.length));
    out = fake.refunds.get(id) ?? fail(404, `No such refund: '${id}'`);
  } else if (method === 'POST' && path === '/v1/refunds') {
    const pi = p.get('payment_intent'), s = fake.sessions.ofIntent(pi)[0] ?? fail(404, `No such payment_intent: '${pi}'`);
    const refunded = fake.refunds.ofIntent(pi).filter(r => r.status !== 'failed' && r.status !== 'canceled').reduce((n, r) => n + r.amount, 0);
    const amount = p.has('amount') ? Number(p.get('amount')) : s.amount_total - refunded;   // a part, as Stripe takes it
    if (refunded >= s.amount_total) fail(400, 'Charge has already been refunded.');
    if (!Number.isInteger(amount) || amount < 1 || refunded + amount > s.amount_total) fail(400, 'Refund amount is greater than unrefunded amount on charge.');
    const meta: Fake = {};
    for (const [k, v] of p) { const mk = k.match(/^metadata\[(.+)\]$/); if (mk) meta[mk[1]] = v; }
    out = { id: fakeId('re_test'), object: 'refund', amount, currency: s.currency, payment_intent: pi, status: 'succeeded', metadata: meta };
    fake.refunds.set(out);
  } else return fail(404, 'Unrecognized request URL.');
  if (idempotency) fake.keys.set(idempotency, { asked, out: structuredClone(out) });
  return structuredClone(out);
}

// A subscription as Stripe has it once time has passed: each period that ended was paid again, unless it was to stop at
// its period's end, which it then did. One whose card declines its renewals falls past due at its next period, and Stripe
// keeps trying to charge it. Its period is on its item (Stripe's API since 2025-03-31).
function renew(sub: Fake, now: number) {
  const item = sub.items.data[0];
  const anchor = new Date(sub.start_date * 1000);
  while (sub.status === 'active' && item.current_period_end <= now) {
    if (sub.cancel_at_period_end) Object.assign(sub, { status: 'canceled', canceled_at: item.current_period_end, ended_at: item.current_period_end });
    else {
      const end = new Date(item.current_period_end * 1000);
      const months = (end.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + end.getUTCMonth() - anchor.getUTCMonth() + 1;
      Object.assign(item, { current_period_start: item.current_period_end, current_period_end: Math.floor(pricing.addMonths(sub.start_date * 1000, months) / 1000) });
      if (sub.declines) sub.status = 'past_due';
    }
  }
}
function subscribe(s: Fake, now: number, declines: boolean) {
  const sub = { id: fakeId('sub'), object: 'subscription', status: 'active', livemode: false, cancel_at_period_end: false, start_date: now, declines,
    metadata: s.subscribed, items: { object: 'list', data: [{ id: fakeId('si'), object: 'subscription_item', current_period_start: now,
      current_period_end: Math.floor(pricing.addMonths(now * 1000, 1) / 1000) }] } };
  keepSubscription(sub);
  return sub.id;
}
// The imitation's payment page: GET shows it, POST pays (test) and returns to the product. Like Stripe's, it offers the
// session's methods, in its language (auto: the browser's), with the email the shop gave already filled in and fixed.
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const WORDS: Record<string, Record<string, string>> = {
  en: { title: 'Test checkout', note: 'No money moves: this stands in for Stripe until the real test account is connected.',
    with: 'Pay with', card: 'Card', email: 'Email', pay: 'Pay (test)', back: 'Go back', closed: "This checkout can't be paid any more.",
    country: 'Billing country', cardCountry: 'Card issued in', month: 'a month' },
  nl: { title: 'Testbetaling', note: 'Er gaat geen geld over: dit staat in voor Stripe tot het echte testaccount gekoppeld is.',
    with: 'Betalen met', card: 'Kaart', email: 'E-mail', pay: 'Betalen (test)', back: 'Terug', closed: 'Deze betaling kan niet meer.',
    country: 'Factuurland', cardCountry: 'Kaart uitgegeven in', month: 'per maand' },
  de: { title: 'Testzahlung', note: 'Es fließt kein Geld: Das steht für Stripe, bis das echte Testkonto verbunden ist.',
    with: 'Bezahlen mit', card: 'Karte', email: 'E-Mail', pay: 'Bezahlen (Test)', back: 'Zurück', closed: 'Diese Zahlung ist nicht mehr möglich.',
    country: 'Rechnungsland', cardCountry: 'Karte ausgegeben in', month: 'pro Monat' },
};
// (link)
const METHOD_NAMES: Record<string, string> = { ideal: 'iDEAL | Wero', bancontact: 'Bancontact', eps: 'EPS', wero: 'Wero', link: 'Link' };
function words(locale: unknown, req: IncomingMessage) {
  const lang = (typeof locale === 'string' && locale !== 'auto' ? locale : String(req.headers['accept-language'] ?? '')).slice(0, 2).toLowerCase();
  return { lang: WORDS[lang] ? lang : 'en', w: WORDS[lang] ?? WORDS.en };
}
// The page's POST: pays (test) and returns to the product
async function payImitation(req: IncomingMessage, res: ServerResponse, id: string) {
  if (req.headers.origin !== ORIGIN) { res.writeHead(403); return res.end(); }
  // the payer's address, as Stripe's checkout asks for it (the shop's, when it gave one): the form's field, read here
  // (so this handler is async)
  let raw = ''; for await (const chunk of req) if ((raw += chunk).length > 2048) break;
  const form = new URLSearchParams(raw);
  // the session as it is now, read again after the form's wait: another request may have expired or retired it meanwhile.
  // From here to its upsert nothing waits.
  const s = fake.sessions.get(id);
  if (!s) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('No such test checkout.'); }
  expiring(s, Date.now() / 1000);
  const email = s.customer_email || form.get('email')?.trim() || 'test-customer@example.com';
  // the billing country, as Stripe's card form asks for it: NL unless the form names another; the card's issuing
  // country, the billing country unless the form names another
  const country = /^[A-Z]{2}$/.test(form.get('country') ?? '') ? form.get('country') : 'NL';
  const cardCountry = /^[A-Z]{2}$/.test(form.get('card_country') ?? '') ? form.get('card_country') : country;
  // a held payment (capture manual) stays unpaid until it's charged, and one by a delayed method (sepa_debit) until it
  // settles, which here it never does; a subscription's first month is paid through its subscription, with no payment
  // of the session's own (renewals=decline: a card whose later charges are declined, as Stripe's test clocks show it).
  // (sepa_debit and renewals)
  const held = s.capture === 'manual', delayed = form.get('method') === 'sepa_debit', monthly = s.mode === 'subscription';
  if (s.status === 'open') fake.sessions.set(Object.assign(s, { status: 'complete', payment_status: held || delayed ? 'unpaid' : 'paid', payment_intent: monthly ? null : fakeId('pi_test'),
    subscription: monthly ? subscribe(s, Math.floor(Date.now() / 1000), form.get('renewals') === 'decline') : null,
    intent_status: held ? 'requires_capture' : delayed ? 'processing' : 'succeeded', method: form.get('method') ?? 'card', card_country: cardCountry, customer_details: { email, address: { country } } }));
  if (s.status !== 'complete') { res.writeHead(409, { 'content-type': 'text/plain' }); return res.end('This checkout has expired.'); }
  res.writeHead(303, { location: s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id) });
  return res.end();
}
export async function imitationPage(req: IncomingMessage, res: ServerResponse) {
  const [, id, action] = new URL(req.url ?? '/', 'http://x').pathname.match(/^\/pay\/imitation\/([A-Za-z0-9_]{1,80})(\/pay)?$/) ?? [];
  const s = id ? fake.sessions.get(id) : undefined;
  if (s) expiring(s, Date.now() / 1000);
  if (!s) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('No such test checkout.'); }
  if (action && req.method === 'POST') return payImitation(req, res, id);
  const { lang, w } = words(s.locale, req);
  const choices = s.payment_method_types.map((m: string, i: number) =>
    `<label class="m"><input type="radio" name="method" value="${esc(m)}"${i ? '' : ' checked'}> ${esc(m === 'card' ? w.card : METHOD_NAMES[m] ?? m)}</label>`).join('');
  const email = s.customer_email ? `value="${esc(s.customer_email)}" readonly` : 'value="test-customer@example.com"';
  // a territory's sale asks for the billing country, and a tester names the card's too
  const countries = s.billing !== 'required' ? '' : [['country', w.country], ['card_country', w.cardCountry]]
    .map(([name, label]) => `<p><label>${esc(label)} <input name="${name}" value="NL" size="2" maxlength="2" pattern="[A-Z]{2}" required></label></p>`).join('');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html lang="${lang}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(w.title)}</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1.2rem;color:#222}
.box{border:2px dashed #b9a;border-radius:14px;padding:1.4rem}.amt{font-size:2rem;font-weight:700}
fieldset{border:0;padding:0;margin:0 0 1rem}.m{display:block;padding:.45rem 0}input[readonly]{background:#f3f0ea;border:1px solid #ccc}
button{font:inherit;font-weight:600;padding:.7rem 1.3rem;border-radius:10px;border:0;background:#2f6f4f;color:#fff;cursor:pointer}
a{color:#555}</style>
<div class="box"><p><b>${esc(w.title)}.</b> ${esc(w.note)}</p>
${(s.items ?? [{ name: s.name, amount: s.amount_total }]).map((item: Fake) => `<p>${esc(item.name)}${s.items?.length > 1 ? ` · ${esc(euros(item.amount, s.currency))}` : ''}</p>`).join('')}<p class="amt">${esc(euros(s.amount_total, s.currency))}${s.mode === 'subscription' ? ` <small>${esc(w.month)}</small>` : ''}</p>
${s.status === 'open' ? `<form method="post" action="/pay/imitation/${esc(s.id)}/pay"><fieldset><legend>${esc(w.with)}</legend>${choices}</fieldset>
<p><label>${esc(w.email)} <input name="email" type="email" ${email}></label></p>${countries}<button>${esc(w.pay)}</button></form>` : `<p>${esc(w.closed)}</p>`}
<p><a href="${esc(s.cancel_url)}">${esc(w.back)}</a></p></div>`);
}
