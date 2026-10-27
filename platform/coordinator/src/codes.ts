// The shop's codes: something off a later basket, given after an order. A code is a word from the shop's list and four
// digits ("OTTER 4827"), easy to read off paper and to type. Each belongs to a paid basket (an order), at most one of
// each kind per order: its own (`order`), a thank-you once someone new pays with that one (`thanks`), and one for a
// small flaw (`flaw`), which may carry a cap in cents. A basket holds one code. It never takes anything off a line at
// its offer price, and it works on what each line costs after the line's voucher. The shop's settings are the front's
// manifest's `codes:`, with each kind's size: a percent off each line, or an amount off a basket from a minimum
// (counted on the lines not on offer), spread over those lines by what they cost:
//   codes: {months: 3, words: code-words.txt, card: true,
//           order: {off: 500, minimum: 3000}, thanks: {percent: 10}, flaw: {percent: 10}}
// words: a file in the front's folder, one word a line. card: whether a printed card goes in each parcel, read by the
// company's own parcel tool. A code keeps the size it was given with, whatever the settings say later.
//
// The front's routes, with its payments token (payments.ts's headers):
//   POST /api/pay/basket/code        {basket, code, country?}  the basket's code (a new one replaces the old)
//   POST /api/pay/basket/code/remove {basket, country?}        the basket without one
// Both answer the basket's view. A refusal carries `why`: code_unknown, code_used, code_expired, code_in_use (held by
// another basket's open checkout), code_minimum (the basket's lines not on offer come to less than the code needs) or
// code_tries (429), or the basket's own (basket_gone, already_paid); a code_minimum carries the code's `minimum`
// (cents); a stall's voucher's: voucher_used, voucher_expired, voucher_gone (refunded, or its refund still with a
// person), voucher_cheaper (worth more than its stall's lines here), voucher_no_line (none of its stall's without a
// voucher, with the stall's name in `shop`) or voucher_second (each such line's order has another voucher already). A
// code that goes bad in a basket (used elsewhere, expired, or under its minimum once a line went out) leaves it, and
// the view says so until another code goes in or the code is removed: code_dropped {code, why}.
//
// The life of a basket's code: opening a checkout holds it for that session, and another basket can't take it while
// the session can still be paid. The payment marks it used in the same step as the basket's lines. A session that ends
// unpaid holds nothing: a hold counts only while its session is open. A code that expires while held still goes through
// if that session is paid.
//
// A gift card goes in the same box too (payments.ts basketGift), beside the code: it pays what's left.
// A stall's voucher goes in the same box too (payments.ts payLineByVoucher): it pays that stall's line, never the basket,
// so it sits next to a code; a wrong one counts as a wrong code.
//
// The shop's test code (payments.ts isTestCode) goes in the same box and takes the
// code's place: the basket becomes a test order (another code, or removing it, makes it a real one again). A test order
// gets no code of its own. So does a tester's voucher, in a test basket (payments.ts testerVoucher): a tester's order.
// That one does get a code of its own, a live one, since its parcel goes for real and the tester judges the whole parcel
// (its card too): the live shop takes it as any order's. It stays out of the rest: its payer gets no buyer key (so a tester
// stays a newcomer to the live shop), it earns no thank-you code, and Numbers doesn't count its code's use.
//
// When a basket is paid, its payer gets a buyer key: a keyed hash of the email Stripe has, never the email itself, kept
// with the days of the payer's first and last order and deleted 12 months after the last. A payer with no paid order in
// the 12 months before is a newcomer. The order gets its own code, and a code of another order's that a newcomer used
// earns that order's buyer a thank-you code. Numbers counts the paid baskets whose payer isn't a newcomer
// (payments.ts basketsByDay).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { REPO_DIR } from './config.ts';
import { db, inOneStep } from './db.ts';
import { FRONT } from './approvals.ts';
import { companyDay } from './company.ts';
import * as payments from './payments.ts';
import type { Caller, Line, Refused, ShownCode } from './payments.ts';
import { manifest } from './manifests.ts';

