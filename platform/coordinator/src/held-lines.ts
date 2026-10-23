// Held lines: a paid line its product keeps from the printer until a person has looked at what's printed on it (a name
// its word check flagged, say). The product says so on its timer, with the words as they are now; the board sees them in
// Care and answers once: release (it goes on to the printer) or refuse (it isn't made: the product cancels it and refunds
// it in full, through its own cancel). The product reads the answer with its next report, within a minute, and acts on
// it; until then the board can take its answer back. An answer holds for what the board was shown: its revision (a hash
// of the words and the reason) comes back with the tap, and a report whose words or reason changed asks the board again
// (a refusal the product has read stays: it's being refunded). The words are taken whole or not at all, never cut, so
// a release is for everything the word check read. A line leaves the list once it's in its parcel, out of it, or its
// refund is asked, so a buyer's own cancel meanwhile wins. The words are shown to the board, never logged, and forgotten
// once the line leaves the list (when it's cancelled or refunded, and at the next look or count for any other way out).
//
//   POST /api/pay/line/held {id, detail?, words?, why?}   the product's token: it holds this paid line of its own
//        (detail: what's printed on it now, 1-120 characters, which the line's detail takes; words: everything its word
//        check read, 1-50,000 characters, shown only to the board, the detail when none; why: why it's held, in the
//        board's words, 1-200 characters) → {answer: null | 'release' | 'refuse'}. Asked again on each round while it
//        holds it; once the board answered, the answer, and from then on it stays while the words and the reason do.
// The board's side is Care's (care.ts): list() for its list, answer() for the buttons.
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { type Caller, json, log, ownLine, productRequest } from './payments.ts';
import { copiesOf } from '../../../shared/format/format.js';

const LINE = /^ln_[a-f0-9]{24}$/;
const QUIET_MS = 10 * 60_000; // a product that hasn't reported for this long: its timer may not be running
const ANSWERS = new Set(['release', 'refuse']);
// the most words a product may send for one line, and a body that holds them as JSON
const WORDS_MAX = 50_000;
const BODY_MAX = 4 * WORDS_MAX + 4096;
const stamp = () => new Date().toISOString();
// a line that can still wait: paid, not in its parcel nor taken out, no refund asked; one waiting is held too
const OPEN = `l.status = 'paid' and l.refund is null and coalesce(l.refund_status, '') != 'succeeded'
  and not exists (select 1 from parcel_lines p where p.line = l.id and (p.handed is not null or p.removed is not null))`;
const WAITING = `l.held is not null and ${OPEN}`;
// The words of a line that left the list go: they were for the board's look only. The payments' own steps that take a
// line out (a cancel, a refund) call it too, and their 90-day sweep with paidBefore, as for the line's detail.
export function forgetHeldWords(paidBefore?: string) {
  // none kept (and so maybe no parcels yet, for a payments-only test): nothing to look at
  if (!db.prepare('select 1 from pay_lines where held_words is not null limit 1').get()) return;
  db.prepare(
    `update pay_lines set held_words = null where held_words is not null
    and (id not in (select l.id from pay_lines l where ${WAITING}) or paid_at < ?)`,
  ).run(paidBefore ?? ''); // '': no paid_at is before it, so without paidBefore only lines off the list lose their words
}
const revision = (words: string | null, why: string | null) =>
  createHash('sha256')
    .update(JSON.stringify([words, why]))
    .digest('hex')
    .slice(0, 16);
type Held = {
  id: string;
  product: string;
  mode: string;
  reference: string;
  description: string;
  detail: string | null;
  amount: number;
  quantity: number;
  currency: string;
  paid_at: string | null;
  held: string;
  held_why: string | null;
  held_words: string | null;
  held_revision: string | null;
  held_seen: string;
  held_answer: string | null;
  held_answered: string | null;
  held_taken: string | null;
};
const waiting = (id: string) =>
  db.prepare(`select l.* from pay_lines l where l.id = ? and ${WAITING}`).get(id) as Held | undefined;

