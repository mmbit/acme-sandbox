// Closure refunds: money back for named purchases of a closing product, only with the board's recorded decision
// (house rule 2).
//
// A product that closes may owe some buyers their money back. The product names the purchases and why each buyer is owed
// it. HQ keeps that as a decision and files one card on the desk phone itself (a gated tool, approvals.ts register). Only
// the board's Approve or Not now on that card decides it (jobs.ts answerRequest). Nothing the product sends or keeps counts
// as the board's decision.
//
// The product's manifest names the reasons it may give, and what each costs a buyer, in the board's words:
//   closure_reasons:
//     paid-use: can no longer use their purchase
// A reason it doesn't name is refused, and a product that names none can't ask.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import * as approvals from './approvals.ts';
import * as jobs from './jobs.ts';
import { roles } from './company.ts';
import * as payments from './payments.ts';
import { manifest } from './manifests.ts';
import { readJson } from '../../../shared/routes/routes.ts';

db.exec(`create table if not exists closure_decisions (id integer primary key, created text not null, product text not null,
  mode text not null, status text not null, request integer, decided text)`);
// reason_description: the manifest's words for the reason as the board read them on the card
db.exec(`create table if not exists closure_claims (decision integer not null, session text not null, reference text not null,
  reason text not null, reason_description text not null, amount integer not null, currency text not null,
  primary key (decision, session))`);
// An asked or approved closure decision keeps its claimed payments so HQ can issue or show its refunds.
// getDecision() reads each claim's refund from its payment. The decision is the board's record.
payments.retireRefusals.push((paymentCaller, reference) => {
  const claimed = db
    .prepare(
      `select 1 from closure_claims c join closure_decisions d on d.id = c.decision
      where d.product = ? and d.mode = ? and c.reference = ? and d.status != 'declined'`,
    )
    .get(paymentCaller.slug, paymentCaller.mode, reference);
  return claimed
    ? 'an asked or approved closure decision names this order. Keep its payment to record the refund'
    : null;
});

type Status = 'asked' | 'approved' | 'declined';
type Decision = {
  id: number;
  created: string;
  product: string;
  mode: 'test' | 'live';
  status: Status;
  request: number | null;
  decided: string | null;
};
type Claim = {
  session: string;
  reference: string;
  reason: string;
  reason_description: string;
  amount: number;
  currency: string;
};
const MAX_CLAIMS = 100;
const BODY_MAX = 32_768; // 100 claims with Stripe's longest session ids
const GRANT = 'closure';
const REASON = /^[a-z][a-z0-9-]{0,39}$/;
const REASON_DESCRIPTION = /^[^\p{C}]{1,120}$/u;

approvals.register(GRANT, { kind: GRANT, describe, decide });

const routes: Record<string, (paymentCaller: payments.Caller, requestBody: any) => Promise<unknown> | unknown> = {
  'POST /api/pay/closures': (paymentCaller, requestBody) => createDecision(paymentCaller, requestBody.claims),
  'GET /api/pay/closures': (paymentCaller, requestBody) => getDecision(paymentCaller, requestBody.id),
  'POST /api/pay/closures/refund': (paymentCaller, requestBody) =>
    refundClaim(paymentCaller, requestBody.decision, requestBody.id),
};

export async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://x');
  const route = routes[`${request.method} ${url.pathname}`];
  const paymentCaller = payments.caller(request);
  if (Array.isArray(paymentCaller)) {
    request.resume();
    return payments.json(response, paymentCaller[0], { error: paymentCaller[1] });
  }
  if (!route) {
    request.resume();
    return payments.json(response, 404, { error: 'not found' });
  }
  const requestBody =
    request.method === 'POST' ? await readJson(request, BODY_MAX) : Object.fromEntries(url.searchParams);
  if (!requestBody || typeof requestBody !== 'object') return payments.json(response, 400, { error: 'json body' });
  try {
    return payments.reply(response, await route(paymentCaller, requestBody));
  } catch (err) {
    if (err instanceof payments.StripeError) return payments.json(response, err.status, { error: err.message });
    throw err;
  }
}