export type CodeKind = 'order' | 'thanks' | 'flaw';
export type CodeStatus = 'unused' | 'held' | 'used';
export type CodeView = {
  id: number;
  kind: CodeKind;
  code: string;
  session: string;
  mode: 'test' | 'live';
  lang: string | null;
  percent: number | null;
  off: number | null;
  minimum: number;
  cap: number | null;
  issued: string;
  until: string;
  status: CodeStatus;
  used_at: string | null;
};
// A kind's size: a percent off each line, or an amount off (cents); either from a minimum (cents, 0 for none).
export type CodeSize = { percent: number | null; off: number | null; minimum: number };
export type CodeSettings = {
  months: number;
  words: string[];
  card: boolean;
  kinds: Partial<Record<CodeKind, CodeSize>>;
};

// ---- storage
// codes: every code given. session: the order it belongs to. held_by: the checkout session holding it (a hold counts
// while that session is open). used_by: the paid session that used it, with whether its payer was a newcomer (null:
// not known yet). told: when the codeIssued hooks heard of it.
db.exec(`create table if not exists codes (id integer primary key, mode text not null, code text not null,
  kind text not null, session text not null, lang text, percent integer, off integer, minimum integer not null,
  cap integer, issued text not null,
  until text not null, held_by text, used_by text, used_at text, newcomer integer, told text,
  unique (mode, code), unique (session, kind))`);
// The code each open basket has. A code can sit in two baskets: only a checkout holds it. dropped: why it left the
// basket on its own (it went bad, or the basket fell under its minimum), shown until another code goes in.
db.exec('create table if not exists basket_codes (basket text primary key, code integer not null, dropped text)');
// A paid basket, as the codes see it: its day and language, its payer's buyer key while its own code can be used (the
// thank-you rule needs it), whether that payer was a newcomer, and when its codes were done.
db.exec(`create table if not exists code_orders (session text primary key, mode text not null, paid text not null,
  lang text, buyer text, newcomer integer, done text)`);
db.exec(`create table if not exists code_buyers (buyer text not null, mode text not null, first text not null,
  last text not null, primary key (buyer, mode))`);

type CodeRow = Omit<CodeView, 'status'> & {
  held_by: string | null;
  used_by: string | null;
  newcomer: number | null;
  told: string | null;
};
type OrderRow = {
  session: string;
  mode: 'test' | 'live';
  paid: string;
  lang: string | null;
  buyer: string | null;
  newcomer: number | null;
  done: string | null;
};

const codeRow = (id: number) => db.prepare('select * from codes where id = ?').get(id) as CodeRow | undefined;
const orderRow = (session: string) =>
  db.prepare('select * from code_orders where session = ?').get(session) as OrderRow | undefined;

// ---- the shop's settings
let wordCache: { path: string; changed: number; words: string[] } | null = null;
const complained = new Set<string>();

// The front's manifest's `codes:`, or null when the shop gives no codes (or its settings don't hold: logged once).
export function codeSettings(): CodeSettings | null {
  const setting = manifest(FRONT)?.codes as Record<string, unknown> | undefined;
  if (!setting || typeof setting !== 'object') return null;
  const months = setting.months;
  if (!Number.isInteger(months) || (months as number) < 1 || (months as number) > 24)
    return refuseSettings('codes.months: a whole number from 1 to 24');
  const words = wordsOf(setting.words);
  if (words.length < 100) return refuseSettings("codes.words: a file in the front's folder with 100 words or more");
  const kinds: CodeSettings['kinds'] = {};
  for (const kind of KINDS) {
    if (setting[kind] === undefined) continue;
    const size = sizeOf(setting[kind]);
    if (!size) return refuseSettings(`codes.${kind}: {percent: 1 to 100} or {off: cents}, either with minimum: cents`);
    kinds[kind] = size;
  }
  return { months: months as number, words, card: setting.card === true, kinds };
}

const KINDS: CodeKind[] = ['order', 'thanks', 'flaw'];
const cents = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

function sizeOf(setting: any): CodeSize | null {
  if (!setting || typeof setting !== 'object') return null;
  const { percent = null, off = null, minimum = 0 } = setting;
  if (!cents(minimum) || (percent === null) === (off === null)) return null;
  if (percent !== null && (!Number.isInteger(percent) || percent < 1 || percent > 100)) return null;
  if (off !== null && (!cents(off) || off < 1)) return null;
  return { percent, off, minimum };
}

