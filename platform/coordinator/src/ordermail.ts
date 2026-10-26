// Order emails: a product's own email about one of its own paid orders ("paid", "shipped"), to the address the order was
// paid with.
//
//   POST /api/pay/email {order, kind, lang, slots: {ref, name, date, total, vat, vat_rate, link, site, tracking, carrier, list,
//                        facts}, email?, delivery?}
//     → {order, kind, delivery?, status: sent | sending | unsure | refused, test_email?: {to, subject, text, attachments?}}
//     sending: a send interrupted by an HQ restart, not yet counted as lost. Requests for one order wait their turn
//     (email()). unsure or refused: delivery remains unconfirmed after every try (logged).
//   A refusal → {error, why?}. why tells a refusal apart from another with its status. It is only ever delivery_quota: a 429 for a new delivery past its caps (below). Any other 429 is
//   Stripe's, passed on: nothing about the delivery changed, so the same delivery may ask again.
// Same headers and token as the rest of /api/pay (payments.ts). order: the reference the product's checkout used.
//
// - The address is Stripe's: the payer's on the order's own paid Checkout Session (for an order that is a line of a
//   basket, the basket's), never one the product names. An order
//   paid in full some other way (a company's voucher, say) names the payment that paid for it through `paidOtherwise`.
//   That payment's address may be someone else's (a voucher can be passed on), so it's used only when it's the one the
//   customer gave the product (`email`). Otherwise nothing goes, and the customer has the order page.
// - The words are the product's own, reviewable in the repo: products/<slug>/care/order-emails.yaml, the kind as the key,
//   then the language, each with a subject and a body. The body may be a list of text blocks joined by blank lines.
//   The product fills only the slots below, and HQ checks each one,
//   so a product can't mail arbitrary text. A slot the text doesn't use is ignored; one it uses must be there, and a
//   {word} that isn't a slot is refused rather than mailed as it stands. Only tracking can point off the product's own
//   address (any https URL: carriers' hosts vary too much to list), so a product's bug could put a stray link there.
// - An order's facts (slots.facts: {edition: 'edition-2', seller_name: '…'}) are what the customer bought as it was sold:
//   the words name one as {fact:edition}. A product keeps them with the order when it's sold and sends those, never what
//   its settings say now, so a later change of terms, offer or seller never rewrites an earlier purchase's email. The words
//   say what's the same for every order, and a kind carries its words' version for that. A fact is plain text with no
//   link in it (links go in {link} and {site}), so the email's links stay the product's own.
// - <<…>> in the words is the door's "not final yet" mark: what isn't known when they're written (the company's address,
//   say). Live mode refuses a kind and language whose subject or body still holds one (409, and a person is told once)
//   without counting a try, so once the words are filled in on main the next ask sends it. Test mode renders it as it
//   stands, so the preview shows the gap. A fact holding one is held back the same way.
// - Files that go with it (the law's own notice, the terms as they stood) are the product's too, named beside the words
//: `attachments:` maps the name the customer sees to a file in
//   products/<slug>/, a PDF, PNG or JPEG (a phone's mail app opens those; an SVG it often doesn't). HQ attaches exactly
//   those, never a file the product sends, and refuses the email while one is missing, so it never goes without them.
//   Test mode renders their names back.
// - Once per order and kind. Asking again answers how it went and never sends a second copy. An email the service
//   refused is sent again on the next ask. One that may have gone (no answer) is sent again too: the customer may get it
//   twice, never none. After TRIES attempts nothing more is sent, and the log asks a person to write (once: a last try
//   a restart cut off is marked unsure on the next ask).
// - An email the customer can ask for more than once (a recovery link, say) is once per delivery instead: the product
//   names each of the customer's asks with its own `delivery` (8-64 letters, digits, _ or -: a UUID), keeps it, and
//   asks with it again until it went. The answer echoes it. Each order and kind takes a few new deliveries at most
//   (NEW_DELIVERIES): past them it's 429 with why delivery_quota, nothing sent or kept, so neither a product's bug nor
//   someone who knows a reference can fill the payer's inbox. The address is still the payment's.
// - Test mode without the email service renders the email back (test_email) instead of sending it, again on every ask
//   for one it rendered before. A new delivery still counts against its caps. Live mode without the service refuses
//   (503).
// The link carries the order's key, so neither it nor the address is ever logged or stored here.
// - Who else hears that one went (sentHooks): a company's own module, for what it does once an order email has really
//   gone, in either mode (never one test mode rendered back): a review platform's invitation after the shipped email,
//   say. It gets the address, the order's reference slot, the delivery and the payment behind it, never the words or the
//   link.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { companyFormats, yamlFile } from './company.ts';
import { REPO_DIR } from './config.ts';
import { db } from './db.ts';
import { type Caller, type Refused, reply, json, lineOf, log, ownLine, ownUrl, ownSession, productRequest, retireHooks, serial, StripeError } from './payments.ts';   // lines:
import * as mailout from './mailout.ts';