// ---- asking the board
export async function createDecision(
  paymentCaller: payments.Caller,
  asked: unknown,
): Promise<object | payments.Refused> {
  if (!Array.isArray(asked) || asked.length < 1 || asked.length > MAX_CLAIMS)
    return [400, `claims: 1 to ${MAX_CLAIMS} of {id, reason}`];
  const sessions = asked.map(claim => String(claim?.id ?? ''));
  if (new Set(sessions).size !== sessions.length) return [400, 'claims: each session once'];
  const reasons = closureReasons(paymentCaller.slug);
  if (!reasons.size) return [503, "the product's manifest names no closure reasons (closure_reasons)"];
  const claims: Claim[] = [];
  for (const claim of asked) {
    const description = reasons.get(claim?.reason);
    if (!description) return [400, `reason: one of ${[...reasons.keys()].join(', ')}`];
    const checked = await claimable(paymentCaller, String(claim.id ?? ''));
    if (Array.isArray(checked)) return checked;
    claims.push({ ...checked, reason: claim.reason, reason_description: description });
  }
  // From here to the card nothing waits, so two asks at once can't both pass this check
  const open = openDecision(paymentCaller);
  if (open) return [409, `closure decision #${open} is still on the board's desk phone`];
  const decision = recordDecision(paymentCaller, claims);
  const card = jobs.createRequest({
    kind: GRANT,
    urgency: 'today',
    agent: roles().process,
    title: `Refund ${counted(claims.length, 'purchase')} of ${payments.shopName(paymentCaller.slug)} for its closure?`,
    body: cardBody(paymentCaller, claims),
    approves: `${GRANT}:${decision}`,
  });
  if (typeof card === 'number') throw new Error(`Could not file the card for closure decision #${decision} (${card})`);
  db.prepare('update closure_decisions set request = ? where id = ?').run(card.id, decision);
  payments.log(
    `${paymentCaller.slug} asked the board to refund ${counted(claims.length, 'purchase')} for its closure (${paymentCaller.mode}).`,
  );
  return getDecision(paymentCaller, decision);
}

// The reasons the product's manifest names, each with its description. An entry that isn't a short name with one line
// of words counts as not named.
function closureReasons(slug: string) {
  const named = manifest(slug)?.closure_reasons;
  const reasons = new Map<string, string>();
  if (!named || typeof named !== 'object' || Array.isArray(named)) return reasons;
  for (const [reason, description] of Object.entries(named))
    if (REASON.test(reason) && typeof description === 'string' && REASON_DESCRIPTION.test(description.trim()))
      reasons.set(reason, description.trim());
  return reasons;
}

async function claimable(
  paymentCaller: payments.Caller,
  session: string,
): Promise<Omit<Claim, 'reason' | 'reason_description'> | payments.Refused> {
  const own = await payments.ownSession(paymentCaller, session);
  if (!own) return [404, `no such session for this product: ${session}`];
  const { row, s: checkoutSession } = own;
  if (row.basket) return [409, `${session} is a basket's payment, refunded per line`];
  if (checkoutSession.status !== 'complete' || checkoutSession.payment_status !== 'paid')
    return [409, `${session} is not paid`];
  if (row.refund && !['failed', 'canceled'].includes(row.refund_status))
    return [409, `${session} is refunded already, or its refund is on its way`];
  return { session, reference: row.reference, amount: row.amount, currency: row.currency };
}

// The asked decision whose card is still on the desk phone, if any
const openDecision = (paymentCaller: payments.Caller) =>
  (
    db
      .prepare(
        `select d.id from closure_decisions d join requests r on r.id = d.request
        where d.product = ? and d.mode = ? and d.status = 'asked' and r.status = 'open'`,
      )
      .get(paymentCaller.slug, paymentCaller.mode) as { id: number } | undefined
  )?.id;