function refuseSettings(why: string) {
  if (!complained.has(why)) payments.log(`the shop's codes are off: ${why}.`);
  complained.add(why);
  return null;
}

// The word list: one a line, 2 to 12 letters A to Z, any case (kept in capitals), each once.
function wordsOf(file: unknown): string[] {
  const folder = posix.normalize(`${REPO_DIR}/products/${FRONT}`);
  const path = typeof file === 'string' ? posix.normalize(`${folder}/${file}`) : '';
  if (!path.startsWith(`${folder}/`)) return [];
  let changed: number;
  try {
    changed = statSync(path).mtimeMs;
  } catch {
    return [];
  }
  if (wordCache?.path === path && wordCache.changed === changed) return wordCache.words;
  const lines = readFileSync(path, 'utf8').split('\n');
  const words = [...new Set(lines.map(line => line.trim().toUpperCase()).filter(word => /^[A-Z]{2,12}$/.test(word)))];
  wordCache = { path, changed, words };
  return words;
}

// ---- dates: a code runs to the end of its last day, in the company's time zone (companyDay)

// The last day of the month `months` after the given day's: given 17 October 2026 with 3, 31 January 2027.
export function untilOf(given: string, months: number) {
  const [year, month] = given.split('-').map(Number);
  const last = new Date(Date.UTC(year, month - 1 + months + 1, 0));
  return last.toISOString().slice(0, 10);
}

// The end date a code given at time t gets, under the shop's settings.
export function untilFor(t = Date.now()) {
  const settings = codeSettings();
  if (!settings) throw new Error("The shop gives no codes (the front's manifest has no usable codes: settings)");
  return untilOf(companyDay(t), settings.months);
}

// The same day a year earlier (29 February: the 28th).
function yearBefore(given: string) {
  const [year, month, date] = given.split('-').map(Number);
  const last = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return `${year - 1}-${String(month).padStart(2, '0')}-${String(Math.min(date, last)).padStart(2, '0')}`;
}

const expired = (code: CodeRow, t = Date.now()) => companyDay(t) > code.until;

// ---- codes: made, read and given
// What someone typed, as the code is kept: capitals, the word and the digits split by one space. Spaces and dashes
// anywhere are ignored, so "otter4827" and "Otter - 4827" are both "OTTER 4827".
export function normalCode(typed: unknown) {
  const squeezed = payments.squeezedCode(String(typed ?? '').slice(0, 40));
  const parts = /^([A-Z]{2,12})(\d{4})$/.exec(squeezed);
  return parts ? `${parts[1]} ${parts[2]}` : null;
}

export function codeOf(session: string, kind: CodeKind): CodeView | null {
  const code = db.prepare('select * from codes where session = ? and kind = ?').get(session, kind) as
    CodeRow | undefined;
  return code ? view(code) : null;
}

function view(code: CodeRow): CodeView {
  const held = !!code.held_by && sessionOpen(code.held_by);
  const status: CodeStatus = code.used_by ? 'used' : held || openingNow.has(code.id) ? 'held' : 'unused';
  const { id, kind, session, mode, lang, percent, off, minimum, cap, issued, until, used_at } = code;
  return { id, kind, code: code.code, session, mode, lang, percent, off, minimum, cap, issued, until, status, used_at };
}

// Hooks that hear every code given (a company's thank-you email, say), after it's stored. At least once: a code given
// just before a stop is told again at the next tick, so a hook keys what it does by the code's id.
export const codeIssued: ((code: CodeView) => void)[] = [];

// The order's code of a kind, given once: asked again, the first answers. Only a paid basket's session is an order.
// cap: the most it takes off, in cents. lang: for an order paid before codes existed (an order's own language wins).
export function issueCode(kind: CodeKind, session: string, options: { cap?: number; lang?: string } = {}): CodeView {
  const known = codeOf(session, kind);
  if (known) return known;
  const code = giveCode(kind, session, options);
  tell();
  return view(codeRow(code)!);
}

