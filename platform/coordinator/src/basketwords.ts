// The basket's two emails in the front's words, filled in from its paid lines, or what's wrong with the words
// (basketmail.ts sends them).
//
// The confirmation's words: products/<front>/care/basket-email.yaml, the language as the key (the session's locale, if
// the file has it, else en), each with a subject, a body, the `voucher` and `saved` phrases ({amount}) and an optional
// `gift` (what a gift card paid of an item: payments.ts basketGift), `delivery`
// words per country, and `attachments` the way order-emails.yaml names them (ordermail.ts files()). The body's slots:
//   {number}    the basket's order number (payments.ts, shared/ordernumber), as it's read out: 482 9173
//   {items}     one receipt row per item (mailpage.ts rows): its picture, description, detail and price paid; in the
//               text part its shop (manifest name), description, detail and price paid
//   {total}     what the checkout charged for the basket (vouchers not counted)
//   {saved}     the `saved` phrase with the postage saved, or nothing when none was
//   {ship_by}   the latest day a line should leave the printer, written out in the language
//   {delivery}  the `delivery` words for the parcel's country
//   {order_page} the basket's one order page: the words' `order_page` address (`test_order_page` for a test-mode
//               payment) with #<number>.<key> (history.ts orderKey), the shop's page that shows the whole order and
//               links each item's own page
//   {notes}     the company's own sentences for this order (basketmail.ts notes: the phrases its hooks name, from the
//               words' `notes`), one a line, or nothing
//   {again}     each shop in the basket once, with the page the words' `again` names for it (the product's slug as the
//               key), to make another; a shop it doesn't name is left out.
//   {signoff}   the company's own closing line as the email goes (basketmail.ts signoffs), or nothing
//
// The shipped email's words: products/<front>/care/shipped-email.yaml, the kind, then the language (as the
// confirmation's), each with a subject and a body. The body's slots:
//   {items}     one line per thing in the parcel, then the shop's own paid lines going with it (parcels.linesIn): its
//               shop and description, no prices
//   {tracking}  Print API's tracking link (shipped only), linked whole or behind a button the words make of it
//   {notes}     the company's own sentences for this parcel (basketmail.ts shippedNotes), one a line, or nothing
//   {delivery}  the confirmation's `delivery` words for the parcel's country (basket-email.yaml), not a copy of them
//   {number}, {order_page}, {signoff}  the confirmation's
//
// Both bodies are plain text with mailpage.ts's little markup (headings, lists, small print). With the front's look,
// products/<front>/care/email-look.yaml, the email gets an HTML part set in it beside the text.
import * as payments from './payments.ts';
import { manifest } from './manifests.ts';
import { FRONT } from './approvals.ts';
import { companyFormats, yamlFile } from './company.ts';
import { db } from './db.ts';
import * as mailout from './mailout.ts';
import * as mailpage from './mailpage.ts';
import { files } from './ordermail.ts';
import { orderKey } from './history.ts';
import { spaced } from '../../../shared/ordernumber/ordernumber.js';
import { copiesOf } from '../../../shared/format/format.js';

const WORDS = `products/${FRONT}/care/basket-email.yaml`;
const SHIPPED_WORDS = `products/${FRONT}/care/shipped-email.yaml`;
const LOOK = `products/${FRONT}/care/email-look.yaml`; // the HTML part's look (mailpage.ts), if the front has one
const { slot: SLOT, notSlot: NOT_SLOT } = mailpage.slotsOf([
  'number',
  'items',
  'total',
  'saved',
  'ship_by',
  'delivery',
  'order_page',
  'notes',
  'again',
  'signoff',
]);
const { slot: SHIPPED_SLOT, notSlot: NOT_SHIPPED_SLOT } = mailpage.slotsOf([
  'number',
  'items',
  'tracking',
  'notes',
  'delivery',
  'order_page',
  'signoff',
]);

// shipped once the tracking link is in, shipped_untracked when none came (basketmail.ts sweepShipped)
export type Kind = 'shipped' | 'shipped_untracked';
export type Mail = {
  subject: string;
  text: string;
  html?: string;
  attachments: NonNullable<mailout.Mail['attachments']>;
};
// The company's own sentences in an email: the phrases its notes hooks named, and its closing line for the language
export type Own = { notes: string[]; signoff: (lang: string) => mailpage.Marked | null };
type Words = Record<string, any> & { subject: string; body: string };

