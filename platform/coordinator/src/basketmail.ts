// The basket's one confirmation email: once a basket's Checkout Session is paid, the address it was paid with gets one
// email for the whole basket, in the basket owner's words (basketwords.ts), with the files they name (the terms as
// they stand).
// - A notes hook that can't tell yet (the parcel isn't placed, say) holds the email, at most HOLD_MS after the payment;
//   then it goes without that hook's phrases.
// - Once per basket session, the way ordermail.ts sends: the mark is written before the send, so a session seen paid
//   twice (the hook and the timer) sends one email. One the service refused, or may have taken without answering, goes
//   again on the timer; after TRIES nothing more goes, and the log asks a person to write.
// - The address is Stripe's customer_details.email on the session, never stored or logged here.
//
// The basket's shipped email: once its parcel has shipped (parcels.ts: Print API's Shipped, its shipped_at and tracking
// link), the same address gets the news, once per parcel (one a basket: a parcel placed again in a new round is still
// the one parcel), sent and marked the same way, with no files. Two kinds, never both for one parcel: `shipped` once
// the tracking link is in, `shipped_untracked` when none has come a day after Shipped (UNTRACKED_MS), fixed at its
// first try. Only for parcels shipped since it came in (shipped_emails_from), and only in their first week: older news
// isn't sent.
import * as payments from './payments.ts';
import { FRONT } from './approvals.ts';
import { db, remember, setting } from './db.ts';
import * as mailout from './mailout.ts';
import type * as mailpage from './mailpage.ts';
import * as parcels from './parcels.ts';
import * as words from './basketwords.ts';

db.exec(`create table if not exists basket_emails (session text primary key, mode text not null, status text not null,
  tries integer not null, rendered integer not null, updated text not null)`); // rendered: test mode without the service, never sent
// session: the basket's, whose one parcel it is (parcels.session); kind: shipped or shipped_untracked, fixed at its first try
db.exec(`create table if not exists shipped_emails (session text primary key, mode text not null, kind text not null, status text not null,
  tries integer not null, rendered integer not null, updated text not null)`);
const SHIPPED_FROM = setting('shipped_emails_from') ?? new Date().toISOString();
remember('shipped_emails_from', SHIPPED_FROM);

const TRIES = 3;
const STUCK_MS = 2 * 60_000; // a send still marked after this was cut off (HQ restarted mid-send): it may have gone
const SWEEP_MS = 2 * 60_000;
const LOOK_BACK_MS = 3 * 86_400_000; // paid sessions the sweep looks for without a mark (a crash right after the flip)
const HOLD_MS = 30 * 60_000; // a notes hook that can't tell yet holds the email this long after the payment
const UNTRACKED_MS = 86_400_000; // a parcel shipped this long ago without a tracking link gets shipped_untracked
const SHIPPED_FRESH_MS = 7 * 86_400_000; // the shipped email goes only this long after the parcel shipped
const told = new Set<string>();

type Status = 'waiting' | 'sending' | 'sent' | 'unsure' | 'refused';
type Row = {
  session: string;
  mode: 'test' | 'live';
  status: Status;
  tries: number;
  rendered: number;
  updated: string;
  kind?: words.Kind;
};
type Answer = {
  status: Status;
  test_email?: { to: string; subject: string; text: string; html?: string; attachments?: string[] };
};

// a company's own sentences for one order (a gift in its parcel, say). Each hook
// answers the names of its phrases for the paid session (none: an empty list), or null while it can't tell yet; the words
// file holds each one per language, under `notes`.
export const notes: ((pay: any, lines: payments.Line[]) => string[] | null)[] = [];
// The same for a shipped parcel's email (a gift that really went in it, say): each hook answers the names of its phrases
// for the basket session whose parcel shipped, from the shipped words' `notes`. The parcel is placed by then, so a hook
// always can tell.
export const shippedNotes: ((session: string) => string[])[] = [];
// A company's own closing line for both emails, {signoff}: the season's wish,
// say. Each hook answers for the email's language at the moment it's sent, with a small picture to show beside it in the
// HTML part (mailpage.ts marked) or none; the first answer goes, and with none the line goes.
export const signoffs: ((lang: string, at: number) => mailpage.Marked | null)[] = [];
const signoffOf = (lang: string) => {
  for (const hook of signoffs) {
    const line = hook(lang, Date.now());
    if (line) return line;
  }
  return null;
};

// ---- when a basket is paid
payments.basketPaid.push((pay, s, lines) => {
  confirmations.waiting(pay.id, pay.mode);
  deliver(pay, s, lines).catch(err => console.error(`Basket email ${pay.id}: could not send:`, err));
});
// A paid basket's records ending (records.ts) end the marks of its emails
payments.recordsEnded.push(session => {
  for (const table of ['basket_emails', 'shipped_emails'])
    db.prepare(`delete from ${table} where session = ?`).run(session);
});
export const start = () => {
  setInterval(() => sweep().catch(err => console.error('Basket emails: the sweep failed:', err)), SWEEP_MS);
  setInterval(() => sweepShipped().catch(err => console.error('Shipped emails: the sweep failed:', err)), SWEEP_MS);
};