// Writes the code (no hooks told yet): the caller tells them once its own step is stored. Its id.
function giveCode(kind: CodeKind, session: string, options: { cap?: number; lang?: string }) {
  const pay = db
    .prepare("select * from payments where id = ? and basket is not null and status = 'paid'")
    .get(session) as { mode: 'test' | 'live' } | undefined;
  if (!pay) throw new Error(`Codes belong to a paid basket, and ${session} isn't one`);
  // a tester's order (test mode) has an order code the live shop knows; any other kind stays in the order's mode
  const mode = kind === 'order' && payments.isTesterOrder(session) ? 'live' : pay.mode;
  const cap = options.cap ?? null;
  if (cap !== null && (!Number.isInteger(cap) || cap < 1))
    throw new Error("A code's cap is a whole number of cents, 1 or more");
  const settings = codeSettings();
  if (!settings) throw new Error("The shop gives no codes (the front's manifest has no usable codes: settings)");
  const size = settings.kinds[kind];
  if (!size) throw new Error(`The shop gives no ${kind} codes (the front's manifest names no codes.${kind})`);
  const known = db.prepare('select id from codes where session = ? and kind = ?').get(session, kind) as
    { id: number } | undefined;
  if (known) return known.id;
  const given = companyDay(Date.now());
  const lang = orderRow(session)?.lang ?? options.lang ?? null;
  const insert =
    db.prepare(`insert into codes (mode, code, kind, session, lang, percent, off, minimum, cap, issued, until)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (mode, code) do nothing`);
  // A new word and number until one is free in this mode: 500 words make 5 million codes, so a clash is rare.
  for (let tries = 0; tries < 50; tries++) {
    const word = settings.words[randomInt(settings.words.length)];
    const digits = String(randomInt(10_000)).padStart(4, '0');
    const until = untilOf(given, settings.months);
    const { percent, off, minimum } = size;
    const inserted = insert.run(
      mode,
      `${word} ${digits}`,
      kind,
      session,
      lang,
      percent,
      off,
      minimum,
      cap,
      given,
      until,
    );
    if (inserted.changes) return Number(inserted.lastInsertRowid);
  }
  throw new Error(`No free code after 50 tries in ${mode}: the word list is too short for the codes given`);
}

// Tells the hooks about every code they haven't heard of yet.
function tell() {
  for (const code of db.prepare('select * from codes where told is null order by id').all() as CodeRow[]) {
    for (const hook of codeIssued) {
      try {
        hook(view(code));
      } catch (err) {
        console.error(`Codes: a code-issued hook failed on code ${code.id}:`, err);
      }
    }
    db.prepare('update codes set told = ? where id = ?').run(new Date().toISOString(), code.id);
  }
}

// ---- a basket's code
// Wrong codes a basket may try in an hour, and all of a shop's baskets together (per mode). A person mistyping stays
// far below both. The shop's limit is the one a script meets, since a script can make new baskets. With 500 words there
// are 5 million codes: if 2,000 of them are out, 30 guesses an hour find one about every 3 days, worth a 10% saving.
// A script that runs into the limit also stops real customers' codes for the hour, which is cheaper than a code given
// away every hour. Only an unknown code counts: a used or expired one is a real code typed late.
const BASKET_MISSES = 10;
const SHOP_MISSES = 30;
const HOUR_MS = 3_600_000;
const misses = new Map<string, number[]>();