type Attachment = NonNullable<mailout.Mail['attachments']>[number];

// delivery: '' for an email that goes once per order and kind
db.exec(`create table if not exists order_emails (product text not null, mode text not null, reference text not null,
  kind text not null, delivery text not null default '', status text not null, tries integer not null,
  rendered integer not null, created text not null, updated text not null,
  primary key (product, mode, reference, kind, delivery))`);
// An order past its product's retention forgets its emails (payments.ts, retire)
retireHooks.push((c, reference) =>
  db.prepare('delete from order_emails where product = ? and mode = ? and reference = ?').run(c.slug, c.mode, reference));

// A kind may carry its words' version (receipt_2), so an order keeps the words it was sold under
const REF = /^[A-Za-z0-9_-]{1,64}$/, KIND = /^[a-z][a-z0-9_]{0,30}$/, LANG = /^[a-z]{2}$/, DELIVERY = /^[A-Za-z0-9_-]{8,64}$/;
const TRIES = 3;
// New deliveries per order and kind: at most three within ten minutes and ten within a day.
// Retries and the email without a delivery have their own rules.
const NEW_DELIVERIES = [
  { withinMs: 10 * 60_000, most: 3, within: '10 minutes' },
  { withinMs: 24 * 60 * 60_000, most: 10, within: 'a day' },
];
const STUCK_MS = 2 * 60_000;   // a send still marked after this was cut off (HQ restarted mid-send): it may have gone
const told = new Set<string>();

// A company's own payment tool names the paid Checkout Session behind an order it paid for in full (a voucher: the
// payment that funded it), or the basket line (ln_...) whose basket's payment funded it,
// or null.
export const paidOtherwise: ((c: Caller, order: string) => string | null)[] = [];
// payment: the paid Checkout Session's id (a basket's for a line of one), so a hook
// can count one buyer's checkout once whichever of its orders' emails it hears of; ref: the ref slot as the email has it, or null;
// delivery: the ask's own (null without one; optional, so a hook from before deliveries still fits)
export type Sent = { slug: string; mode: 'test' | 'live'; order: string; kind: string; delivery?: string | null; lang: string; to: string; payment: string; ref: string | null };
export const sentHooks: ((m: Sent) => void)[] = [];

