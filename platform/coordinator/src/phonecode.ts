// The code a caller on the shop's phone line reads back to the care service's phone agent, emailed to the payer of
// the order they named, so the agent may read that one order to them.
//
//   POST /api/pay/code {order, code, lang, email?} → {order, status: 'sent', test_email?: {to, subject, text, html?}}
//     Same headers and token as the rest of /api/pay (payments.ts). A stall asks only for one of its own paid orders and
//     answers the care service the same whatever happened here, so the answer may say what went wrong:
//     400 a field, 409 not paid (or paid from an address HQ can't vouch for), 429 toomany, 503 no email service.
//
// - The address is Stripe's, found as order emails find it (ordermail.ts payment): the payer of the order's paid
//   session, or of the basket that paid its line. Never returned, logged or kept. `email` is only the customer's own
//   address the stall holds, for an order a voucher paid (the voucher's payer must be the same).
// - The words are the front's, the shop's own: products/<front>/care/phone-code-email.yaml, per language a subject and
//   a body with {code} and {minutes}, in email-look.yaml's look beside them. The care service makes and checks the code;
//   HQ only carries it.
// - At most CODES_A_DAY emails per order a day here too, whatever the care service counts, so someone reading order
//   numbers down the phone can't fill a customer's inbox.
// - One email per basket for one ask: a shop's order number names each stall's order paid in its basket, and the care
//   service asks every stall at once, each with its own code. The first stall's code goes; another stall asking for the
//   same payment within ROUND_MS gets the same answer and nothing is emailed. A stall's own new ask still emails
// - Test mode without the email service renders the email back (test_email), as order emails do.
//
//   POST /api/pay/answer {key, order, answer, lang, email?} → {order, status: 'sent', test_email?}   The answer a caller asked for by email
//     after the call, which the care service wrote: to
//     the same address, found the same way, in products/<front>/care/phone-answer-email.yaml's words with {answer} (plain
//     text) and {order_page} (the basket's order page, its line left out for an order paid on its own). It carries the AI
//     mark (AI-Disclosure), and a reply goes to the inbox (hello@), where a person reads it. At most ANSWERS_A_DAY an
//     order a day; the same refusals as the code's. key: the care service's own for the answer (its call and the order),
//     kept with its email's row: the same key again, after a lost reply, gets what the first ask did and sends nothing
//     (a 409 for one the email service refused, a 502 for one that may have gone).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, once, columnsOf } from './db.ts';
import { FRONT } from './approvals.ts';
import { yamlFile } from './company.ts';
import * as payments from './payments.ts';
import { payment } from './ordermail.ts';
import { orderPage } from './basketwords.ts';
import * as mailout from './mailout.ts';
import * as mailpage from './mailpage.ts';

const DAY_MS = 24 * 3_600_000;
// A caller needs one code, and a retry or two: more is someone with an order number filling its customer's inbox.
const CODES_A_DAY = 3;
// the care service asks once a call for an order, its questions in one email, and three asks an order a day
const ANSWERS_A_DAY = 3;
const CODE_MINUTES = 10; // the care service's code lifetime (platform/care README, "The phone")
// the care service asks a round's stalls one after another without waiting, so their asks land well within this; a
// new round (the caller asks again) is further apart, or all its stalls would see the last round's email and send none
const ROUND_MS = 10_000;
const REF = /^[A-Za-z0-9_-]{1,64}$/,
  KEY = /^[A-Za-z0-9:_-]{1,128}$/,
  CODE = /^[0-9]{6}$/,
  LANG = /^[a-z]{2}$/;
const ANSWER_MAX = 8000;
// the model wrote the answer (AI Act art. 50(2)): the care service's mark (platform/care/src/email.ts AI_HEADERS)
const AI_HEADERS = { 'AI-Disclosure': 'mode=machine-generated' };

// payment: the Stripe session that paid the order, a basket's for its lines.
// kind: 'answer' for an answer after the call, null for a code; an answer's ask (the care service's key) and outcome:
// 'sent', 'refused' (the email service's 400), 'unsure' (its other failures), null while it goes or if HQ stopped
// halfway
db.exec(`create table if not exists phone_code_emails (product text not null, mode text not null,
  reference text not null, ts integer not null, payment text, kind text, ask text, outcome text)`);
once('2026-10-21-phone-answers', () => {
  for (const column of ['kind', 'ask', 'outcome'])
    if (!columnsOf('phone_code_emails').includes(column))
      db.exec(`alter table phone_code_emails add column ${column} text`);
});

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const asked = await payments.productRequest(req, res, { post: true });
  if (!asked) return;
  const { caller: c, body } = asked;
  try {
    const asked = new URL(req.url ?? '/', 'http://x').pathname === '/api/pay/answer' ? emailAnswer : emailCode;
    return payments.reply(res, await asked(c, body));
  } catch (err) {
    if (err instanceof payments.StripeError) return payments.json(res, err.status, { error: err.message });
    throw err;
  }
}

