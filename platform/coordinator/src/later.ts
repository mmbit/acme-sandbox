// Cards for later. An open card can stay off the board's desk phone until a day:
// its author files it with --visible-from (hq ask, hq request), or the board snoozes it from the card. Until then it's
// still open, nothing closes or expires, and a job waiting on its answer still waits; then it comes back as a new card
// does: first in the list, unread, and ringing if it's urgent (sweep). requests.hidden_until holds the time; jobs.ts
// leaves a card out of the desk phone's list while it's ahead (SHOWN). A card can be held the same way until work it
// waits for is live (holdsFor).
import { db } from './db.ts';
import { companyDay, companyMoment } from './company.ts';
import { announceRequest } from './push.ts';
import * as tips from './tips.ts';
import * as approvals from './approvals.ts';
import { followsUp } from './ledger.ts';
import * as wakes from './wakes.ts';
import { HELD, SHOWN } from './shown.ts';

const DAY_MS = 24 * 3600_000;
const AHEAD_MS = 366 * DAY_MS;
// The desk phone's open cards (shown.ts)
export { SHOWN };
// Whether a card's hidden_until is still ahead (at `now`, an ISO time): the same rule as SHOWN, for a row already read
export const isHidden = (hiddenUntil: string | null, now = new Date().toISOString()) =>
  !!hiddenUntil && hiddenUntil > now;

// When a card shows again, from a day ('2026-10-13': 08:00 that day on the company's clock) or a UTC time
// ('2026-10-13T08:00Z'), as an ISO time. A time that's already here hides nothing (at: null); one more than a year ahead,
// or anything else, isn't taken.
export function hiddenUntil(
  given: unknown,
  now = Date.now(),
): { ok: true; at: string | null } | { ok: false; why: string } {
  if (given == null || given === '') return { ok: true, at: null };
  const text = String(given).trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  let at = NaN;
  if (day) at = morning(Number(day[1]), Number(day[2]), Number(day[3]));
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(text)) at = Date.parse(text);
  // Date.parse and Date.UTC move a day that doesn't exist (31 February) on into the next month: a typo, not a day
  if (Number.isNaN(at) || !sameDay(text, readBack(at, day !== null)))
    return {
      ok: false,
      why: `can't read "${text.slice(0, 40)}": give a day (2026-10-13, from 08:00 on the company's clock) or a UTC time (2026-10-13T08:00Z)`,
    };
  if (at > now + AHEAD_MS) return { ok: false, why: `${text} is more than a year ahead` };
  return { ok: true, at: at > now ? new Date(at).toISOString() : null };
}
const sameDay = (given: string, read: string) => given.slice(0, 10) === read.slice(0, 10);
const readBack = (at: number, isDay: boolean) => (isDay ? companyDay(at) : new Date(at).toISOString());

// A day's cards come back at 08:00 on the company's clock: a phone cleared before bed stays clear until the morning
const BACK_HOUR = 8;
// 08:00 on a day on the company's clock, in ms, found from the zone's offset at that moment
const morning = (y: number, m: number, d: number) => companyMoment(y, m, d, BACK_HOUR, 0);

// The board snoozes an open card until a day it picks (08:00 that day on the company's clock), or with day null brings a
// hidden one back now, as a new card. Any open card, whoever filed it.
export function snoozeRequest(id: number, day: unknown) {
  const now = new Date().toISOString();
  if (!db.prepare("select 1 from requests where id = ? and status = 'open'").get(id)) return 404;
  if (day === null) {
    // it comes back as a new card through `changed`: a hidden_until of now would have sweep() ring it for an urgent one
    const back = db
      .prepare(
        'update requests set hidden_until = null, changed = ? where id = ? and hidden_until > ? returning kind, agent',
      )
      .get(now, id, now) as { kind: string; agent: string | null } | undefined;
    if (back && !heldFor(id)) tips.cardShows(back);
    return { ok: true, until: null };
  }
  const until = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? hiddenUntil(day) : null;
  if (!until?.ok || !until.at) return 400; // a day still to come, within a year
  db.prepare('update requests set hidden_until = ? where id = ?').run(until.at, id);
  return { ok: true, until: until.at, day };
}

// The cards for later, soonest back first: what the desk phone's Later list shows (no text: Bring back shows it whole).
// Each says its day on the company's clock (`day`), which is the day the phone shows, wherever the phone is. A tip
// waiting its day (tips.ts) isn't one the board put aside. A tip put off with Later is. (tips)
export function listLaterRequests() {
  const rows = db
    .prepare(
      `select id, created, agent, kind, title, topic, hidden_until from requests
  where status = 'open' and not ${tips.WAITING_ITS_DAY} and not ${HELD} and hidden_until > ? order by hidden_until, id`,
    )
    .all(new Date().toISOString()) as { hidden_until: string }[];
  return rows.map(r => ({ ...r, day: companyDay(Date.parse(r.hidden_until)) }));
}

