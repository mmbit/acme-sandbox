// Calls out: an agent's call to an outside partner (a supplier's support desk, a printer), made by the voice line in the
// agent's voice, only once the board has said Call on its card (house rule 1).
// An agent files one (hq phone call): who, what about, why and what it may agree, the language, a number or a join link,
// and optionally when. The board gets a card on the desk phone (Call, Don't call): its text is the agent's line for the
// board (--card: who, what we ask, what we may agree), the why folded under its More; the agent hears its answer as any
// card's. Then:
//   - A phone call: at its time, or at once, and only within the calling hours (brand.yaml's callsOut.hours, on the
//     company's clock), HQ asks Twilio to place one call that streams to the voice line with a one-time ticket. Busy,
//     no answer or a failure ends it: never a redial (a new call is a new card).
//   - A link: HQ makes a join link (/join/<token>, only its hash kept) for one call room, open from the approval (or 15
//     minutes before its time) until 24 hours after the approval (or 3 hours after its time).
// The voice line asks for the call's briefing (call-context), says the fixed opening (who, an AI, what about, the
// transcript), and hands over the transcript, or only the agent's notes when the other side objected (call-end). One
// follow-up job goes to the agent who filed it, which reads the call with hq phone call.
//   - The number is kept with the call alone: never in the card's title, body or answer, a log line, an event or an
//     error. The card shows its last 3 digits, and the board can see it whole (callcard.ts). It goes once the call ends.
//   - A dial is in the table before it goes ('dialling'): one cut off by a restart ends failed, never dialled twice.
//   - The transcript and notes are kept 12 months after the call, then blanked (callsweep.ts); the row stays. They stay
//     with the call: the follow-up's brief has neither, it reads them with hq phone call. The board reads them on the
//     call's card once it has ended (callcard.ts).
//   - A job that holds a customer's details files no call (house rule 7), as it files no email draft (outbox.ts).
// Here: the table, the agent's side and the call's end; the board's card: callcard.ts; the dial and the sweep:
// callsweep.ts; the call itself on the voice line: callline.ts.
import { createHash } from 'node:crypto';
import { db, redacted } from './db.ts';
import { publish } from './events.ts';
import { secret } from './secrets.ts';
import { ceo, timeZone } from './company.ts';
import { boardId, closeRequest, createJob, createRequest, findAgent, holdsCustomerData } from './jobs.ts';
import { atTime, dialable, hoursText } from './callrules.ts';
import * as words from './callwords.ts';
import { codeOf } from './jobcodes.ts';

// status: open (on the desk phone), declined, withdrawn (by its filer), approved (to dial, or the link made), dialling
// (Twilio asked, not answered yet), live (on the line), done, missed (busy, no answer), failed, expired (a link nobody
// opened). number and digits: blanked once it ends. link_hash, opens, closes: a link's. ticket_hash, ticket_expires: a
// phone call's one stream. token_hash: the agent's token on the call (it opens no route: server.ts). transcript, notes: JSON
// lists of lines. twilio_ended: when Twilio said a live call ended. outcome: how it ended, in a line for the filer.
// blanked: when the sweep blanked its transcript and notes, 12 months on (null words without it: never handed over).
db.exec(`create table if not exists callouts (id integer primary key, created text not null, agent text not null, job integer,
  request integer not null unique, kind text not null, number text, digits text, who text not null, about text not null,
  why text not null, lang text not null, at text, status text not null default 'open', decided text, sid text,
  link_hash text unique, opens text, closes text, ticket_hash text unique, ticket_expires integer, token_hash text unique,
  started text, twilio_ended text, ended text, outcome text, transcript text, notes text, objected integer not null default 0,
  followup integer, blanked text)`);
redacted('callouts', 'who', 'about', 'why', 'transcript', 'notes');

type Kind = 'phone' | 'link';
export type Status =
  'open' | 'declined' | 'withdrawn' | 'approved' | 'dialling' | 'live' | 'done' | 'missed' | 'failed' | 'expired';
export type Callout = {
  id: number;
  created: string;
  agent: string;
  job: number | null;
  request: number;
  kind: Kind;
  number: string | null;
  digits: string | null;
  who: string;
  about: string;
  why: string;
  lang: words.Lang;
  at: string | null;
  status: Status;
  decided: string | null;
  sid: string | null;
  link_hash: string | null;
  opens: string | null;
  closes: string | null;
  ticket_hash: string | null;
  ticket_expires: number | null;
  token_hash: string | null;
  started: string | null;
  twilio_ended: string | null;
  ended: string | null;
  outcome: string | null;
  transcript: string | null;
  notes: string | null;
  objected: number;
  followup: number | null;
  blanked: string | null;
};

const CALLS_PER_HOUR = 3,
  MAX_WHO = 80,
  MAX_ABOUT = 80,
  MAX_WHY = 2000,
  MAX_CARD = 200;