// One order's asks wait their turn (payments.ts serial), so parallel asks can't all pass the day's count
export function emailCode(c: payments.Caller, body: any): Promise<payments.Refused | object> {
  const order = String(body.order ?? ''),
    code = String(body.code ?? ''),
    lang = String(body.lang ?? 'en');
  if (!REF.test(order)) return Promise.resolve([400, 'order: 1-64 letters, digits, _ or -']);
  if (!CODE.test(code)) return Promise.resolve([400, 'code: 6 digits']);
  if (!LANG.test(lang)) return Promise.resolve([400, 'lang: a two-letter language code (en, nl, de)']);
  return payments.serial(`${c.slug}:${c.mode}:${order}`, () => send(c, order, code, lang, body.email));
}

async function send(c: payments.Caller, order: string, code: string, lang: string, given: unknown) {
  const mail = render(WORDS, c.mode, lang, { code, minutes: String(CODE_MINUTES) });
  if (typeof mail === 'string') {
    tellOnce(`NEEDS A PERSON: the phone line's codes can't go: ${mail}.`);
    return [409, mail] as payments.Refused;
  }
  if (!mailout.ready(c.mode)) return [503, 'no email service on the server yet'] as payments.Refused;
  const now = Date.now();
  db.prepare('delete from phone_code_emails where ts < ?').run(now - DAY_MS);
  const today = db
    .prepare(
      'select count(*) as n from phone_code_emails where product = ? and mode = ? and reference = ? and kind is null',
    )
    .get(c.slug, c.mode, order) as { n: number };
  if (today.n >= CODES_A_DAY)
    return [
      429,
      `at most ${CODES_A_DAY} codes a day for one order, so nobody can fill an inbox with them: ask again tomorrow`,
      'toomany',
    ] as payments.Refused;
  const paid = await payment(c, order, given);
  if (Array.isArray(paid)) return [paid[0], paid[1]] as payments.Refused;
  const what = `a phone line code for ${c.slug}'s ${order} (${c.mode})`;
  // One email a basket's round: checked and kept with no wait between, so two stalls asking at once can't both send.
  // The code that went opens the whole basket on the phone (care's order_status).
  const sentByOther = db
    .prepare('select 1 from phone_code_emails where payment = ? and product != ? and ts > ? and kind is null')
    .get(paid.payment, c.slug, Date.now() - ROUND_MS);
  if (sentByOther) {
    payments.log(`Didn't send ${what}: another stall's code for its basket just went.`);
    return { order, status: 'sent' };
  }
  db.prepare('insert into phone_code_emails (product, mode, reference, ts, payment) values (?, ?, ?, ?, ?)').run(
    c.slug,
    c.mode,
    order,
    now,
    paid.payment,
  );
  try {
    const sent = await mailout.send(c.mode, { to: paid.to, ...mail, replyTo: mailout.hello(), about: what });
    payments.log(`${sent.test ? 'Rendered' : 'Sent'} ${what}.`);
    return { order, status: 'sent', ...(sent.test ? { test_email: { to: paid.to, ...sent.test } } : {}) };
  } catch (err) {
    if (!(err instanceof mailout.MailError)) throw err;
    payments.log(`${what} didn't surely go (${err.status}).`);
    return [err.status === 400 ? 400 : 502, err.message] as payments.Refused;
  }
}

// The answer after a call: one order's asks wait their turn, as the code's do
export function emailAnswer(c: payments.Caller, body: any): Promise<payments.Refused | object> {
  const key = String(body.key ?? ''),
    order = String(body.order ?? ''),
    lang = String(body.lang ?? 'en'),
    answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  if (!KEY.test(key)) return Promise.resolve([400, 'key: 1-128 letters, digits, :, _ or -']);
  if (!REF.test(order)) return Promise.resolve([400, 'order: 1-64 letters, digits, _ or -']);
  if (!answer || answer.length > ANSWER_MAX) return Promise.resolve([400, `answer: 1-${ANSWER_MAX} characters`]);
  if (!LANG.test(lang)) return Promise.resolve([400, 'lang: a two-letter language code (en, nl, de)']);
  return payments.serial(`${c.slug}:${c.mode}:${order}`, () =>
    sendAnswer(c, { key, order, answer, lang, given: body.email }),
  );
}

