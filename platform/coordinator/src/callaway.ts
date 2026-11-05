// The board away from its live call, and a guest carrying it on their own device (callguests.ts: the people who joined
// its page by its code). The voice line says when the board leaves the call to them and when it comes back (away); while
// it's away, a guest's session gets one-time tickets (ticketFor) the line redeems to carry the call (redeemTicket), and
// the call's own token reaches no HQ route (boardAway, server.ts): a guest is never the board (DECISIONS.md,
// 2026-11-04).
import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.ts';
import { liveCall } from './ink/callnotes.ts';

// The calls the board has left to their guests, while it's away: the line's word, by the call and when it began (a
// forgotten call's number comes back: callguests.ts newScan's call_ts).
db.exec('create table if not exists call_away (call integer primary key, call_ts text not null, since text not null)');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Whether the board has left its live call to its guests and hasn't come back
export function boardAway(call: number | undefined) {
  const c = call ? liveCall(call) : undefined;
  return !!c && !!db.prepare('select 1 from call_away where call = ? and call_ts = ?').get(c.id, c.ts);
}
// POST /api/voice/call-away {agent, token, away}: the line's word that the board left its call (or came back), the call
// by its token (server.ts)
export function away(call: number, gone: boolean) {
  const c = liveCall(call);
  if (!c) return 404;
  if (gone)
    db.prepare('insert or replace into call_away (call, call_ts, since) values (?, ?, ?)').run(
      c.id,
      c.ts,
      new Date().toISOString(),
    );
  else db.prepare('delete from call_away where call = ?').run(c.id);
  return { ok: true };
}

// A guest's tickets for the line, by their sha256: one use, for a minute, kept in memory (a restart only means a tap
// again).
const TICKET_MS = 60_000;
const tickets = new Map<string, { scan: number; expires: number }>();
// A ticket for a scan's session (callguests.ts voiceTicket checks it's on a call the board is away from)
export function ticketFor(scan: { id: number }) {
  const t = randomBytes(32).toString('base64url');
  tickets.set(sha256(t), { scan: scan.id, expires: Date.now() + TICKET_MS });
  return t;
}
// POST /api/voice/guest-ticket {ticket}: the line redeems it, once: the call it's for and the guest's name (404: not
// one, used, late, or the board is back)
export function redeemTicket(ticket: string) {
  const now = Date.now(),
    t = tickets.get(sha256(ticket));
  tickets.delete(sha256(ticket));
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
  const s =
    t && t.expires >= now
      ? (db.prepare('select call, call_ts, name, lang from call_scans where id = ?').get(t.scan) as
          { call: number; call_ts: string; name: string; lang: string } | undefined)
      : undefined;
  if (!s || liveCall(s.call)?.ts !== s.call_ts || !boardAway(s.call)) return 404;
  return { call: s.call, name: s.name, lang: s.lang };
}