// Sends what's due: marks the timer retries (and a last try cut off, for spent()), and paid basket sessions with no mark
export async function sweep() {
  const since = new Date(Date.now() - LOOK_BACK_MS).toISOString();
  const unmarked = db
    .prepare(
      `select id, mode from payments where product = ? and basket is not null and status not in ('open', 'expired')
    and created > ? and id not in (select session from basket_emails)`,
    )
    .all(FRONT, since) as { id: string; mode: 'test' | 'live' }[];
  const due = confirmations.all().filter(r => sends(r) || stuck(r));
  for (const { id, mode } of [...unmarked, ...due.map(r => ({ id: r.session, mode: r.mode }))]) {
    const own = await payments.ownSession({ slug: FRONT, mode }, id).catch(() => null);
    if (!own || own.s.status !== 'complete' || own.s.payment_status !== 'paid') continue;
    confirmations.waiting(id, mode);
    await deliver(own.row, own.s, payments.paidLines(id)).catch(err =>
      console.error(`Basket email ${id}: could not send:`, err),
    );
  }
}

// ---- once per session, each email in its own table
const once = (table: 'basket_emails' | 'shipped_emails') => {
  const row = (session: string) =>
    db.prepare(`select * from ${table} where session = ?`).get(session) as Row | undefined;
  const mark = (session: string, status: Status, tries: number, rendered = 0) =>
    db
      .prepare(`update ${table} set status = ?, tries = ?, rendered = ?, updated = ? where session = ?`)
      .run(status, tries, rendered, new Date().toISOString(), session);
  // A last try cut off by a restart never reaches sendOnce()'s catch: it's marked unsure here, so a person is asked once
  const spent = (session: string, what: string, r?: Row) => {
    if (!r || !stuck(r) || r.tries < TRIES) return r;
    mark(session, 'unsure', r.tries);
    payments.log(
      `NEEDS A PERSON: ${what} may not have gone (HQ restarted during its last try). Write to the address on its payment.`,
    );
    return row(session);
  };
  return {
    row,
    mark,
    spent,
    all: () => db.prepare(`select * from ${table} where status != 'sent'`).all() as Row[],
    waiting: (session: string, mode: string, kind?: words.Kind) =>
      db
        .prepare(
          `insert or ignore into ${table} (session, mode, ${kind ? 'kind, ' : ''}status, tries, rendered, updated)
        values (?, ?, ${kind ? '?, ' : ''}'waiting', 0, 0, ?)`,
        )
        .run(session, mode, ...(kind ? [kind] : []), new Date().toISOString()),
  };
};
type Once = ReturnType<typeof once>;
const confirmations = once('basket_emails'),
  shippings = once('shipped_emails');
const stuck = (r: Row) => r.status === 'sending' && Date.parse(r.updated) < Date.now() - STUCK_MS;
const sends = (r: Row) =>
  (r.status === 'waiting' || r.status === 'refused' || r.status === 'unsure' || stuck(r)) && r.tries < TRIES;
const tellOnce = (key: string, text: string) => {
  if (!told.has(key)) {
    told.add(key);
    payments.log(text);
  }
};

export async function deliver(pay: any, s: any, lines: payments.Line[]): Promise<Answer> {
  const session = String(pay.id),
    mode = pay.mode as 'test' | 'live',
    what = `the basket email for ${session} (${mode})`;
  const before = confirmations.spent(session, what, confirmations.row(session));
  if (!before || !sends(before)) return { status: before?.status ?? 'waiting' };
  if (!ready(mode, what)) return { status: 'waiting' };
  const named = notesFor(pay, lines);
  if (!named) return { status: 'waiting' }; // no try counted: the timer asks the hooks again
  const mail = words.confirmation(pay, s, lines, { notes: named, signoff: signoffOf });
  return sendOnce(confirmations, session, mode, what, s, mail);
}

// ---- once its parcel has shipped
// Sends what's due: parcels shipped this week with no email gone yet, each once its kind is known
export async function sweepShipped(now = Date.now()) {
  const fresh = new Date(now - SHIPPED_FRESH_MS).toISOString(),
    since = fresh > SHIPPED_FROM ? fresh : SHIPPED_FROM;
  const shipped = db
    .prepare(
      `select session, mode, shipped_at, tracking from parcels where status = 'shipped' and shipped_at >= ?
    and session not in (select session from shipped_emails where status = 'sent')`,
    )
    .all(since) as { session: string; mode: 'test' | 'live'; shipped_at: string; tracking: string | null }[];
  for (const p of shipped) {
    const r = shippings.row(p.session);
    if (r && !sends(r) && !stuck(r)) continue;
    // the kind is fixed once a try is counted; until then the tracking link coming changes it
    const kind = r?.tries ? r.kind : kindOf(p, now);
    if (!kind) continue; // the tracking link may still come
    if (!parcels.linesIn(p.session).length) continue; // all its lines taken out: nothing to tell
    const own = await payments.ownSession({ slug: FRONT, mode: p.mode }, p.session).catch(() => null);
    if (!own) continue;
    shippings.waiting(p.session, p.mode, kind);
    if (r && !r.tries)
      db.prepare('update shipped_emails set kind = ? where session = ? and tries = 0').run(kind, p.session);
    await deliverShipped(own.row, own.s, p.tracking).catch(err =>
      console.error(`Shipped email ${p.session}: could not send:`, err),
    );
  }
}