// Cards held until work is live. A card hq ask files waits off the desk phone for
// work to be merged and deployed, as hq job --when deployed:<job> hears it (wakes.ts deployed): the work it names with
// --when deployed:<job> or deployed:pr:<n> (what the job handed out that the card is about), and, from a job doing a
// call's work (the call's follow-up, or a job carrying one of its items), that job's own. So the board reads it once it
// can see what it's about. Work that ends without a pull request, or whose pull request is closed, lets the card go
// then. Held, a card is open as one for later is, and shows as a new card once all its work is live. Its answer is
// never waited for in a session (hq wait would wait for that work, its own merge for call work): the step that needs it
// is a job --after request:<id>. So a job doing a call's work can't park on a card (hq request) either.

// The work a card from `job` waits for (wake args: '<job>' or 'pr:<n>'), with hq ask's --when, or why it can't
export function holdsFor(job: number | undefined, when: unknown): string[] | string {
  const named = wakes.readWhen(when);
  if (typeof named === 'string') return named;
  if (named.some(w => w.kind !== 'deployed'))
    return 'a card waits only for work going live: --when deployed:<job> or deployed:pr:<n> (a day: --visible-from)';
  const own = doesCallWork(job) ? [String(job)] : [];
  return [...new Set([...own, ...named.map(w => w.arg)])];
}

// Why `job` can't park on a card (hq request), or null: its card would wait for the job's own merge
export const parkProblem = (job: number) =>
  doesCallWork(job)
    ? "this job does a call's work, so its card is held off the desk phone until its work is merged and deployed, and parking would wait for its own merge: ask with hq ask, queue the step that needs the answer with hq job --after request:<id>, and finish this job"
    : null;
// (not the intercom's chat: it hears a call about its own card, but its turns have no work to go live)
const doesCallWork = (job: number | undefined) =>
  job !== undefined &&
  !db.prepare("select 1 from jobs where id = ? and kind = 'chat'").get(job) &&
  (followsUp(job) || !!db.prepare('select 1 from jobs where id = ? and item is not null').get(job));

// The work an open card is held for, in words ("the work of #12 and pull request #40"), or null
export function heldFor(id: number) {
  const works = (
    db
      .prepare(
        "select h.work from request_holds h join requests r on r.id = h.request where h.request = ? and r.status = 'open' order by h.rowid",
      )
      .all(id) as { work: string }[]
  ).map(h => wakes.workOf(h.work));
  return works.length ? `the work of ${works.join(' and ')}` : null;
}

// Why the job that filed a held card can't wait for its answer in its session (hq wait), or null
export function waitProblem(id: number) {
  const work = heldFor(id);
  return work
    ? `card #${id} is held off the desk phone until ${work} is merged and deployed, so hq wait would wait for that (for a call's work, for this job's own merge): queue the step that needs the answer with hq job --after request:${id}, and finish this job`
    : null;
}

// Every minute (server.ts): a card whose time came since the last look rings the board's devices as a new one would
// (announceRequest: only an urgent one does). A restart in between skips that ring. The card shows all the same. Held
// cards whose work is live are let go (release). Returns the cards it looked at.
let lastSweepAt = new Date().toISOString();
export function sweep() {
  const now = new Date().toISOString();
  const due = db
    .prepare(
      `select ${RINGING} from requests where status = 'open' and not ${HELD} and hidden_until > ? and hidden_until <= ?`,
    )
    .all(lastSweepAt, now) as Ringing[];
  lastSweepAt = now;
  const released = release(now);
  for (const r of due) ring(r);
  return [...due.map(r => r.id), ...released];
}

// The held cards whose work is all live, or will never be, let go: each shows as a new card and rings as one would
// (unless it's also for later: then it rings when its time comes). Returns those it let go.
function release(now: string) {
  const holds = db
    .prepare(
      "select h.request, h.work from request_holds h join requests r on r.id = h.request where r.status = 'open'",
    )
    .all() as { request: number; work: string }[];
  if (!holds.length) return [];
  wakes.readDeploys();
  const met = holds.filter(h => wakes.deployed(h.work) !== null);
  for (const h of met) db.prepare('delete from request_holds where request = ? and work = ?').run(h.request, h.work);
  const letGo = [...new Set(met.map(h => h.request))].filter(
    id => !db.prepare('select 1 from request_holds where request = ?').get(id),
  );
  for (const id of letGo) {
    const r = db.prepare(`update requests set changed = ? where id = ? returning ${RINGING}`).get(now, id) as Ringing;
    if (!isHidden(r.hidden_until, now)) ring(r);
  }
  return letGo;
}

// A card ringing the board's devices as it shows (announceRequest), and bringing its tip (tips.ts), from its row
type Ringing = {
  id: number;
  kind: string;
  agent: string | null;
  title: string;
  urgency: string;
  approves: string | null;
  hidden_until: string | null;
};
const RINGING = 'id, kind, agent, title, urgency, approves, hidden_until';
function ring(r: Ringing) {
  announceRequest({
    id: r.id,
    kind: r.kind,
    title: r.title,
    urgency: r.urgency,
    grant: r.approves ? approvals.describe(r.approves) : undefined,
  });
  tips.cardShows(r);
}
