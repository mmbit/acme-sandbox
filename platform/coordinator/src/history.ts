// Order history: a paid basket found by a keyed hash of its payer's email, the end of its records once the law no
// longer keeps them, each line's order number, and a line its customer keeps to order its design again.
//
//   POST /api/pay/line/number {id, number}  → {line, number}: the order number the line's customer was told, set once
//        (the line's own product; another number once one is set: 409 number_set)
//   POST /api/pay/line/keep {id, until}     → {line, kept_until}: its customer keeps what they made until then (an ISO
//        time, at most KEEP_MAX_YEARS out), or null to stop. Until then the 90-day sweep (payments.tick) leaves the
//        line's words and order page; once it passes or stops, the sweep's own rule applies at its next tick. A line
//        that isn't paid: 409 not_paid; one whose words HQ no longer has: 409 gone.
//   The shop only (approvals.ts FRONT):
//   POST /api/pay/history/code {email, lang} → {ok: true}, the same whether or not the address paid for anything. A
//        6-digit code for 10 minutes and 5 tries, only the newest counting, emailed only to an address with paid
//        baskets in the caller's mode. The words are the front's (products/<front>/care/history-email.yaml: per
//        language a subject and a body with the slots {code} and {minutes}; email-look.yaml's look beside it). At most
//        3 an hour and 10 a day per address, counted either way: 429 toomany. The shop counts its own per connection.
//   POST /api/pay/history/check {email, code} → {token, until}: a token for the address's orders for TOKEN_MS, or 401
//        wrong | spent (out of tries, too old, or none asked)
//   GET  /api/pay/history?token=&lang=       → {orders}: the token's paid baskets in the caller's mode, newest first,
//        or 401 expired | invalid. Each: {session, paid_at, country, total, refunded, invoice, lines: [{line, product,
//        shop, number, amount, quantity, refunded, status, kept_until, description?, detail?, order_url?}]}. total and
//        amount: what the card paid, in cents (amount: for all the line's copies, quantity). status: the line's
//        parcel's, or paid without one. description, detail and order_url are there only while HQ still has them. Never
//        an address or an email.
//   GET  /api/pay/history/order?number=&key=&lang= → {order}: one, by its number and its emails' key (orderKey), with
//        no sign-in, or 404 no_order. Orders carry their number, lines their picture
// The hash is an HMAC-SHA256 of the payer's email, trimmed and lower-cased, under HQ's own key (history.key beside
// payments.key, in the nightly encrypted backup of DATA_DIR). A basket gets it as it's paid (a voucher's or a tester's
// too). The email itself is never kept here.
// A paid basket's records end once the law no longer keeps them: records.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './config.ts';
import { db } from './db.ts';
import { FRONT } from './approvals.ts';
import { companyDay, yamlFile } from './company.ts';
import * as payments from './payments.ts';
import { endRecords } from './records.ts';
import * as mailout from './mailout.ts';
import * as mailpage from './mailpage.ts';
import { numberOf } from '../../../shared/ordernumber/ordernumber.js';

// A code asked for an address (its payer hash), whether or not it was sent: the newest counts, once
db.exec(`create table if not exists history_codes (id integer primary key, mode text not null, payer_hash text not null,
  hash text not null, created integer not null, tries integer not null default 0, used integer)`);
db.exec('create index if not exists history_codes_payer on history_codes (payer_hash, mode)');

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365.25 * DAY_MS;
const CODE_MS = 10 * MINUTE_MS;
// A code is one in a million: five tries give a person who mistypes a few more goes, and a guesser 1 in 200,000.
const CODE_TRIES = 5;
// Each code is an email to the address: past these, someone who knows a customer's address could fill their inbox, and
// a guesser could ask code after code. Per address, as the support chat's (platform/care gate.ts): keep them matched.
const CODES_PER_HOUR = 3,
  CODES_PER_DAY = 10;
const TOKEN_MS = HOUR_MS;
const KEEP_MAX_YEARS = 10;
const SWEEP_MS = 2 * MINUTE_MS;
const LINE = /^ln_[a-f0-9]{24}$/,
  PAYER = /^[a-f0-9]{64}$/;
const PAID = "product = ? and basket is not null and status in ('paid', 'refunded')";