function kindOf(parcel: { tracking: string | null; shipped_at: string }, now: number): words.Kind | null {
  if (parcel.tracking) return 'shipped';
  const waited = now - Date.parse(parcel.shipped_at);
  return waited >= UNTRACKED_MS ? 'shipped_untracked' : null;
}

export async function deliverShipped(pay: any, s: any, tracking: string | null): Promise<Answer> {
  const session = String(pay.id),
    mode = pay.mode as 'test' | 'live',
    what = `the shipped email for ${session} (${mode})`;
  const before = shippings.spent(session, what, shippings.row(session));
  if (!before?.kind || !sends(before)) return { status: before?.status ?? 'waiting' };
  if (!ready(mode, what)) return { status: 'waiting' };
  const own = { notes: shippedNotesFor(session), signoff: signoffOf };
  const mail = words.shipped(before.kind, pay, s, parcels.linesIn(session), tracking, own);
  return sendOnce(shippings, session, mode, what, s, mail);
}

// ---- sending, the same for both
// No try counted while the service isn't in: the timer sends it once it is
function ready(mode: 'test' | 'live', what: string) {
  if (mailout.ready(mode)) return true;
  tellOnce(`${mode}:service`, `NEEDS A PERSON: basket emails (${mode}) wait for the email service: ${what} is one.`);
  return false;
}
async function sendOnce(
  emails: Once,
  session: string,
  mode: 'test' | 'live',
  what: string,
  s: any,
  mail: words.Mail | string,
): Promise<Answer> {
  if (typeof mail === 'string') {
    // the words or files need a fix on main: no try counted
    tellOnce(
      `${session}:${what}`,
      `NEEDS A PERSON: can't send ${what}: ${mail}. Once it's fixed on main, the timer sends it.`,
    );
    return { status: 'waiting' };
  }
  const to = mailout.address(s.customer_details?.email);
  if (!to) {
    emails.mark(session, 'refused', TRIES);
    payments.log(`NEEDS A PERSON: ${what} can't go: Stripe has no email address for its payment.`);
    return { status: 'refused' };
  }
  // read again after the awaits before this, and marked in the same step: two at once send one email
  const now = emails.row(session);
  if (!now || !sends(now)) return { status: now?.status ?? 'waiting' };
  const tries = now.tries + 1;
  emails.mark(session, 'sending', tries);
  try {
    const sent = await mailout.send(mode, { to, ...mail, replyTo: mailout.hello(), about: what });
    emails.mark(session, 'sent', tries, sent.test ? 1 : 0);
    payments.log(`${sent.test ? 'Rendered' : 'Sent'} ${what}.`);
    return { status: 'sent', ...(sent.test ? { test_email: { to, ...sent.test } } : {}) };
  } catch (e) {
    if (!(e instanceof mailout.MailError)) {
      emails.mark(session, 'unsure', tries);
      throw e;
    }
    const unsure = e.status === 504;
    emails.mark(session, unsure ? 'unsure' : 'refused', tries);
    if (tries >= TRIES)
      payments.log(
        `NEEDS A PERSON: ${what} didn't surely go after ${tries} tries (${e.status}). Write to the address on its payment.`,
      );
    else
      payments.log(
        `${what} ${unsure ? 'may not have gone (no answer)' : `didn't go (${e.status})`}; the timer sends it again.`,
      );
    return { status: unsure ? 'unsure' : 'refused' };
  }
}

// The phrases the notes hooks name for this order, or null while one can't tell yet and the email may still wait for it
function notesFor(pay: any, lines: payments.Line[]) {
  const answers = notes.map(hook => {
    try {
      return hook(pay, lines);
    } catch (err) {
      console.error(`Basket email ${pay.id}: a notes hook failed:`, err);
      return [];
    }
  });
  const paidAt = Math.max(...lines.map(line => Date.parse(line.paid_at ?? '') || 0));
  if (answers.includes(null) && Date.now() - paidAt < HOLD_MS) return null;
  return answers.flatMap(named => named ?? []);
}

// The phrases the shipped notes hooks name for this parcel's basket session
function shippedNotesFor(session: string) {
  return shippedNotes.flatMap(hook => {
    try {
      return hook(session);
    } catch (err) {
      console.error(`Shipped email ${session}: a notes hook failed:`, err);
      return [];
    }
  });
}
