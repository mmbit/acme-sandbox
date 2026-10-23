// The board's card when the support chat's prepaid model credit runs low. The care
// service counts what's left from its own ledger (platform/care/src/ledger.ts credit()) and says so once per step; this
// puts it on the desk phone, for care's owner (products/care/product.yaml) to hear the answer and update the credit.
//   POST /api/care/credit { helper, left, perDay, stopAt, renews? } (dollars; renews: when a plan's monthly credit comes
//   again, ms; care's token, as for its cards) → { ok, id }
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serviceAuthed } from './care.ts';
import { companyFormats } from './company.ts';
import { createRequest } from './jobs.ts';
import { ownerOf } from './owed.ts';

export const BILLING_URL = 'https://platform.claude.com/settings/billing';
const dollars = (usd: number) => `$${Math.max(usd, 0).toFixed(2)}`;

export async function service(req: IncomingMessage, res: ServerResponse) {
  const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (!serviceAuthed(req.headers.authorization)) { req.resume(); return json(401, { error: 'care token' }); }
  if (req.method !== 'POST') { req.resume(); return json(404, { error: 'not found' }); }
  const parts: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { if ((bytes += chunk.length) > 10_000) return json(413, { error: 'too large' }); parts.push(chunk); }
  let b: any;
  try { b = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return json(400, { error: 'json body' }); }
  const helper = typeof b?.helper === 'string' ? b.helper.trim().slice(0, 40) : '';
  if (!helper || ![b.left, b.perDay, b.stopAt].every(Number.isFinite)) return json(400, { error: 'helper, left, perDay and stopAt (dollars)' });
  const renews = Number.isFinite(b.renews) ? b.renews as number : null;
  return json(200, { ok: true, ...creditCard({ helper, left: b.left, perDay: b.perDay, stopAt: b.stopAt, renews }) });
}

// what the card tells: stopped already, or the whole days left at the week's pace (null: nothing spent, no pace)
function outlook(c: { left: number; perDay: number; stopAt: number }) {
  return c.left <= c.stopAt ? 'stopped' as const : c.perDay <= 0 ? null : Math.floor((c.left - c.stopAt) / c.perDay);
}

export function creditCard(c: { helper: string; left: number; perDay: number; stopAt: number; renews?: number | null }) {
  const days = outlook(c);
  const pace = days === 'stopped' ? `${c.helper} has stopped answering in the chat until it's recharged.`
    : days === null ? 'Nothing was spent in the last week, so there is no pace to go by yet.'
    : days < 1 ? `At this week's pace, ${c.helper} stops answering in the chat within a day.`
    : `At this week's pace, that lasts about ${days} ${days === 1 ? 'day' : 'days'} before ${c.helper} stops answering in the chat.`;
  // the plan's monthly API credit is spent first, so what is left holds some of it too
  const renews = c.renews ?? null, withMonthlyCredit = renews != null;
  const whatIsLeft = withMonthlyCredit ? 'the prepaid credit and what the plan\'s monthly API credit still holds' : 'the prepaid credit';
  const renewal = withMonthlyCredit ? `The next monthly API credit comes on ${formatDay(renews)}. ` : '';
  const balance = withMonthlyCredit ? 'the prepaid balance the console shows (not the monthly credit)' : 'the balance the console shows';
  return createRequest({ kind: 'decision', urgency: 'today', agent: ownerOf('care').agent,
    title: `${c.helper}'s credit: about ${dollars(c.left)} left`, body:
    `About ${dollars(c.left)} is left on the Anthropic account behind ${c.helper}: ${whatIsLeft}. ${pace} ${renewal}` +
    `Recharge in the Anthropic console, under Billing: ${BILLING_URL}\n\n` +
    `Once about ${dollars(c.stopAt)} is left, ${c.helper} pauses in the chat. Customers can still leave their question for an ` +
    'answer by email, or email a person, and the chat picks up again once the credit is back.\n\n' +
    `This is an estimate from our own records: what each of ${c.helper}'s model calls cost, plus the full monthly limit of ` +
    "any other key on the same account (a test key's). The console's balance is the real one.\n\n" +
    `Recommended: recharge now, then answer with ${balance}, so our count starts again from it.` }) as { id: number };
}

// The day a moment falls on, on the company's clock: 3 November
function formatDay(t: number) {
  const f = companyFormats();
  return f.day(f.dayAt(t), 'en');
}