export function confirmation(pay: any, s: any, lines: payments.Line[], own: Own): Mail | string {
  const lang = langOf(s, yamlFile(WORDS)),
    where = `${WORDS}, ${lang}`;
  const t = yamlFile(WORDS)?.[lang];
  if (!t || typeof t.subject !== 'string' || typeof t.body !== 'string')
    return `${WORDS} has no ${lang} subject and body`;
  if (typeof t.voucher !== 'string' || typeof t.saved !== 'string') return `${where}: the voucher and saved phrases`;
  const unfit = unfitWords(t, NOT_SLOT, WORDS, where, pay.mode);
  if (unfit) return unfit;
  if (!lines.length) return 'the session has no paid lines';
  const delivery = deliveryOf(pay, lang);
  if (typeof delivery === 'string') return delivery;
  const attachments = files(FRONT, t.attachments, `${where}.attachments`);
  if (typeof attachments === 'string') return attachments;
  const unnamed = missingNote(t, own.notes, where);
  if (unnamed) return unnamed;
  const order = orderOf(pay, lang, `${t.subject}\n${t.body}`);
  if (typeof order === 'string') return order;

  // the email's language (English as written in Europe: Friday 9 October), with plain spaces
  const formats = companyFormats(String(s.currency ?? 'eur').toUpperCase(), { [lang]: lang === 'en' ? 'en-GB' : lang });
  const money = (cents: number) => formats.money(cents, lang).replace(/[\u00a0\u202f]/g, ' ');
  const items = receiptRows(lines, t, money, payments.isTesterOrder(pay.id));
  const saved = lines.reduce((n, line) => n + (line.saved ?? 0), 0);
  const shipBy = lines
    .map(line => payments.shipBy(line))
    .sort()
    .at(-1)!;
  const values: Record<string, string> = {
    ...order,
    ...delivery,
    items: items.map(row => row.text).join('\n'),
    total: money(lines.reduce((n, line) => n + (line.card ?? 0), 0)),
    saved: saved ? t.saved.replace('{amount}', money(saved)) : '',
    ship_by: formats.day(shipBy, lang, { weekday: true }),
    notes: own.notes.map(name => t.notes[name]).join('\n'),
    again: againLines(lines, t.again).join('\n'),
    signoff: '',
  };
  return written(t, values, SLOT, lang, { links: ['order_page'], rows: { items }, signoff: own.signoff, attachments });
}

// The shipped email: what's in the parcel, no prices, and how to follow it
export function shipped(
  kind: Kind,
  pay: any,
  s: any,
  lines: payments.Line[],
  tracking: string | null,
  own: Own,
): Mail | string {
  const lang = langOf(s, yamlFile(SHIPPED_WORDS)?.[kind]),
    where = `${SHIPPED_WORDS}, ${kind}.${lang}`;
  const t = yamlFile(SHIPPED_WORDS)?.[kind]?.[lang];
  if (!t || typeof t.subject !== 'string' || typeof t.body !== 'string')
    return `${SHIPPED_WORDS} has no ${kind} subject and body in ${lang}`;
  const unfit = unfitWords(t, NOT_SHIPPED_SLOT, SHIPPED_WORDS, where, pay.mode);
  if (unfit) return unfit;
  if (!lines.length) return 'its parcel holds no lines';
  if (kind === 'shipped' && !tracking) return 'its parcel has no tracking link';
  const unnamed = missingNote(t, own.notes, where);
  if (unnamed) return unnamed;
  const delivery = deliveryOf(pay, lang);
  if (typeof delivery === 'string') return delivery;
  const order = orderOf(pay, lang, `${t.subject}\n${t.body}`);
  if (typeof order === 'string') return order;
  const values: Record<string, string> = {
    ...order,
    ...delivery,
    items: lines.map(line => `- ${shop(line)}: ${described(line)}`).join('\n'),
    tracking: tracking ?? '',
    notes: own.notes.map(name => t.notes[name]).join('\n'),
    signoff: '',
  };
  return written(t, values, SHIPPED_SLOT, lang, { links: ['tracking', 'order_page'], signoff: own.signoff });
}

// The basket's number as read out and its one order page, for an agent who answers its customer (hq parcel), in the
// language the basket was paid in
export function orderPage(session: string) {
  const pay = db.prepare('select id, locale, mode from payments where id = ?').get(session) as
    { id: string; locale: string | null; mode: string } | undefined;
  const order = pay ? orderOf(pay, langOf(pay, yamlFile(WORDS)), '{number} {order_page}') : null;
  return order && typeof order !== 'string' ? order : null;
}

// The session's language, if the words have it, else en
function langOf(s: any, words: any) {
  const asked = String(s.locale ?? '').slice(0, 2);
  return /^[a-z]{2}$/.test(asked) && words?.[asked] ? asked : 'en';
}

// What's wrong with the subject and body as written: a slot HQ doesn't fill, or, in a live email, words their writer
// hasn't finished; null when nothing is
function unfitWords(t: Words, notSlot: RegExp, file: string, where: string, mode: string) {
  const unknown = `${t.subject}\n${t.body}`.match(notSlot)?.[0];
  if (unknown) return `${unknown} in ${file} isn't a slot HQ fills`;
  const marker = mode === 'live' ? `${t.subject}\n${t.body}`.match(mailpage.UNFINISHED)?.[0] : undefined;
  return marker ? `${where}, still holds ${marker}: its words aren't final yet` : null;
}