// ---- HQ's own key, made once, as payments.key is
const KEY_FILE = `${DATA_DIR}/history.key`;
function historyKey() {
  if (!existsSync(KEY_FILE))
    try {
      writeFileSync(KEY_FILE, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch {
      /* made meanwhile */
    }
  return readFileSync(KEY_FILE, 'utf8').trim();
}
const KEY = historyKey();
const mac = (text: string) => createHmac('sha256', KEY).update(text).digest();
const payerHash = (email: string) => mac(`payer:${email.trim().toLowerCase()}`).toString('hex');
// The key to a paid basket's order page, which its confirmation email's link carries: 16 characters, base64url
export const orderKey = (session: string) => mac(`order:${session}`).subarray(0, 12).toString('base64url');

// A payer's paid baskets in a mode, newest first; by an address whatever its case, for the job investigating its care card
// (care.ts ordersForJob)
const paidBy = (mode: string, payer: string) =>
  db
    .prepare(`select * from payments where ${PAID} and mode = ? and payer_hash = ? order by created desc`)
    .all(FRONT, mode, payer) as any[];
export const basketsPaidBy = (mode: 'test' | 'live', email: string) =>
  paidBy(mode, payerHash(email)).map(p => p.id as string);

// The shop's invoice page for a paid line (the company's invoices kit fills this), or null
export const invoiceLink: { of?: (line: payments.Line, lang: string) => string | null } = {};

// ---- the payer's hash
payments.basketPaid.push((pay, s) => {
  if (pay.product === FRONT && pay.basket) notePayer(pay.id, s?.customer_details?.email);
});
const notePayer = (session: string, email: unknown) => {
  const address = mailout.address(email);
  db.prepare('update payments set payer_hash = ? where id = ? and payer_hash is null').run(
    address ? payerHash(address) : '',
    session,
  );
};

// ---- the sweep: the records' end and old codes once a company day
let endedOn = '';
export const start = () => {
  setInterval(() => sweep().catch(err => console.error('History: the sweep failed:', err)), SWEEP_MS);
};
export async function sweep(now = Date.now()) {
  if (endedOn === companyDay(now)) return;
  endRecords(now);
  db.prepare('delete from history_codes where created < ?').run(now - DAY_MS);
  endedOn = companyDay(now);
}

// ---- the routes
type Caller = payments.Caller;
type Answer = payments.Refused | object;
const routes: Record<string, (c: Caller, body: any) => Answer> = {
  'POST /api/pay/line/number': setNumber,
  'POST /api/pay/line/keep': keepLine,
  'POST /api/pay/history/code': askCode,
  'POST /api/pay/history/check': checkCode,
  'GET /api/pay/history': listOrders,
  'GET /api/pay/history/order': oneOrder,
};
export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x'),
    route = routes[`${req.method} ${url.pathname}`];
  const asked = await payments.productRequest(req, res);
  if (!asked) return;
  const { caller: c, body } = asked;
  if (url.pathname.startsWith('/api/pay/history') && c.slug !== FRONT)
    return payments.reply(res, [403, 'the shop only']);
  if (!route) return payments.reply(res, [404, 'not found']);
  payments.reply(res, route(c, body));
}

// ---- a line's number and its keeping, its own product's
const ownLine = (c: Caller, id: unknown) =>
  LINE.test(String(id ?? ''))
    ? (db
        .prepare('select * from pay_lines where id = ? and product = ? and mode = ?')
        .get(String(id), c.slug, c.mode) as payments.Line | undefined)
    : undefined;
const noLine: payments.Refused = [404, 'no such line for this product'];

function setNumber(c: Caller, body: any): Answer {
  const line = ownLine(c, body.id),
    number = body.number;
  if (!line) return noLine;
  if (typeof number !== 'string' || !payments.ORDER_NUMBER.test(number))
    return [400, 'number: the order number its customer is told, 1-32 letters, digits or -'];
  if (line.number && line.number !== number) return [409, 'number: this line already has another', 'number_set'];
  payments.numberLine(line.id, number);
  return { line: line.id, number };
}

function keepLine(c: Caller, body: any): Answer {
  const line = ownLine(c, body.id);
  if (!line) return noLine;
  const stop = body.until === null,
    until = typeof body.until === 'string' && /^\d{4}-\d\d-\d\d/.test(body.until) ? Date.parse(body.until) : NaN;
  if (!stop && (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + KEEP_MAX_YEARS * YEAR_MS))
    return [400, `until: an ISO time ahead, at most ${KEEP_MAX_YEARS} years out, or null to stop keeping it`];
  if (!stop && line.status !== 'paid') return [409, 'only a paid line is kept', 'not_paid'];
  if (!stop && !line.description) return [409, "HQ no longer has this line's words: there's nothing to keep", 'gone'];
  const keptUntil = stop ? null : new Date(until).toISOString();
  db.prepare('update pay_lines set kept_until = ? where id = ?').run(keptUntil, line.id);
  payments.log(
    `${c.slug} ${stop ? 'stopped keeping' : `keeps until ${keptUntil!.slice(0, 10)}`} its ${c.mode} line for ${line.reference}.`,
  );
  return { line: line.id, kept_until: keptUntil };
}

// ---- the code: asked, sent, checked
const codeHash = (mode: string, payer: string, created: number, code: string) =>
  mac(`code:${mode}:${payer}:${created}:${code}`);
const emailOf = (body: any) => mailout.address(body.email)?.toLowerCase() ?? null;
const badEmail: payments.Refused = [400, 'email: an email address', 'email_invalid'];
const hasOrders = (mode: string, payer: string) =>
  !!db.prepare(`select 1 from payments where ${PAID} and mode = ? and payer_hash = ? limit 1`).get(FRONT, mode, payer);

// Counted and made in one go (nothing awaited), so parallel asks can't all pass the limits. The email goes after the
// answer, so the answer takes as long for an address without orders.
function askCode(c: Caller, body: any): Answer {
  const email = emailOf(body);
  if (!email) return badEmail;
  const payer = payerHash(email),
    t = Date.now();
  const asked = (ms: number) =>
    (
      db
        .prepare('select count(*) n from history_codes where payer_hash = ? and mode = ? and created > ?')
        .get(payer, c.mode, t - ms) as { n: number }
    ).n;
  if (asked(HOUR_MS) >= CODES_PER_HOUR || asked(DAY_MS) >= CODES_PER_DAY)
    return [
      429,
      `at most ${CODES_PER_HOUR} codes an hour and ${CODES_PER_DAY} a day for one address, so nobody can fill an inbox with them: ask again later`,
      'toomany',
    ];
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = Number(
    db
      .prepare('insert into history_codes (mode, payer_hash, hash, created) values (?, ?, ?, ?)')
      .run(c.mode, payer, codeHash(c.mode, payer, t, code).toString('hex'), t).lastInsertRowid,
  );
  if (hasOrders(c.mode, payer))
    sendCode(c.mode, id, email, code, String(body.lang ?? '')).catch(err =>
      console.error(`History: code ${id} could not be sent:`, err),
    );
  return { ok: true };
}

// A code whose email didn't go stays, counted and the newest, like an address without orders' code: dropping it would
// tell an asker which addresses have orders, by when the limit refuses
const told = new Set<string>();
const tellOnce = (text: string) => {
  if (!told.has(text)) {
    told.add(text);
    payments.log(text);
  }
};
async function sendCode(mode: 'test' | 'live', id: number, email: string, code: string, lang: string) {
  const mail = renderCode(mode, lang, code);
  if (typeof mail === 'string') return tellOnce(`NEEDS A PERSON: the order history's codes can't go: ${mail}.`);
  if (!mailout.ready(mode))
    return tellOnce(`NEEDS A PERSON: the order history's codes (${mode}) wait for the email service.`);
  try {
    await mailout.send(mode, {
      to: email,
      ...mail,
      replyTo: mailout.hello(),
      about: `an order history code (${mode})`,
    });
  } catch (err) {
    if (!(err instanceof mailout.MailError)) throw err;
    console.error(`History: code ${id} didn't surely go (${err.status})`);
  }
}

const WORDS = `products/${FRONT}/care/history-email.yaml`;
const LOOK = `products/${FRONT}/care/email-look.yaml`;
const { slot: SLOT, notSlot: NOT_SLOT } = mailpage.slotsOf(['code', 'minutes']);
function renderCode(mode: string, asked: string, code: string) {
  const words = yamlFile(WORDS);
  const lang = /^[a-z]{2}$/.test(asked) && words[asked] ? asked : 'en',
    t = words[lang];
  if (!t || typeof t.subject !== 'string' || typeof t.body !== 'string')
    return `${WORDS} has no ${lang} subject and body`;
  const unknown = `${t.subject}\n${t.body}`.match(NOT_SLOT)?.[0];
  if (unknown) return `${unknown} in ${WORDS} isn't a slot HQ fills`;
  const marker = mode === 'live' ? `${t.subject}\n${t.body}`.match(mailpage.UNFINISHED)?.[0] : undefined;
  if (marker) return `${WORDS}, ${lang}, still holds ${marker}: its words aren't final yet`;
  const look = mailpage.readLook(LOOK);
  if (typeof look === 'string') return look;
  const values: Record<string, string> = { code, minutes: String(CODE_MS / MINUTE_MS) };
  const subject = mailpage.subjectOf(t.subject, SLOT, values);
  return { subject, ...mailpage.fill(t.body, values, look, { lang, subject }) };
}

// Only the address's newest code counts, for CODE_MS and CODE_TRIES. The try is counted before the compare, in one
// statement, so parallel guesses can't share one.
function checkCode(c: Caller, body: any): Answer {
  const email = emailOf(body);
  if (!email) return badEmail;
  const payer = payerHash(email),
    spent: payments.Refused = [401, 'this code is spent or too old: ask for a new one', 'spent'];
  const row = db
    .prepare('select * from history_codes where payer_hash = ? and mode = ? order by id desc limit 1')
    .get(payer, c.mode) as { id: number; hash: string; created: number } | undefined;
  if (!row) return spent;
  const tried = db
    .prepare(
      'update history_codes set tries = tries + 1 where id = ? and used is null and tries < ? and created > ? returning tries',
    )
    .get(row.id, CODE_TRIES, Date.now() - CODE_MS) as { tries: number } | undefined;
  if (!tried) return spent;
  const typed = String(body.code ?? '').replace(/\D/g, '');
  const right =
    typed.length === 6 && timingSafeEqual(codeHash(c.mode, payer, row.created, typed), Buffer.from(row.hash, 'hex'));
  const used = () =>
    db.prepare('update history_codes set used = ? where id = ? and used is null').run(Date.now(), row.id).changes > 0;
  if (!right) {
    if (tried.tries < CODE_TRIES) return [401, 'the code is wrong', 'wrong'];
    used();
    return spent;
  }
  if (!used()) return spent;
  const until = Date.now() + TOKEN_MS;
  return { token: tokenFor(c.mode, payer, until), until: new Date(until).toISOString() };
}

// ---- the token: <payload>.<mac>, the payload base64url JSON {p: payer hash, m: mode, x: expiry (ms)}
const tokenMac = (payload: string) => mac(`token:${payload}`);
function tokenFor(mode: string, payer: string, until: number) {
  const payload = Buffer.from(JSON.stringify({ p: payer, m: mode, x: until })).toString('base64url');
  return `${payload}.${tokenMac(payload).toString('base64url')}`;
}
function payerOf(c: Caller, token: string): string | 'expired' | 'invalid' {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return 'invalid';
  const want = tokenMac(payload),
    got = Buffer.from(signature, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return 'invalid';
  let read: any;
  try {
    read = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return 'invalid';
  }
  if (read?.m !== c.mode || typeof read.p !== 'string' || !PAYER.test(read.p) || typeof read.x !== 'number')
    return 'invalid';
  return read.x > Date.now() ? read.p : 'expired';
}

// ---- the list
function listOrders(c: Caller, body: any): Answer {
  const payer = payerOf(c, String(body.token ?? ''));
  if (payer === 'expired' || payer === 'invalid')
    return [401, payer === 'expired' ? 'the sign-in ran out: ask for a new code' : 'not a token of ours', payer];
  const lang = langOf(body);
  return { orders: paidBy(c.mode, payer).map(pay => orderOf(pay, lang)) };
}
// One order by its number and its page's key: the same answer for a number that isn't one, a wrong key or another mode
function oneOrder(c: Caller, body: any): Answer {
  const pay = db
    .prepare(`select * from payments where ${PAID} and mode = ? and number = ?`)
    .get(FRONT, c.mode, numberOf(body.number)) as any;
  const want = Buffer.from(pay ? orderKey(pay.id) : ''),
    got = Buffer.from(String(body.key ?? ''));
  if (!pay || got.length !== want.length || !timingSafeEqual(got, want))
    return [404, 'no order with this number and key', 'no_order'];
  return { order: orderOf(pay, langOf(body)) };
}
const langOf = (body: any) => (typeof body.lang === 'string' && /^[a-z]{2}$/.test(body.lang) ? body.lang : 'en');
function orderOf(pay: any, lang: string) {
  const lines = payments.paidLines(pay.id).filter(line => line.session === pay.id);
  const wholly = pay.refund_status === 'succeeded';
  const refunded = (line: payments.Line) => wholly || line.refund_status === 'succeeded';
  const thing = lines.find(line => !line.goes_with);
  return {
    session: pay.id,
    number: pay.number ?? null,
    paid_at: lines.map(line => line.paid_at!).sort()[0] ?? null,
    country: pay.country ?? null,
    total: lines.reduce((n, line) => n + (line.card ?? 0), 0),
    refunded: lines.length > 0 && lines.every(refunded),
    invoice: thing && invoiceLink.of ? invoiceLink.of(thing, lang) : null,
    lines: lines.map(line => lineOf(line, refunded(line))),
  };
}
function lineOf(line: payments.Line, refunded: boolean) {
  const parcel = payments.lineParts.map(part => part(line)?.parcel as { status: string } | undefined).find(Boolean);
  const words = line.description
    ? { description: line.description, detail: line.detail, order_url: line.order_url }
    : {};
  return {
    line: line.id,
    product: line.product,
    shop: payments.shopName(line.product),
    number: line.number,
    amount: line.card ?? 0,
    quantity: line.quantity,
    refunded,
    status: parcel?.status ?? 'paid',
    kept_until: line.kept_until,
    ...words,
    ...(line.description && line.picture ? { picture: line.picture } : {}),
  };
}
