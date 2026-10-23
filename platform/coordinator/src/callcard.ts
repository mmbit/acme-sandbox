// A call out's card on the board's desk phone (callouts.ts): what it shows, and its two buttons, Call and Don't call.
// Call on a phone call dials it if it's due (callsweep.ts); on a link it makes the join link, its hash kept, and the
// answer carries it for the board to send.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { db } from './db.ts';
import { publish } from './events.ts';
import { ORIGIN } from './config.ts';
import { secret } from './secrets.ts';
import { companyTime } from './company.ts';
import { answerRequest } from './jobs.ts';
import { hoursText } from './callrules.ts';
import { agentName, byRequest, end, HOUR, list, MINUTE, sha256, view, type Callout } from './callouts.ts';
import { dialDue } from './callsweep.ts';

export function card(c: any) {
  if (c.kind !== 'call') return c;
  const d = byRequest(c.id);
  return d ? { ...c, call: { ...view(d), ...held(d) } } : c;
}
// A call that was held, whole for the board (nothing is hidden from it): when it started and ended, the transcript (none
// once they objected) and the agent's notes, until the sweep blanks them 12 months on (deleted). Not kept and not
// deleted: the voice line never handed them over.
function held(d: Callout) {
  if (d.status !== 'done') return {};
  const kept = d.transcript !== null || d.notes !== null;
  return {
    started: d.started,
    ended: d.twilio_ended ?? d.ended, // (Twilio's word when the call hung up: `ended` is the later hand-over, or the sweep's close)
    objected: !!d.objected,
    kept,
    deleted: !!d.blanked,
    transcript: list(d.transcript),
    notes: list(d.notes),
  };
}
// A call card is answered by its Call or Don't call only, never the desk phone's answer box
export const waiting = (request: number) => byRequest(request)?.status === 'open';

export function approve(b: any) {
  const c = byRequest(Number(b.id));
  if (c?.status !== 'open') return 404;
  if (c.kind === 'phone' && !secret('TWILIO_PHONE_NUMBER'))
    return [409, "The phone line isn't set up on the server, so nothing can be dialled."];
  const decided = Date.now(),
    at = c.at && Date.parse(c.at) > decided ? Date.parse(c.at) : null;
  let link: { link: string; opens: string; closes: string } | null = null;
  if (c.kind === 'link') {
    const token = randomBytes(32).toString('base64url');
    const opens = new Date(at ? Math.max(decided, at - 15 * MINUTE) : decided).toISOString();
    const closes = new Date(at ? at + 3 * HOUR : decided + 24 * HOUR).toISOString();
    link = { link: `${ORIGIN}/join/${token}`, opens, closes };
    db.prepare('update callouts set link_hash = ?, opens = ?, closes = ? where id = ?').run(
      sha256(token),
      opens,
      closes,
      c.id,
    );
  }
  db.prepare("update callouts set status = 'approved', decided = ?, at = ? where id = ?").run(
    new Date(decided).toISOString(),
    at ? new Date(at).toISOString() : null,
    c.id,
  );
  const name = agentName(c.agent);
  answerRequest(
    c.request,
    link
      ? `Approved: a join link for ${c.who}, open from ${companyTime(Date.parse(link.opens))} until ${companyTime(Date.parse(link.closes))} ` +
          "(the company's clock), for one call. The board has it on its card to send them; if they'd rather have it by email, draft " +
          `one with it (hq mail draft). You get a follow-up job once the call has ended. The link: \`${link.link}\``
      : `Approved: ${name} calls ${c.who} ${at ? `at ${companyTime(at)}` : 'now'} (only within the calling hours, ${hoursText()}, ` +
          "the company's clock). One call, never redialled. You get a follow-up job once it has ended.",
  );
  publish({ type: 'log', agent: c.agent, text: `The board approved call #${c.id}` });
  if (c.kind === 'phone') void dialDue().catch(err => console.error('callouts: the dial failed:', err));
  return { ok: true, ...link };
}
export function decline(b: any) {
  const c = byRequest(Number(b.id));
  if (c?.status !== 'open') return 404;
  end(c, 'declined', "the board didn't want it made");
  answerRequest(
    c.request,
    `Declined: the board doesn't want this call made. Nothing was dialled${c.kind === 'link' ? ' and no link made' : ''}.`,
  );
  return { ok: true };
}
// GET /api/callouts/number?id=<request>: the number whole, for the board's card, while the call is still to come
export function number(req: IncomingMessage) {
  const c = byRequest(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')));
  return c?.number && ['open', 'approved', 'dialling'].includes(c.status) ? { number: c.number } : 404;
}