// ---- the product's side
async function report(c: Caller, b: any): Promise<[number, string] | { answer: string | null }> {
  const words = (v: unknown) => (v == null || v === '' ? null : String(v).replace(/\s+/g, ' ').trim());
  const id = String(b.id ?? ''),
    detail = words(b.detail),
    read = words(b.words),
    why = words(b.why);
  if (detail !== null && (!detail || [...detail].length > 120)) return [400, 'detail: 1-120 characters, or none'];
  if (read !== null && (!read || [...read].length > WORDS_MAX)) return [400, 'words: 1-50,000 characters, or none'];
  if (why !== null && (!why || [...why].length > 200)) return [400, 'why: 1-200 characters, or none'];
  const row = () =>
    db.prepare('select * from pay_lines where id = ?').get(id) as (Held & { status: string }) | undefined;
  let line = LINE.test(id) ? row() : undefined;
  if (!line || line.product !== c.slug || line.mode !== c.mode) return [404, 'no such line for this product'];
  // a payment HQ hasn't read yet is read first (ownLine), as the line's own view does
  if (line.status !== 'paid') {
    await ownLine(c, id);
    line = row()!;
  }
  if (line.status !== 'paid') return [409, 'this line is not paid'];
  if (!db.prepare(`select 1 from pay_lines l where l.id = ? and ${OPEN}`).get(id))
    return [409, 'this line is in its parcel already, or out of it'];
  const now = stamp(),
    shown = read ?? detail ?? line.held_words ?? line.detail,
    reason = why ?? line.held_why,
    revised = revision(shown, reason);
  // what the board answered for changed (an edit, another reason): it's asked again, unless its refusal
  // was read already
  if (line.held_answer && line.held_revision !== revised && !(line.held_taken && line.held_answer === 'refuse')) {
    db.prepare('update pay_lines set held_answer = null, held_answered = null, held_taken = null where id = ?').run(id);
    log(`${c.slug}'s held ${c.mode} line for ${line.reference} changed since the board answered: asked again (Care).`);
    line = row()!;
  }
  db.prepare(
    `update pay_lines set held = coalesce(held, ?), held_seen = ?, detail = coalesce(?, detail), held_words = ?, held_why = ?,
    held_revision = ?, held_taken = case when held_answer is not null then coalesce(held_taken, ?) end where id = ?`,
  ).run(now, now, detail, shown, reason, revised, now, id);
  if (!line.held) log(`${c.slug} holds its ${c.mode} line for ${line.reference} for a person to look at (Care).`);
  return { answer: line.held_answer };
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const asked = await productRequest(req, res, { post: true, limit: BODY_MAX });
  if (!asked) return;
  const r = await report(asked.caller, asked.body);
  return Array.isArray(r) ? json(res, r[0], { error: r[1] }) : json(res, 200, r);
}

// ---- the board's side (Care)
// Every line waiting for a person, the oldest payment first: what's on it, the board's answer (until the product has
// acted on it), and quiet when the product hasn't reported for a while
export function list(now = Date.now()) {
  forgetHeldWords();
  return (db.prepare(`select l.* from pay_lines l where ${WAITING} order by l.paid_at, l.id`).all() as Held[]).map(
    l => ({
      line: l.id,
      app: l.product,
      mode: l.mode,
      order: l.reference,
      // (a line of copies: all of them)
      description: `${copiesOf(l)}${l.description}`,
      words: l.held_words ?? l.detail,
      why: l.held_why,
      revision: l.held_revision,
      amount: l.amount * l.quantity,
      currency: l.currency,
      paidAt: l.paid_at,
      since: l.held,
      answer: l.held_answer,
      answeredAt: l.held_answered,
      taken: !!l.held_taken,
      quiet: Date.parse(l.held_seen) < now - QUIET_MS,
    }),
  );
}
export function count() {
  forgetHeldWords();
  const row = db.prepare(`select count(*) n from pay_lines l where ${WAITING} and l.held_answer is null`).get() as {
    n: number;
  };
  return row.n;
}

// The board's tap: release or refuse for the revision it was shown, or null to take it back while the product hasn't
// read it yet
export function answer(b: any): [number, string] | { ok: true } {
  const id = String(b?.line ?? ''),
    to = b?.answer ?? null;
  if (to !== null && !ANSWERS.has(to)) return [400, 'answer: release, refuse or null'];
  const l = LINE.test(id) ? waiting(id) : undefined;
  if (!l) return [404, 'That order isn’t waiting any more: it went on, or it was cancelled.'];
  if (l.held_taken)
    return [
      409,
      l.held_answer === 'release' ? 'It’s on its way to the printer already.' : 'It’s being refunded already.',
    ];
  if (to !== null && b?.revision !== l.held_revision)
    return [409, 'What’s on it changed since you looked: here it is again.'];
  if (to === l.held_answer) return { ok: true };
  db.prepare('update pay_lines set held_answer = ?, held_answered = ? where id = ? and held_taken is null').run(
    to,
    to ? stamp() : null,
    id,
  );
  log(
    `the board ${to === 'release' ? 'released' : to === 'refuse' ? 'refused' : 'took back its answer on'} ${l.product}'s held ${l.mode} line for ${l.reference}.`,
  );
  return { ok: true };
}