type AnswerAsk = { key: string; order: string; answer: string; lang: string; given: unknown };
async function sendAnswer(c: payments.Caller, { key, order, answer, lang, given }: AnswerAsk) {
  const what = `a phone line answer for ${c.slug}'s ${order} (${c.mode})`;
  const now = Date.now();
  db.prepare('delete from phone_code_emails where ts < ?').run(now - DAY_MS);
  const before = repeated(c, key, order, what);
  if (before) return before;
  if (!mailout.ready(c.mode)) return [503, 'no email service on the server yet'] as payments.Refused;
  const today = db
    .prepare(
      "select count(*) as n from phone_code_emails where product = ? and mode = ? and reference = ? and kind = 'answer'",
    )
    .get(c.slug, c.mode, order) as { n: number };
  if (today.n >= ANSWERS_A_DAY)
    return [
      429,
      `at most ${ANSWERS_A_DAY} answers a day for one order: ask again tomorrow`,
      'toomany',
    ] as payments.Refused;
  const paid = await payment(c, order, given);
  if (Array.isArray(paid)) return [paid[0], paid[1]] as payments.Refused;
  const mail = render(ANSWER_WORDS, c.mode, lang, { answer, order_page: orderPage(paid.payment)?.order_page ?? '' });
  if (typeof mail === 'string') {
    tellOnce(`NEEDS A PERSON: the phone line's answers after a call can't go: ${mail}.`);
    return [409, mail] as payments.Refused;
  }
  const row = db
    .prepare(
      "insert into phone_code_emails (product, mode, reference, ts, payment, kind, ask) values (?, ?, ?, ?, ?, 'answer', ?)",
    )
    .run(c.slug, c.mode, order, now, paid.payment, key).lastInsertRowid;
  const outcome = (o: string) => db.prepare('update phone_code_emails set outcome = ? where rowid = ?').run(o, row);
  try {
    const sent = await mailout.send(c.mode, {
      to: paid.to,
      ...mail,
      replyTo: mailout.hello(),
      headers: AI_HEADERS,
      about: what,
    });
    outcome('sent');
    payments.log(`${sent.test ? 'Rendered' : 'Sent'} ${what}.`);
    return { order, status: 'sent', ...(sent.test ? { test_email: { to: paid.to, ...sent.test } } : {}) };
  } catch (err) {
    if (!(err instanceof mailout.MailError)) throw err;
    outcome(err.status === 400 ? 'refused' : 'unsure');
    payments.log(`${what} didn't surely go (${err.status}).`);
    return [err.status === 400 ? 400 : 502, err.message] as payments.Refused;
  }
}

// The same ask again (its reply was lost on the way): what the first did, and nothing sent; null for a new one. One
// that may have gone, or that HQ stopped halfway, is a 502 as the first was
function repeated(c: payments.Caller, key: string, order: string, what: string) {
  const before = db
    .prepare("select outcome from phone_code_emails where product = ? and mode = ? and kind = 'answer' and ask = ?")
    .get(c.slug, c.mode, key) as { outcome: string | null } | undefined;
  if (!before) return null;
  payments.log(`Didn't send ${what} again: asked before (${before.outcome ?? 'unsure'}).`);
  if (before.outcome === 'sent') return { order, status: 'sent' };
  return (
    before.outcome === 'refused'
      ? [409, 'asked before, and the email service refused it: not sent again']
      : [502, "asked before, and whether it went isn't known: not sent again"]
  ) as payments.Refused;
}

const told = new Set<string>();
const tellOnce = (text: string) => {
  if (told.has(text)) return;
  told.add(text);
  payments.log(text);
};

const WORDS = `products/${FRONT}/care/phone-code-email.yaml`;
const ANSWER_WORDS = `products/${FRONT}/care/phone-answer-email.yaml`;
const LOOK = `products/${FRONT}/care/email-look.yaml`;
// The email in the asked language (English when the words have none), its slots filled with values (each words file's
// own, and no other {word}), or what's wrong with the words. An order_page left empty takes its line with it
// (for both emails)
function render(file: string, mode: string, asked: string, values: Record<string, string>) {
  const words = yamlFile(file);
  const lang = words[asked] ? asked : 'en',
    t = words[lang];
  if (!t || typeof t.subject !== 'string' || typeof t.body !== 'string')
    return `${file} has no ${lang} subject and body`;
  // (mailpage's slots)
  const { slot, notSlot } = mailpage.slotsOf(Object.keys(values));
  const unknown = `${t.subject}\n${t.body}`.match(notSlot)?.[0];
  if (unknown) return `${unknown} in ${file} isn't a slot HQ fills`;
  const marker = mode === 'live' ? `${t.subject}\n${t.body}`.match(mailpage.UNFINISHED)?.[0] : undefined;
  if (marker) return `${file}, ${lang}, still holds ${marker}: its words aren't final yet`;
  const look = mailpage.readLook(LOOK);
  if (typeof look === 'string') return look;
  const subject = mailpage.subjectOf(t.subject, slot, values);
  const body =
    values.order_page === ''
      ? t.body
          .split('\n')
          .filter((line: string) => !line.includes('{order_page}'))
          .join('\n')
      : t.body;
  return { subject, ...mailpage.fill(body, values, look, { lang, subject }, ['order_page']) };
}