// ---- the words
const template = (slug: string, kind: string, lang: string) => {
  const t = yamlFile(`products/${slug}/care/order-emails.yaml`)?.[kind]?.[lang];
  const body = Array.isArray(t?.body) && t.body.every((part: unknown) => typeof part === 'string')
    ? t.body.map((part: string) => part.trim()).join('\n\n') : t?.body;
  return t && typeof t.subject === 'string' && typeof body === 'string' ? { subject: t.subject as string, body, attachments: t.attachments } : null;
};
// The files a kind names, read now (the terms as they stand when it goes), or what's wrong with them.
const TYPES: Record<string, { type: string; magic: string }> = {
  pdf: { type: 'application/pdf', magic: '%PDF-' }, png: { type: 'image/png', magic: '\x89PNG' },
  jpg: { type: 'image/jpeg', magic: '\xff\xd8\xff' }, jpeg: { type: 'image/jpeg', magic: '\xff\xd8\xff' },
};
const FILE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u, PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const MAX_FILES = 5, MAX_BYTES = 15_000_000;   // (Lettermint takes 25 MB a message, base64 included)
// (exported for the basket's email, basketmail.ts)
export function files(slug: string, named: unknown, where: string): Attachment[] | string {
  if (named === undefined || named === null) return [];
  if (typeof named !== 'object' || Array.isArray(named)) return `${where}: the name the customer sees, then the file in products/${slug}/`;
  const entries = Object.entries(named as Record<string, unknown>), out: Attachment[] = [];
  if (entries.length > MAX_FILES) return `${where}: ${MAX_FILES} files at most`;
  const own = realpathSync(`${REPO_DIR}/products/${slug}`);
  for (const [filename, path] of entries) {
    const ext = filename.split('.').pop()!.toLowerCase(), t = TYPES[ext];
    if (!FILE_NAME.test(filename) || !t) return `${where}: "${filename}" should be a short file name ending in .pdf, .png or .jpg`;
    if (typeof path !== 'string' || !PATH.test(path) || path.split('/').includes('..') || path.split('.').pop()!.toLowerCase() !== ext)
      return `${where}: "${filename}" names a ${ext} file in products/${slug}/ (a path like legal/terms-en.${ext})`;
    let real: string;
    try { real = realpathSync(`${own}/${path}`); } catch { return `${where}: products/${slug}/${path} is missing`; }
    if (!real.startsWith(`${own}/`) || !statSync(real).isFile()) return `${where}: products/${slug}/${path} isn't a file of the product's`;
    const content = readFileSync(real);
    if (!content.subarray(0, t.magic.length).equals(Buffer.from(t.magic, 'latin1'))) return `${where}: products/${slug}/${path} isn't a ${ext} file`;
    out.push({ filename, content, type: t.type });
  }
  return out.reduce((n, a) => n + a.content.length, 0) > MAX_BYTES ? `${where}: ${MAX_BYTES / 1e6} MB in all at most` : out;
}

const short = (v: unknown, max: number) => {
  const text = typeof v === 'string' ? v.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim() : '';
  return text && text.length <= max ? text : null;
};
const https = (v: unknown) => {
  try {
    const url = new URL(String(v ?? ''));
    return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 500 ? url.href : null;
  } catch { return null; }
};
// The email's language as its own locale, and the payment's currency
type Ask = { slug: string; lang: string; currency: string };
const formatsOf = (a: Ask) => companyFormats(a.currency.toUpperCase(), { [a.lang]: a.lang });
const plainSpaces = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');
// €39.95, € 39,95, 39,95 €: the language's way, with plain spaces
const money = (cents: number, a: Ask) => plainSpaces(formatsOf(a).money(cents, a.lang));
// 21%, 5,5 %: the language's way
const percent = (rate: number, a: Ask) =>
  plainSpaces(formatsOf(a).number(rate / 100, a.lang, { style: 'percent', maximumFractionDigits: 2 }));