async function enterCode(c: Caller, body: any) {
  const basket = payments.ownBasket(c, body.basket);
  if (!basket) return [404, 'no such basket', 'basket_gone'] as Refused;
  const recent = (key: string) => (misses.get(key) ?? []).filter(t => t > Date.now() - HOUR_MS);
  const keys = [`${c.mode}:${basket.id}`, c.mode];
  if (recent(keys[0]).length >= BASKET_MISSES || recent(keys[1]).length >= SHOP_MISSES)
    return [429, 'too many wrong codes this hour: try again later', 'code_tries'] as Refused;
  if (payments.isTestCode(body.code)) {
    const markAsTestOrder = (id: string) => {
      db.prepare('delete from basket_codes where basket = ?').run(id);
      payments.markTest(id, true);
    };
    return payments.changeBasket(c, basket.id, markAsTestOrder, body.country);
  }
  // a tester's voucher (payments.ts testerVoucher), on the preview's test baskets only: it takes the code's place too.
  const tester = c.mode === 'test' ? payments.testerVoucher.find?.(body.code) : undefined;
  if (tester) {
    const refused = payments.testerVoucher.unusable?.(tester);
    if (refused) return refused;
    const markAsTesterOrder = (id: string) => {
      const now = payments.testerVoucher.unusable?.(tester);
      if (now) return now;
      db.prepare('delete from basket_codes where basket = ?').run(id);
      payments.markTester(id, tester);
    };
    return payments.changeBasket(c, basket.id, markAsTesterOrder, body.country);
  }
  const typed = codeSettings() ? normalCode(body.code) : null;
  const found = typed ? findCode(c.mode, typed) : undefined;
  if (!found) {
    // a gift card goes in the same box, beside the basket's code (payments.ts basketGift)
    const byGift = await payments.basketGift.enter?.(c, basket.id, body.code, body.country);
    if (byGift) return byGift;
    // a stall's voucher goes in the same box and pays its line
    const byVoucher = await payments.payLineByVoucher(c, basket.id, body.code, body.country);
    if (byVoucher) return byVoucher;
    for (const key of keys) misses.set(key, [...recent(key), Date.now()]);
    return [404, 'no such code', 'code_unknown'] as Refused;
  }
  await refreshHolder(found, basket.id);
  const refused = unusableFor(found.id, basket.id) ?? underMinimum(found, basket.id);
  if (refused) return refused;
  if (basketCodeRow(basket.id)?.id === found.id) return payments.basketView(c, basket.id, body.country);
  const put = (id: string) => {
    const why = unusableFor(found.id, id) ?? underMinimum(found, id);
    if (why) return why;
    db.prepare(
      `insert into basket_codes (basket, code) values (?, ?)
       on conflict (basket) do update set code = excluded.code, dropped = null`,
    ).run(id, found.id);
    payments.markTest(id, false);
  };
  return payments.changeBasket(c, basket.id, put, body.country);
}

async function removeCode(c: Caller, body: any) {
  const basket = payments.ownBasket(c, body.basket);
  if (!basket) return [404, 'no such basket', 'basket_gone'] as Refused;
  const row = db.prepare('select * from basket_codes where basket = ?').get(basket.id) as
    { dropped: string | null } | undefined;
  if (!row && (payments.isTestBasket(basket.id) || payments.testerOf(basket.id)))
    return payments.changeBasket(c, basket.id, id => void payments.markTest(id, false), body.country);
  if (!row) return payments.basketView(c, basket.id, body.country);
  if (row.dropped) {
    db.prepare('delete from basket_codes where basket = ?').run(basket.id); // in no checkout: nothing to end
    return payments.basketView(c, basket.id, body.country);
  }
  const remove = (id: string) => void db.prepare('delete from basket_codes where basket = ?').run(id);
  return payments.changeBasket(c, basket.id, remove, body.country);
}

const findCode = (mode: string, code: string) =>
  db.prepare('select * from codes where mode = ? and code = ?').get(mode, code) as CodeRow | undefined;
const basketCodeRow = (basket: string) =>
  db
    .prepare('select c.* from basket_codes b join codes c on c.id = b.code where b.basket = ? and b.dropped is null')
    .get(basket) as CodeRow | undefined;
const drop = (basket: string, why: string) =>
  db.prepare('update basket_codes set dropped = ? where basket = ?').run(why, basket);
function droppedFrom(basket: string) {
  const row = db
    .prepare('select c.code, b.dropped why from basket_codes b join codes c on c.id = b.code where b.basket = ?')
    .get(basket) as { code: string; why: string | null } | undefined;
  return row?.why ? { code: row.code, why: row.why } : null;
}

// Why this basket can't take the code now, or null when it can. A code held by this basket's own open session stays
// good past its end date: that session may still be paid.
function unusableFor(id: number, basket: string): Refused | null {
  const code = codeRow(id)!;
  if (code.used_by) return [409, 'this code has been used', 'code_used'];
  const holder = holderBasket(code);
  if (holder === basket) return null;
  if (holder) return [409, "this code is in another basket's checkout", 'code_in_use'];
  if (expired(code)) return [409, 'this code has passed its end date', 'code_expired'];
  return null;
}