export const MINUTE = 60_000,
  HOUR = 60 * MINUTE;
const ENDED: Status[] = ['declined', 'withdrawn', 'done', 'missed', 'failed', 'expired'];
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const now = () => new Date().toISOString();
export const byId = (id: number) => db.prepare('select * from callouts where id = ?').get(id) as Callout | undefined;
export const byRequest = (request: number) =>
  db.prepare('select * from callouts where request = ?').get(request) as Callout | undefined;

// ---- the agent's side: hq phone call
// A call out filed: who may file it and how often (rules), what it asks for (filing), then its card and its row (save)
export function file(agent: string, job: number, b: any) {
  const refused = rules(agent, job);
  if (refused) return refused;
  const call = filing(b);
  return Array.isArray(call) ? call : save(agent, job, call, b.topic);
}
type Refusal = [number, string];
type Filing = {
  kind: Kind;
  who: string;
  about: string;
  why: string;
  card: string;
  lang: words.Lang;
  at: string | null;
  digits: string | null;
  number: string | null;
};
// An agent in org.yaml, from a job that holds no customer's details, at most CALLS_PER_HOUR an hour
function rules(agent: string, job: number): Refusal | null {
  const caller = findAgent(agent);
  if (!caller || caller.temp || boardId(agent))
    return [403, "a call out is in the voice of an agent in org.yaml: file it from your lead's job, as your lead"];
  if (holdsCustomerData(job))
    return [
      403,
      "this job holds a customer's own details (it read or was handed them), and nothing of it goes to an " +
        'outside party. Hand the call to a job that holds none, with only what the call may say',
    ];
  const since = new Date(Date.now() - HOUR).toISOString();
  if (
    (db.prepare('select count(*) n from callouts where job = ? and created > ?').get(job, since) as { n: number }).n >=
    CALLS_PER_HOUR
  )
    return [429, `this job has filed ${CALLS_PER_HOUR} calls in the last hour, the most it may`];
  return null;
}
// The request, checked: a phone call or a link, its words, language and time, the digits, and the number to ring
function filing(b: any): Filing | Refusal {
  const kind: Kind | null =
    b.link === true && b.to == null ? 'link' : b.link !== true && typeof b.to === 'string' ? 'phone' : null;
  if (!kind) return [400, 'either --to <number> (a phone call) or --link (a join link for a call room)'];
  const who = line(b.who),
    about = line(b.about),
    why = typeof b.why === 'string' ? b.why.trim() : '',
    card = line(b.card);
  if (!who || who.length > MAX_WHO)
    return [400, `--who: the partner, 1 to ${MAX_WHO} characters on one line (a supplier's support desk)`];
  if (!about || about.length > MAX_ABOUT)
    return [
      400,
      `--about: what the call is about, 1 to ${MAX_ABOUT} characters, as the opening says it in the call's language ("calling about our parcel")`,
    ];
  if (!why || why.length > MAX_WHY)
    return [400, `the why (the file): what the call is for and what you may agree, 1 to ${MAX_WHY} characters`];
  if (!card || card.length > MAX_CARD)
    return [
      400,
      `--card: the card's text for the board, 1 to ${MAX_CARD} characters on one line: who, what we ask, what we may agree (the file folds under its More)`,
    ];
  if (!Object.hasOwn(words.LANGS, String(b.lang))) return [400, "--lang: the call's language, en, nl or de"];
  const at = atTime(b.at);
  if (at && typeof at === 'object') return [400, `--at ${at.why}`];
  const digits = b.digits == null ? null : String(b.digits);
  if (digits !== null && (kind !== 'phone' || !/^[0-9#*wW]{1,40}$/.test(digits)))
    return [
      400,
      "--digits: with --to only, the digits to type once it answers (0-9, # and *, w for half a second's wait)",
    ];
  const number = kind === 'phone' ? toRing(b.to) : null;
  if (Array.isArray(number)) return number;
  // (card)
  return { kind, who, about, why, card, lang: String(b.lang) as words.Lang, at, digits, number };
}
// --to: a number our line can ring; board: the board's own saved number, for a test call to the board, which no agent
// knows
function toRing(to: string): string | Refusal {
  const board = to === 'board';
  if (board && !dialable(secret('BOARD_PHONE_NUMBER'))) return [409, "--to board: the board's number isn't saved"];
  if (!secret('TWILIO_PHONE_NUMBER'))
    return [409, "the phone line isn't set up yet (no number of our own to call from): use --link"];
  const number = dialable(board ? secret('BOARD_PHONE_NUMBER') : to);
  if (!number)
    return [
      400,
      "--to: a phone number, in international form (+31 20 123 4567) or as it's written in our line's country (020 123 4567)",
    ];
  if (number === dialable(secret('TWILIO_PHONE_NUMBER'))) return [400, "--to is our own line's number"];
  return number;
}
// The board's card on the desk phone (Call, Don't call: callcard.ts), and the call's row
function save(agent: string, job: number, c: Filing, topic: unknown) {
  const title = c.kind === 'phone' ? `Call ${c.who} about ${c.about}` : `A call room with ${c.who} about ${c.about}`;
  const card = createRequest({
    kind: 'call',
    title,
    body: `${c.card}\n\n---\n\n${c.why}`, // (card.js: the details under ---, behind More)
    urgency: 'today',
    agent,
    job,
    topic: topic ?? 'calls',
  });
  if (typeof card === 'number') return card;
  const { lastInsertRowid } = db
    .prepare(
      `insert into callouts (created, agent, job, request, kind, number, digits, who, about, why, lang, at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(now(), agent, job, card.id, c.kind, c.number, c.digits, c.who, c.about, c.why, c.lang, c.at);
  return { id: Number(lastInsertRowid), request: card.id };
}

// hq phone call <id>: its state, to the agent who filed it; once it has ended, the notes and transcript too, to the job
// that filed it and its follow-up only
export function forAgent(id: number, agent: string, job: number) {
  const c = byId(id);
  if (!c || (c.agent !== agent && filer(c) !== agent)) return 404;
  const reads = job === c.job || job === c.followup;
  return {
    ...view(c),
    why: c.why,
    created: c.created,
    decided: c.decided,
    started: c.started,
    ended: c.ended,
    outcome: c.outcome,
    followup: c.followup,
    objected: !!c.objected,
    ...(reads
      ? {
          notes: list(c.notes),
          transcript: list(c.transcript),
          kept: !!c.ended && (c.transcript !== null || c.notes !== null),
        }
      : { left_out: 'its notes and transcript go only to the job that filed it and its follow-up' }),
  };
}
// hq close on its card: the agent withdraws its own open call (one filed again in its place). The card is done with no
// answer (jobs.closeRequest: only the card's agent, a team member's only from its own job).
export function withdraw(request: number, agent: string, job?: number) {
  const c = byRequest(request);
  if (c?.agent !== agent || c.status !== 'open') return 404;
  const closed = closeRequest(request, agent, job);
  if (typeof closed === 'number') return closed;
  end(c, 'withdrawn', 'withdrawn by its filer');
  publish({ type: 'log', agent, text: `Withdrew call #${c.id}: it wasn't made` });
  return closed;
}

// ---- helpers
// The call ends: its state, its number gone, and one follow-up job for its filer
export function finish(c: Callout, status: Status, outcome: string) {
  end(c, status, outcome);
  const brief = words.followUp({
    id: c.id,
    kind: c.kind,
    who: c.who,
    why: c.why,
    outcome,
    status,
    objected: !!c.objected,
    notes: list(c.notes).length,
    lines: list(c.transcript).length,
  });
  const job = createJob({
    agent: filer(c),
    title: `Follow up on your call with ${c.who}`,
    prompt: brief,
    // (the task that asked for the call: its code too.)
    ...(c.job ? { from: c.job, code: codeOf(c.job) ?? undefined } : {}),
  }).id;
  db.prepare('update callouts set followup = ? where id = ?').run(job, c.id);
  publish({
    type: 'log',
    agent: c.agent,
    text: `Call #${c.id} with ${c.who} ended (${status}): follow-up job #${job}`,
  });
}
export function end(c: Callout, status: Status, outcome: string) {
  db.prepare(
    `update callouts set status = ?, outcome = ?, ended = ?, number = null, digits = null, ticket_hash = null, token_hash = null,
    decided = coalesce(decided, ?) where id = ?`,
  ).run(status, outcome, now(), now(), c.id);
}
// Who hears it: the agent who filed it, or the CEO once that agent has left org.yaml
const filer = (c: Pick<Callout, 'agent'>) => (findAgent(c.agent) ? c.agent : ceo());
export const agentName = (agent: string) => String(findAgent(agent)?.name ?? agent);
export const list = (json: string | null) => (json ? (JSON.parse(json) as string[]) : []);
const line = (v: unknown) => (typeof v === 'string' && !/[\r\n]/.test(v.trim()) ? v.trim() : '');
// What the board's card and the agent see: never the number, only its last 3 digits
export const view = (c: Callout) => ({
  id: c.id,
  kind: c.kind,
  who: c.who,
  about: c.about,
  lang: c.lang,
  at: c.at,
  status: c.status,
  ending: c.number ? c.number.slice(-3) : null,
  digits: !!c.digits,
  name: agentName(c.agent),
  hours: hoursText(),
  timeZone: timeZone(),
  ...(c.kind === 'link' && c.opens ? { opens: c.opens, closes: c.closes } : {}),
  ...(ENDED.includes(c.status) ? { outcome: c.outcome } : {}),
});