// Each slot: what it takes, and its value in the email (null: refused)
const SLOTS: Record<string, { takes: string; fill: (v: unknown, a: Ask) => string | null }> = {
  ref: { takes: '4-20 letters, digits or -', fill: v => typeof v === 'string' && /^[A-Za-z0-9-]{4,20}$/.test(v) ? v : null },
  name: { takes: 'a short text (60 characters at most)', fill: v => short(v, 60) },
  // A product formats its payment or request date in the email's language.
  date: { takes: 'a formatted date and time (60 characters at most)', fill: v => short(v, 60) },
  total: { takes: 'whole cents', fill: (v, a) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 10_000_000 ? money(v as number, a) : null },
  // the VAT the total includes, as the order was charged: its amount (0 where none is due) and its rate.
  vat: { takes: 'whole cents', fill: (v, a) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000_000 ? money(v as number, a) : null },
  vat_rate: { takes: 'a percentage from 0 to 100', fill: (v, a) => typeof v === 'number' && v >= 0 && v <= 100 ? percent(v, a) : null },
  link: { takes: "an https URL on this product's own address", fill: (v, a) => { const url = ownUrl(v, a.slug); return url && !url.username && !url.password ? url.href : null; } },
  // the shop's own address, nothing after it ({site}/help.html in the words).
  // On a shelf it's the shelf's top, https://www.<zone>/<slug>
  site: { takes: "this product's own https address (https://host, or its shelf https://host/<slug>/)", fill: (v, a) => {
    const url = ownUrl(v, a.slug);
    if (!url || url.username || url.password || url.search || url.hash) return null;
    return url.pathname === '/' ? url.origin : url.pathname === `/${a.slug}/` ? `${url.origin}/${a.slug}` : null;
  } },
  tracking: { takes: 'an https URL', fill: v => https(v) },
  carrier: { takes: 'a short name', fill: v => typeof v === 'string' && /^[\p{L}\p{N} .&'-]{1,40}$/u.test(v.trim()) ? v.trim() : null },
  // short texts (names, items, lines), written the language's way: "Lies, Mila en Sem", "Lies, Mila, and Sem"
  list: { takes: 'a list of 1-20 short texts (40 characters at most each)', fill: (v, a) => {
    const items = Array.isArray(v) && v.length >= 1 && v.length <= 20 ? v.map(t => short(t, 40)) : [];
    return items.length && items.every(t => t !== null) ? formatsOf(a).list(items as string[], a.lang) : null;
  } },
};
const UNFINISHED = /<<[\s\S]*?>>/;
const SLOT = new RegExp(`\\{(${Object.keys(SLOTS).join('|')})\\}`, 'g');
const NOT_SLOT = new RegExp(`\\{(?!(${Object.keys(SLOTS).join('|')})\\})[a-z_]+\\}`);
// An order's fact, {fact:name}: plain text, its own lines kept, without a link.
const FACT = /\{fact:([^{}]*)\}/g, FACT_NAME = /^[a-z][a-z0-9_]{0,30}$/, LINK = /:\/\/|\bwww\./i, FACT_MAX = 2000;
const factOf = (v: unknown) => {
  if (typeof v !== 'string') return null;
  const lines = v.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim());
  const text = lines.join('\n').trim();
  return text && text.length <= FACT_MAX && !LINK.test(text) ? text : null;
};
// Every slot and fact in one pass, so a value is never read as a slot itself
const FILLED = new RegExp(`\\{(${Object.keys(SLOTS).join('|')}|fact:[a-z][a-z0-9_]{0,30})\\}`, 'g');

function render(a: Ask, kind: string, slots: Record<string, unknown>) {
  const t = template(a.slug, kind, a.lang);
  if (!t) return [400, `no ${kind} email in ${a.lang} for ${a.slug} (products/${a.slug}/care/order-emails.yaml)`] as [number, string];
  const unknown = `${t.subject}\n${t.body}`.match(NOT_SLOT)?.[0];
  if (unknown) return [400, `${unknown} in products/${a.slug}/care/order-emails.yaml isn't a slot HQ fills`] as [number, string];
  const values: Record<string, string> = {};
  for (const [, slot] of `${t.subject}\n${t.body}`.matchAll(SLOT)) {
    const value = SLOTS[slot].fill(slots[slot], a);
    if (value === null) return [400, `slots.${slot}: ${SLOTS[slot].takes}`] as [number, string];
    values[slot] = value;
  }
  const facts = (slots.facts && typeof slots.facts === 'object' ? slots.facts : {}) as Record<string, unknown>;
  for (const [, name] of `${t.subject}\n${t.body}`.matchAll(FACT)) {
    if (!FACT_NAME.test(name)) return [400, `{fact:${name}} in products/${a.slug}/care/order-emails.yaml: a fact's name is a lower-case word`] as [number, string];
    const value = factOf(Object.hasOwn(facts, name) ? facts[name] : null);
    if (value === null) return [400, `slots.facts.${name}: plain text without a link, ${FACT_MAX} characters at most`] as [number, string];
    values[`fact:${name}`] = value;
  }
  const attachments = files(a.slug, t.attachments, `products/${a.slug}/care/order-emails.yaml, ${kind}.${a.lang}.attachments`);
  if (typeof attachments === 'string') return [400, attachments] as [number, string];
  const subject = t.subject.replace(FILLED, (_, slot) => values[slot]).replace(/\s+/g, ' ').trim();
  const unfinishedFact = Object.entries(values).some(([slot, value]) => slot.startsWith('fact:') && UNFINISHED.test(value));
  return { subject, text: t.body.replace(FILLED, (_, slot) => values[slot]).trim() + '\n', attachments, unfinishedFact };
}
// what test mode shows of the files: their names
const shown = (m: { subject: string; text: string; attachments: Attachment[] }) =>
  ({ subject: m.subject, text: m.text, ...(m.attachments.length ? { attachments: m.attachments.map(a => a.filename) } : {}) });

// ---- where it goes: the address on the payment, as Stripe has it
type Payment = { to: string; currency: string; payment: string };   // (payment)
async function paidSession(c: Caller, id: string) {
  try {
    const own = await ownSession(c, id);
    return own && own.s.status === 'complete' && own.s.payment_status === 'paid' ? own.s : null;
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return null;   // gone at Stripe (a new key; the imitation's before it outlived restarts)
    throw e;
  }
}
// The basket's payment that paid a line of this product's
async function paidLineSession(c: Caller, id: string) {
  try {
    const own = await ownLine(c, id);
    return own?.line.status === 'paid' && own.s?.status === 'complete' && own.s.payment_status === 'paid' ? own.s : null;
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return null;
    throw e;
  }
}
// (a refusal's third part: an order that is paid, but its email can't go, so a person should send it)
// (exported for the phone line's code, phonecode.ts)
export async function payment(c: Caller, order: string, given: unknown): Promise<Payment | [number, string, 'person'?]> {
  const sessions = db.prepare("select id from payments where product = ? and mode = ? and reference = ? and status != 'expired' order by created desc")
    .all(c.slug, c.mode, order) as { id: string }[];
  for (const { id } of sessions) {
    const s = await paidSession(c, id);
    if (!s) continue;
    const to = mailout.address(s.customer_details?.email);
    return to ? { to, currency: s.currency, payment: s.id } : [409, "Stripe has no email address for this order's payment", 'person'];
  }
  // An order that is a line of a basket: the basket's payment, in the line's currency
  const line = lineOf(c, order);
  const basket = line ? await paidLineSession(c, line.id) : null;   // (it reads a payment made since, too)
  if (line && basket) {
    const to = mailout.address(basket.customer_details?.email);
    return to ? { to, currency: line.currency, payment: basket.id } : [409, "Stripe has no email address for this order's payment", 'person'];
  }
  const other = paidOtherwise.map(named => named(c, order)).find(Boolean);
  const s = other ? await (other.startsWith('ln_') ? paidLineSession(c, other) : paidSession(c, other)) : null;
  if (!s) return [409, 'this order is not paid: no paid checkout of its own, nor anything else that paid for it'];
  const to = mailout.address(s.customer_details?.email), customers = mailout.address(given);
  if (!to || to.toLowerCase() !== customers?.toLowerCase())
    return [409, "this order was paid for by an earlier payment made from another address than the customer gave: HQ can't vouch for it, so nothing is sent", 'person'];
  return { to, currency: s.currency, payment: s.id };
}

// ---- once per order and kind, or per delivery
type OrderEmailKey = { caller: Caller; order: string; kind: string; delivery: string };
type Row = { status: 'sending' | 'sent' | 'unsure' | 'refused'; tries: number; rendered: number; updated: string };
const row = (emailKey: OrderEmailKey) =>
  db.prepare('select status, tries, rendered, updated from order_emails where product = ? and mode = ? and reference = ? and kind = ? and delivery = ?')
    .get(emailKey.caller.slug, emailKey.caller.mode, emailKey.order, emailKey.kind, emailKey.delivery) as Row | undefined;
const mark = (emailKey: OrderEmailKey, status: Row['status'], tries: number, rendered = 0) => {
  const now = new Date().toISOString();
  db.prepare(`insert into order_emails (product, mode, reference, kind, delivery, status, tries, rendered, created, updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (product, mode, reference, kind, delivery) do update set status = excluded.status, tries = excluded.tries, rendered = excluded.rendered,
    updated = excluded.updated`).run(emailKey.caller.slug, emailKey.caller.mode, emailKey.order, emailKey.kind, emailKey.delivery, status, tries, rendered, now, now);
};
const stuck = (r: Row) => r.status === 'sending' && Date.parse(r.updated) < Date.now() - STUCK_MS;
// Whether this ask sends: never after it went, while another ask is sending it, or once the tries are used up
const sends = (r?: Row) => !r || ((r.status === 'refused' || r.status === 'unsure' || stuck(r)) && r.tries < TRIES);
// A last try cut off by a restart never reaches send's catch: it's marked unsure here, so a person is asked once
function spent(emailKey: OrderEmailKey, what: string, r?: Row) {
  if (!r || !stuck(r) || r.tries < TRIES) return r;
  mark(emailKey, 'unsure', r.tries);
  log(`NEEDS A PERSON: ${emailKey.caller.slug}: ${what} may not have gone (HQ restarted during its last try). The customer has only the order page: write to the address on its payment.`);
  return row(emailKey);
}
// The refusal of a new delivery past a cap, or null (a delivery the table has already is no new one)
function deliveryCapRefusal(emailKey: OrderEmailKey, r?: Row): Refused | null {
  if (!emailKey.delivery || r) return null;
  const cap = NEW_DELIVERIES.find(({ withinMs, most }) => {
    const createdAfter = new Date(Date.now() - withinMs).toISOString();
    const countStatement = db.prepare(
      "select count(*) as n from order_emails where product = ? and mode = ? and reference = ? and kind = ? and delivery != '' and created > ?");
    const deliveryCount = countStatement.get(
      emailKey.caller.slug, emailKey.caller.mode, emailKey.order, emailKey.kind, createdAfter) as { n: number };
    return deliveryCount.n >= most;
  });
  if (!cap) return null;
  return [429, `delivery: the ${emailKey.kind} email for this order had ${cap.most} new deliveries within ${cap.within}, so nothing is sent; ask again later`, 'delivery_quota'];
}
const emailFields = (emailKey: OrderEmailKey) => ({ order: emailKey.order, kind: emailKey.kind, ...(emailKey.delivery ? { delivery: emailKey.delivery } : {}) });
// (refused or unsure here: out of tries, and a person was told)
const answer = (emailKey: OrderEmailKey, r: Row) => ({ ...emailFields(emailKey), status: r.status });

// The order's queue (payments.ts, serial) covers the payment lookup through the final email status. Checkout and
// retirement share this queue. Retirement waits for an email being sent. An email requested after retirement finds
// the order gone
export const email = (c: Caller, b: any) => serial(`${c.slug}:${c.mode}:${String(b?.order ?? '')}`, () => emailOrder(c, b));
async function emailOrder(c: Caller, b: any): Promise<Refused | object> {
  const order = String(b.order ?? ''), kind = String(b.kind ?? ''), lang = String(b.lang ?? '');
  const slots = b.slots && typeof b.slots === 'object' ? b.slots : {};
  if (!REF.test(order)) return [400, 'order: 1-64 letters, digits, _ or -'];
  if (!KIND.test(kind)) return [400, 'kind: a lower-case word, with digits after the first letter (paid, shipped, receipt_2)'];
  if (!LANG.test(lang)) return [400, 'lang: a two-letter language code (en, nl, de)'];
  const requestedDelivery = b.delivery ?? null;
  if (requestedDelivery !== null && !(typeof requestedDelivery === 'string' && DELIVERY.test(requestedDelivery))) return [400, 'delivery: 8-64 letters, digits, _ or - (a UUID)'];
  const emailKey: OrderEmailKey = { caller: c, order, kind, delivery: requestedDelivery ?? '' };
  // the words are checked before anything else, so a bad slot is the same answer whatever the order's state
  const checked = render({ slug: c.slug, lang, currency: 'eur' }, kind, slots);
  if (Array.isArray(checked)) return checked;
  if (!mailout.ready(c.mode)) return [503, 'no email service on the server yet'];
  const what = `the ${kind} email for ${order} (${c.mode})`, before = spent(emailKey, what, row(emailKey));
  if (!sends(before) && !before?.rendered) return answer(emailKey, before!);
  // Refuse a new delivery past a cap before looking up its payment in Stripe.
  const tooMany = deliveryCapRefusal(emailKey, before);
  if (tooMany) return tooMany;
  const paid = await payment(c, order, b.email);
  if (Array.isArray(paid)) {
    if (paid[2] && !told.has(`${c.slug}:${what}`)) {   // once (per run of HQ), however often the product asks
      told.add(`${c.slug}:${what}`);
      log(`NEEDS A PERSON: ${c.slug} can't send ${what}: ${paid[1]}. The customer has only the order page.`);
    }
    return [paid[0], paid[1]];
  }
  const rendered = render({ slug: c.slug, lang, currency: paid.currency }, kind, slots);
  if (Array.isArray(rendered)) return rendered;   // (a file gone since the check)
  const { unfinishedFact, ...mail } = rendered;
  // live words that aren't final yet never go: no try is counted, so the ask after they're filled in sends it. An
  // order's fact that isn't final is held back the same way.
  const t = template(c.slug, kind, lang), words = t ? `${t.subject}\n${t.body}` : '';
  const marker = words.match(UNFINISHED)?.[0];
  if (c.mode === 'live' && (marker || unfinishedFact)) {
    const why = marker ? `products/${c.slug}/care/order-emails.yaml, ${kind}.${lang}, still holds ${marker}: its words aren't final yet`
      : `the order's facts for its ${kind} email contain unfinished fields: they aren't final yet`;
    if (!told.has(`${c.slug}:${what}:words`)) {
      told.add(`${c.slug}:${what}:words`);
      const nextSteps = [];
      if (marker) nextSteps.push('Fill in the words on main.');
      if (unfinishedFact) nextSteps.push('Have the product ask again with final order facts.');
      else nextSteps.push('Then ask again.');
      log(`NEEDS A PERSON: ${c.slug} can't send ${what}: ${why}. ${nextSteps.join(' ')} Until then the customer has only the order page.`);
    }
    return [409, `${why}, so nothing is sent`];
  }
  if (before?.rendered) return { ...answer(emailKey, before), test_email: { to: paid.to, ...shown(mail) } };
  const tries = (before?.tries ?? 0) + 1;
  mark(emailKey, 'sending', tries);
  try {
    const sent = await mailout.send(c.mode, { to: paid.to, ...mail, replyTo: mailout.hello(), about: `${c.slug}'s ${what}` });
    mark(emailKey, 'sent', tries, sent.test ? 1 : 0);
    log(`${c.slug} ${sent.test ? 'rendered' : 'sent'} ${what}.`);
    if (!sent.test) heard({ slug: c.slug, mode: c.mode, order, kind, delivery: emailKey.delivery || null, lang, to: paid.to, payment: paid.payment,
      ref: SLOTS.ref.fill(slots.ref, { slug: c.slug, lang, currency: paid.currency }) });
    return { ...emailFields(emailKey), status: 'sent', ...(sent.test ? { test_email: { to: paid.to, ...sent.test } } : {}) };
  } catch (e) {
    if (!(e instanceof mailout.MailError)) { mark(emailKey, 'unsure', tries); throw e; }
    const unsure = e.status === 504;
    mark(emailKey, unsure ? 'unsure' : 'refused', tries);
    if (tries >= TRIES) log(`NEEDS A PERSON: ${c.slug}: ${what} didn't surely go after ${tries} tries (${e.status}). The customer has only the order page: write to the address on its payment.`);
    else log(`${c.slug}: ${what} ${unsure ? 'may not have gone (no answer)' : `didn't go (${e.status})`}; the next ask sends it again.`);
    return [e.status === 400 ? 400 : 502, e.message];
  }
}

function heard(m: Sent) {
  for (const hook of sentHooks) try { hook(m); } catch (e) { console.error(`Order email ${m.kind} for ${m.slug}: a hook failed:`, e); }
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const asked = await productRequest(req, res, { post: true });
  if (!asked) return;
  try {
    return reply(res, await email(asked.caller, asked.body));
  } catch (err) {
    if (err instanceof StripeError) return json(res, err.status, { error: err.message });
    throw err;
  }
}