// The basket whose checkout holds the code: one opening now, or one whose session can still be paid.
function holderBasket(code: CodeRow): string | null {
  const opening = openingNow.get(code.id);
  if (opening) return opening;
  if (!code.held_by || !sessionOpen(code.held_by)) return null;
  const pay = db.prepare('select basket from payments where id = ?').get(code.held_by) as { basket: string };
  return pay.basket;
}

const sessionOpen = (session: string) =>
  !!db.prepare("select 1 from payments where id = ? and status in ('open', 'complete')").get(session);

// A hold by another basket's session counts only while Stripe still has that session open: read it first.
async function refreshHolder(code: CodeRow, basket: string) {
  if (!code.held_by || !sessionOpen(code.held_by)) return;
  const pay = db.prepare('select * from payments where id = ?').get(code.held_by) as any;
  if (pay.basket !== basket) await payments.readSession(pay);
}

// What the lines not on offer cost after their vouchers: what a code's amount off counts on.
const countsFor = (lines: { line: Line; due: number }[]) =>
  lines.map(({ line, due }) => (line.offer ? 0 : Math.max(due, 0)));
const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);
// What a code's minimum counts: the lines not on offer at their price, before their vouchers, since a voucher pays for a
// line rather than taking anything off it
// (the shop's own lines going with a thing count for nothing; a line counts each of its copies)
const towardMinimum = (lines: Line[]) =>
  sum(lines.map(line => (line.offer || line.goes_with ? 0 : line.amount * line.quantity)));

function underMinimum(code: CodeRow, basket: string): Refused | null {
  if (towardMinimum(payments.basketLines(basket)) >= code.minimum) return null;
  return [
    409,
    `this code is for a basket from ${code.minimum} cents, not counting things on offer`,
    'code_minimum',
    { minimum: code.minimum },
  ];
}

// What the basket's code takes off each line, in basket order, rounded down per line. A percent takes its share of
// each line not on offer. An amount off is spread over those lines by what they cost, its cents left by rounding
// on the first that has room, never more than a line costs. A cap stops either, in basket order. A basket under the
// code's minimum, or one the code went bad in, loses the code.
function off(basket: string, lines: { line: Line; due: number }[]) {
  const code = basketCodeRow(basket);
  const counts = countsFor(lines);
  if (!code) return lines.map(() => 0);
  const why =
    unusableFor(code.id, basket) ??
    (towardMinimum(lines.map(({ line }) => line)) < code.minimum ? 'code_minimum' : null);
  if (why) {
    drop(basket, typeof why === 'string' ? why : why[2]!);
    return lines.map(() => 0);
  }
  const savings =
    code.percent !== null ? counts.map(d => Math.floor((d * code.percent!) / 100)) : spread(code.off!, counts);
  let left = code.cap ?? Infinity;
  return savings.map(saving => {
    const taken = Math.min(saving, left);
    left -= taken;
    return taken;
  });
}

function spread(amount: number, counts: number[]) {
  const base = sum(counts);
  const total = Math.min(amount, base);
  const shares = counts.map(d => (base ? Math.floor((total * d) / base) : 0));
  let rest = total - sum(shares);
  return shares.map((share, i) => {
    const added = Math.min(counts[i] - share, rest);
    rest -= added;
    return share + added;
  });
}

const shownCode = (code: CodeRow): ShownCode => ({
  code: code.code,
  kind: code.kind,
  until: code.until,
  percent: code.percent,
  off: code.off,
  minimum: code.minimum,
  cap: code.cap,
});

// The code to show: an open basket's while it can take it, or the one a session holds or used.
function shown(where: { basket?: string; session?: string }): ShownCode | null {
  if (where.session) {
    const code = db
      .prepare('select * from codes where used_by = ? or (used_by is null and held_by = ?)')
      .get(where.session, where.session) as CodeRow | undefined;
    return code ? shownCode(code) : null;
  }
  const code = basketCodeRow(where.basket!);
  return code && !unusableFor(code.id, where.basket!) ? shownCode(code) : null;
}

async function refreshBasket(basket: string) {
  const code = basketCodeRow(basket);
  if (code) await refreshHolder(code, basket);
}

