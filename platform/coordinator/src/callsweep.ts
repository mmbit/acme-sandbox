// The dial and the sweep of calls out (callouts.ts): one call through Twilio's REST API, streamed to the voice line, and
// every minute what's due is dialled, what never came to anything ends, and 12 months after a call its words go
import { randomBytes } from 'node:crypto';
import { db, setting } from './db.ts';
import { ORIGIN } from './config.ts';
import { secret } from './secrets.ts';
import { accountUrl, authOf } from './calls.ts';
import { dialable, inHours } from './callrules.ts';
import { byId, finish, HOUR, MINUTE, sha256, type Callout } from './callouts.ts';

const TICKET_MS = 2 * MINUTE,
  CALL_MS = 4 * HOUR,
  KEPT_MS = 365 * 86_400_000;

// ---- the sweep (every minute): what's due is dialled, a link nobody opened expires, a call whose hand-over never came
// ends without one, and 12 months after a call its transcript and notes go
export async function sweep(at = Date.now()) {
  const iso = (ms: number) => new Date(ms).toISOString();
  for (const c of db
    .prepare("select * from callouts where kind = 'link' and status = 'approved' and closes < ?")
    .all(iso(at)) as Callout[])
    finish(c, 'expired', 'nobody opened the link before it closed');
  const silent = db
    .prepare(
      `select * from callouts where status = 'live' and (twilio_ended < ? or started < ? or (kind = 'link' and closes < ?))`,
    )
    .all(iso(at - 10 * MINUTE), iso(at - CALL_MS), iso(at - HOUR)) as Callout[];
  for (const c of silent)
    finish(c, 'done', "the call ended, but the voice line handed nothing over: there's no transcript and no notes");
  for (const c of db
    .prepare("select * from callouts where status = 'dialling' and ticket_expires < ?")
    .all(at - 10 * MINUTE) as Callout[])
    finish(c, 'failed', "Twilio never said how it went, so it may have rung; it isn't dialled again");
  db.prepare(
    // (blanked)
    'update callouts set transcript = null, notes = null, blanked = ? where ended < ? and (transcript is not null or notes is not null)',
  ).run(iso(at), iso(at - KEPT_MS));
  await dialDue(at);
}
// At start: a dial a restart cut off may have rung, so it ends failed, never dialled again
export function start() {
  for (const c of db.prepare("select * from callouts where status = 'dialling' and sid is null").all() as Callout[])
    finish(c, 'failed', "HQ restarted while placing it, so it may have rung once; it isn't dialled again");
}

// ---- the dial: one call through Twilio's REST API, streamed to the voice line
// Every approved phone call that's due, within the calling hours (the sweep, every minute, and right after an approval)
export async function dialDue(at = Date.now()) {
  if (!inHours(at)) return;
  const due = db
    .prepare("select id from callouts where kind = 'phone' and status = 'approved' and (at is null or at <= ?)")
    .all(new Date(at).toISOString()) as { id: number }[];
  for (const { id } of due) await dial(id);
}
async function dial(id: number) {
  const ticket = randomBytes(24).toString('base64url');
  if (
    !db
      .prepare(
        "update callouts set status = 'dialling', started = null, ticket_hash = ?, ticket_expires = ? where id = ? and status = 'approved'",
      )
      .run(sha256(ticket), Date.now() + TICKET_MS, id).changes
  )
    return;
  const c = byId(id)!,
    account = setting('twilio_account');
  if (!account || !secret('TWILIO_AUTH_TOKEN'))
    return finish(
      c,
      'failed',
      !account
        ? "it wasn't dialled: HQ doesn't know the Twilio account yet (it learns it from the first call Twilio sends the line)"
        : "it wasn't dialled: the Twilio auth token isn't saved",
    );
  let res: Response;
  try {
    res = await fetch(`${accountUrl(account)}/Calls.json`, {
      method: 'POST',
      body: callForm(c, ticket),
      headers: authOf(account),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error(`callouts: call #${c.id}: Twilio didn't answer:`, (err as Error).message);
    return finish(c, 'failed', "Twilio didn't answer HQ's request, so it may have rung once; it isn't dialled again");
  }
  const answer = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
  if (!res.ok || !answer.sid) {
    const why = `Twilio refused it (${answer.code ?? res.status}: ${String(answer.message ?? 'no reason given')
      .replace(/\+?\d[\d\s-]{6,}\d/g, 'the number')
      .slice(0, 200)})`;
    return finish(c, 'failed', why);
  }
  db.prepare('update callouts set sid = ? where id = ?').run(answer.sid, c.id);
  console.log(`callouts: call #${c.id} dialled`);
}
// The call Twilio places: from our line, streamed to the voice line with its one-time ticket, Twilio's word on it to
// HQ's status webhook (callline.ts), and the digits to type once it answers
function callForm(c: Callout, ticket: string) {
  const host = new URL(ORIGIN).host;
  return new URLSearchParams({
    To: c.number!,
    From: dialable(secret('TWILIO_PHONE_NUMBER')) ?? '',
    Timeout: '30',
    Twiml: `<Response><Connect><Stream url="wss://${host}/voice/twilio"><Parameter name="ticket" value="${ticket}"/></Stream></Connect></Response>`,
    StatusCallback: `${ORIGIN}/api/twilio/status?callout=${c.id}`,
    StatusCallbackMethod: 'POST',
    ...(c.digits ? { SendDigits: c.digits } : {}),
  });
}