function recordDecision(paymentCaller: payments.Caller, claims: Claim[]) {
  db.exec('begin');
  try {
    const { lastInsertRowid } = db
      .prepare("insert into closure_decisions (created, product, mode, status) values (?, ?, ?, 'asked')")
      .run(new Date().toISOString(), paymentCaller.slug, paymentCaller.mode);
    const insert = db.prepare(
      `insert into closure_claims (decision, session, reference, reason, reason_description, amount, currency)
      values (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const claim of claims)
      insert.run(
        lastInsertRowid,
        claim.session,
        claim.reference,
        claim.reason,
        claim.reason_description,
        claim.amount,
        claim.currency,
      );
    db.exec('commit');
    return Number(lastInsertRowid);
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
}

function cardBody(paymentCaller: payments.Caller, claims: Claim[]) {
  const name = payments.shopName(paymentCaller.slug);
  return (
    `${name} is closing, or has closed, and asks to refund ${counted(claims.length, 'purchase')} in full: ` +
    `${totalOf(claims)} in total. ${modeWords(paymentCaller.mode)}\n\n` +
    `Why these buyers are owed their money: ${reasonsOf(claims)}.\n\n` +
    `Not now refunds nothing, and ${name} can ask again.`
  );
}

// ---- the board's answer: the gated tool (approvals.ts register)
function describe(grant: string) {
  const decision = decisionOf(grant);
  if (!decision) return 'This closure decision is gone: approval authorizes no refunds.';
  const claims = claimsOf(decision.id);
  const name = payments.shopName(decision.product);
  return (
    `Approval authorizes refunding ${counted(claims.length, 'purchase')} of ${name} in full, at the price each buyer paid: ` +
    `${totalOf(claims)} in total. ${modeWords(decision.mode)} Reasons: ${reasonsOf(claims)}. ` +
    `The product's closure procedure must apply this decision to start the refunds. ` +
    `Only these purchases may be refunded, each once. Approval does not close ${name}.`
  );
}

// Only the board's answer on the decision's own card decides it, once
function decide(grant: string, yes: boolean, request: number) {
  const decision = decisionOf(grant);
  if (!decision || decision.status !== 'asked' || decision.request !== request) return false;
  const status: Status = yes ? 'approved' : 'declined';
  db.prepare('update closure_decisions set status = ?, decided = ? where id = ?').run(
    status,
    new Date().toISOString(),
    decision.id,
  );
  payments.log(`The board ${status} closure decision #${decision.id} for ${decision.product} (${decision.mode}).`);
  return true;
}

function decisionOf(grant: string) {
  const id = Number(grant.split(':')[1]);
  if (!Number.isSafeInteger(id)) return undefined;
  return db.prepare('select * from closure_decisions where id = ?').get(id) as Decision | undefined;
}

// ---- reading it and refunding
export function getDecision(paymentCaller: payments.Caller, id: unknown): object | payments.Refused {
  const decision = ownDecision(paymentCaller, id);
  if (!decision) return [404, 'no such closure decision for this product'];
  const claims = db
    .prepare(
      `select c.session, c.reference, c.reason, c.amount, c.currency, p.refund, p.refund_status
      from closure_claims c left join payments p on p.id = c.session where c.decision = ? order by c.rowid`,
    )
    .all(decision.id) as (Claim & { refund: string | null; refund_status: string | null })[];
  return {
    id: decision.id,
    status: decision.status,
    created: decision.created,
    decided: decision.decided,
    total: claims.reduce((sum, claim) => sum + claim.amount, 0),
    currency: claims[0].currency,
    claims: claims.map(claim => ({
      id: claim.session,
      reference: claim.reference,
      reason: claim.reason,
      amount: claim.amount,
      refund_status: claim.refund ? (claim.refund_status ?? 'pending') : null,
    })),
  };
}

// The money route: the board approved this decision, for this product and mode, and it names this session
export async function refundClaim(paymentCaller: payments.Caller, decisionId: unknown, session: unknown) {
  const decision = ownDecision(paymentCaller, decisionId);
  if (!decision) return [404, 'no such closure decision for this product'];
  if (decision.status !== 'approved')
    return [403, `the board has not approved closure decision #${decision.id} (${decision.status})`];
  const claim = db
    .prepare('select session from closure_claims where decision = ? and session = ?')
    .get(decision.id, String(session ?? '')) as { session: string } | undefined;
  if (!claim) return [403, `closure decision #${decision.id} doesn't name that session`];
  return payments.refund(paymentCaller, claim.session);
}

function ownDecision(paymentCaller: payments.Caller, id: unknown) {
  const number = Number(id);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return db
    .prepare('select * from closure_decisions where id = ? and product = ? and mode = ?')
    .get(number, paymentCaller.slug, paymentCaller.mode) as Decision | undefined;
}

// ---- the board's words
const claimsOf = (decision: number) =>
  db.prepare('select * from closure_claims where decision = ? order by rowid').all(decision) as Claim[];
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const totalOf = (claims: Claim[]) =>
  payments.euros(
    claims.reduce((sum, claim) => sum + claim.amount, 0),
    claims[0].currency,
  );
const modeWords = (mode: 'test' | 'live') =>
  mode === 'live' ? "Real money goes back to each buyer's way of paying." : 'This is test mode: no real money moves.';
function reasonsOf(claims: Claim[]) {
  const counts = new Map<string, number>();
  for (const claim of claims) counts.set(claim.reason_description, (counts.get(claim.reason_description) ?? 0) + 1);
  return [...counts].map(([description, n]) => `${description} (${n})`).join(', ');
}