// Before a checkout: a code gone bad since it went in (used, expired, in another checkout, or under its minimum)
// leaves the basket, and the checkout is refused with why, so the shop shows the basket again without it.
// A code past its end date that this basket's open session holds stays in the basket for that session alone: a new
// session is refused it.
function unusable(basket: string): Refused | null {
  const code = basketCodeRow(basket);
  if (!code) return null;
  const why = unusableFor(code.id, basket) ?? underMinimum(code, basket);
  if (why) drop(basket, why[2]!);
  if (!why && expired(code)) return [409, 'this code has passed its end date', 'code_expired'];
  return why;
}

// Holds the basket's code from now (while Stripe is asked for the session) and then for the session that opens.
const openingNow = new Map<number, string>();
function hold(basket: string) {
  const code = basketCodeRow(basket)!;
  openingNow.set(code.id, basket);
  return {
    held: (session: string) => void db.prepare('update codes set held_by = ? where id = ?').run(session, code.id),
    release: () => void (openingNow.get(code.id) === basket && openingNow.delete(code.id)),
  };
}

// The basket's payment, in the same step as its lines: the code its session held is used, the basket's code goes, and
// the order is noted for the rest (finishOrder, once Stripe's session is in hand).
function paid(pay: any) {
  const now = new Date().toISOString();
  const code = db.prepare('select * from codes where held_by = ? and used_by is null').get(pay.id) as
    CodeRow | undefined;
  if (code) db.prepare('update codes set used_by = ?, used_at = ? where id = ?').run(pay.id, now, code.id);
  db.prepare('delete from basket_codes where basket = ?').run(pay.basket);
  if (!codeSettings()) return;
  db.prepare('insert into code_orders (session, mode, paid) values (?, ?, ?) on conflict (session) do nothing').run(
    pay.id,
    pay.mode,
    companyDay(Date.parse(now)),
  );
}

payments.basketCode.off = off;
payments.basketCode.shown = shown;
payments.basketCode.dropped = droppedFrom;
payments.basketCode.refresh = refreshBasket;
payments.basketCode.unusable = unusable;
payments.basketCode.hold = hold;
payments.basketCode.paid = paid;
payments.basketBuyer.returning = session => {
  const newcomer = orderRow(session)?.newcomer;
  return newcomer == null ? null : newcomer === 0;
};

// ---- once a basket is paid: its buyer, its own code, and a thank-you
payments.basketPaid.push((pay, session) => finishOrder(pay.id, session));
// A paid basket's records ending (records.ts) end its codes' record of it and the codes it was given
payments.recordsEnded.push(session => {
  for (const table of ['code_orders', 'codes']) db.prepare(`delete from ${table} where session = ?`).run(session);
});

// What a paid order's codes need from Stripe's session (its payer's email, its language), in one step: the buyer key
// and whether the payer is a newcomer, the use of the code it paid with, its own code, and a thank-you for the order
// whose code a newcomer used. Done once: a retry after a stop finds it done.
export function finishOrder(id: string, session: any) {
  const order = orderRow(id);
  const settings = codeSettings();
  if (!order || order.done || !settings) return;
  // a tester's order: its code, and nothing kept of its payer
  const tester = payments.isTesterOrder(id);
  inOneStep(() => {
    const { buyer, newcomer } =
      tester || order.newcomer !== null ? order : noteBuyer(order, session?.customer_details?.email);
    const lang = payments.langOf(session?.locale);
    db.prepare('update code_orders set buyer = ?, newcomer = ?, lang = ? where session = ?').run(
      buyer,
      newcomer,
      lang,
      id,
    );
    db.prepare('update codes set newcomer = ? where used_by = ?').run(newcomer, id);
    if (settings.kinds.order) giveCode('order', id, {});
    const used = db.prepare('select * from codes where used_by = ?').get(id) as CodeRow | undefined;
    const referrer =
      used?.kind === 'order' && !payments.isTesterOrder(used.session) ? orderRow(used.session) : undefined;
    const thanked = referrer && newcomer === 1 && buyer !== referrer.buyer;
    if (thanked && settings.kinds.thanks) giveCode('thanks', referrer.session, {});
    db.prepare('update code_orders set done = ? where session = ?').run(new Date().toISOString(), id);
  });
  tell();
}