// The first phrase the notes hooks named that the words' notes don't have, said as missing; null when they have all
const missingNote = (t: Words, named: string[], where: string) => {
  const missing = named.find(name => typeof t.notes?.[name] !== 'string');
  return missing === undefined ? null : `${where}: no notes.${String(missing).slice(0, 40)} phrase`;
};

// The confirmation's delivery words for the parcel's country, or what's missing
function deliveryOf(pay: any, lang: string): { delivery: string } | string {
  const country = String(pay.country ?? ''),
    delivery = yamlFile(WORDS)?.[lang]?.delivery?.[country];
  if (typeof delivery !== 'string')
    return `${WORDS}, ${lang}: no delivery words for the parcel's country (${country.slice(0, 2) || 'none'})`;
  return { delivery };
}

// The basket's number as read out, and its one order page (the words' address for the payment's mode, the number and
// its key in the fragment), or what's missing of what the words use
function orderOf(pay: any, lang: string, words: string): { number: string; order_page: string } | string {
  const field = pay.mode === 'test' ? 'test_order_page' : 'order_page';
  const number = payments.orderNumber(String(pay.id)),
    page = yamlFile(WORDS)?.[lang]?.[field];
  const uses = (slot: string) => words.includes(`{${slot}}`);
  if (!number && (uses('number') || uses('order_page'))) return 'the basket has no order number';
  const pageOk = typeof page === 'string' && /^https:\/\/\S+$/.test(page) && !page.includes('#');
  if (!pageOk && uses('order_page')) return `${WORDS}, ${lang}: no ${field} address`;
  return {
    number: number ? spaced(number) : '',
    order_page: number && pageOk ? `${page}#${number}.${orderKey(String(pay.id))}` : '',
  };
}

// One receipt row per line: a line of copies is all of them, as one row, with the voucher that paid towards it (a
// tester's order: their voucher paid every line in full)
function receiptRows(lines: payments.Line[], t: Words, money: (cents: number) => string, tester: boolean) {
  return lines.map((line): mailpage.Row => {
    const whole = line.amount * line.quantity,
      paid = whole - (line.saved ?? 0),
      voucher = tester ? whole : (line.voucher_value ?? 0);
    // and the words' optional `gift` phrase for what a gift card paid of it
    const gift = line.gift && typeof t.gift === 'string' ? t.gift.replace('{amount}', money(line.gift)) : '';
    const note = [voucher ? t.voucher.replace('{amount}', money(voucher)) : '', gift].filter(Boolean).join(', ');
    return {
      text: `- ${shop(line)}: ${described(line)}, ${money(paid)}${note ? ` (${note})` : ''}`,
      picture: pictureOf(line),
      name: `${copiesOf(line)}${line.description}`,
      details: [line.detail ?? '', note].filter(Boolean),
      amount: money(paid),
    };
  });
}

// Each shop in the basket once, with the page the words name to make another
function againLines(lines: payments.Line[], pages: Record<string, unknown> | undefined) {
  const firstOfShop = lines.filter((line, i) => lines.findIndex(other => other.product === line.product) === i);
  return firstOfShop
    .filter(line => typeof pages?.[line.product] === 'string')
    .map(line => `- ${shop(line)}: ${pages![line.product]}`);
}

const shop = (line: payments.Line) => {
  const name = manifest(line.product)?.name;
  return typeof name === 'string' ? name : line.product;
};
const described = (line: payments.Line) =>
  `${copiesOf(line)}${line.description}${line.detail ? ` (${line.detail})` : ''}`;
// An item's picture, on its product's own address
const pictureOf = (line: payments.Line) =>
  line.picture ? (payments.ownUrl(line.picture, line.product)?.href ?? null) : null;

// The email: its subject's slots filled on one line, and its body as plain text and, in the front's look, HTML
function written(
  t: Words,
  values: Record<string, string>,
  slot: RegExp,
  lang: string,
  o: {
    links: string[];
    rows?: Record<string, mailpage.Row[]>;
    signoff: Own['signoff'];
    attachments?: Mail['attachments'];
  },
): Mail | string {
  const signoff = o.signoff(lang);
  const look = mailpage.readLook(LOOK);
  if (typeof look === 'string') return look;
  const subject = mailpage.subjectOf(t.subject, slot, values);
  const body = mailpage.fill(t.body, values, look, { lang, subject }, o.links, o.rows, signoff ? { signoff } : {});
  return { subject, ...body, attachments: o.attachments ?? [] };
}