// The payer's buyer key, and whether they had no paid order in the 12 months before this one. No email (Stripe
// always has one for a paid session): nothing is known, so no newcomer.
function noteBuyer(order: OrderRow, email: unknown) {
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!address) return { buyer: null, newcomer: null };
  const buyer = payments.signed(`buyer:${address}`);
  const known = db.prepare('select * from code_buyers where buyer = ? and mode = ?').get(buyer, order.mode) as
    { first: string; last: string } | undefined;
  const newcomer = !known || known.last <= yearBefore(order.paid) ? 1 : 0;
  db.prepare(
    `insert into code_buyers (buyer, mode, first, last) values (?, ?, ?, ?) on conflict (buyer, mode) do update set
     first = case when ? then excluded.first else first end, last = max(last, excluded.last)`,
  ).run(buyer, order.mode, order.paid, order.paid, newcomer);
  return { buyer, newcomer };
}

// ---- the count: codes used per day, and how many by newcomers
export function usedByDay(mode: 'test' | 'live', from: string, to: string) {
  const used = db
    .prepare('select kind, session, used_at, newcomer from codes where mode = ? and used_by is not null')
    .all(mode) as {
    kind: CodeKind;
    session: string;
    used_at: string;
    newcomer: number | null;
  }[];
  const days = new Map<string, { day: string; kind: CodeKind; newcomer: number; all: number }>();
  for (const code of used) {
    if (payments.isTesterOrder(code.session)) continue; // a tester's card
    const usedOn = companyDay(Date.parse(code.used_at));
    if (usedOn < from || usedOn > to) continue;
    const key = `${usedOn}:${code.kind}`;
    const count = days.get(key) ?? { day: usedOn, kind: code.kind, newcomer: 0, all: 0 };
    count.all += 1;
    count.newcomer += code.newcomer === 1 ? 1 : 0;
    days.set(key, count);
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind));
}

// ---- every few minutes: what a stop left undone, and what the privacy pages promise to delete
// - a paid order whose codes weren't done (its basket-paid hook failed, or HQ stopped) is done now;
// - a code the hooks haven't heard of is told;
// - a buyer key goes 12 months after its last order, and an order's own copy once its code can't be used any more
//   (its end date, and a day for a session held then);
// - the code of a basket that's gone (paid, or deleted unpaid) leaves it.
const RETRY_DAYS = 7;
export async function tick(now = Date.now()) {
  for (const [key, times] of misses) if (!times.some(t => t > now - HOUR_MS)) misses.delete(key);
  const unfinished = db
    .prepare('select * from code_orders where done is null and paid >= ?')
    .all(companyDay(now - RETRY_DAYS * 86_400_000));
  for (const order of codeSettings() ? (unfinished as OrderRow[]) : []) {
    try {
      finishOrder(order.session, await payments.sessionOf(order.mode, order.session));
    } catch (err) {
      console.error(`Codes: could not finish the codes of order ${order.session}:`, err);
    }
  }
  tell();
  const today = companyDay(now);
  const dayBefore = companyDay(now - 86_400_000);
  db.prepare('delete from code_buyers where last <= ?').run(yearBefore(today));
  db.prepare(
    `update code_orders set buyer = null where buyer is not null and done is not null and (paid <= ? or exists
     (select 1 from codes where codes.session = code_orders.session and kind = 'order' and until < ?))`,
  ).run(yearBefore(today), dayBefore);
  db.prepare("delete from basket_codes where basket not in (select id from baskets where status = 'open')").run();
}
export const start = () => {
  setInterval(() => tick().catch(err => console.error('Codes: the check failed:', err)), 5 * 60_000);
};

// ---- the routes
export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const route = `${req.method} ${url.pathname}`;
  const asked = await payments.productRequest(req, res, { post: true });
  if (!asked) return;
  const { caller: c, body } = asked;
  try {
    const answer =
      c.slug !== FRONT
        ? ([403, "baskets are the shop's (the front's)"] as Refused)
        : route === 'POST /api/pay/basket/code'
          ? await enterCode(c, body)
          : route === 'POST /api/pay/basket/code/remove'
            ? await removeCode(c, body)
            : ([404, 'not found'] as Refused);
    if (!Array.isArray(answer)) return payments.json(res, 200, answer);
    return payments.refusal(res, answer);
  } catch (err) {
    if (err instanceof payments.StripeError) return payments.json(res, err.status, { error: err.message });
    throw err;
  }
}
