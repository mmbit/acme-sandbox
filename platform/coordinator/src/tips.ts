// The feature tips (hq/shell/tips.js): a tip card on the desk phone the first time its feature matters, offered by the
// hook of the event that brings it. Once per company, at most one a day, after the cards that need an answer, never
// ringing; Got it files it with the answered cards, and one setting turns tips off.
import { db, once, remember, setting } from './db.ts';
import { waitingCards } from './push.ts';
import { cap, names } from './company.ts';
import { tipOf } from '../../hq/shell/tips.js';

const DAY_MS = 24 * 3600_000,
  OFF = 'tips.off';
export const KIND = 'tip';
const isTip = (card: { kind: string }) => card.kind === KIND;

// request: the tip's card; at: when it shows (a day after the one before, at the earliest); details: the event's, as JSON,
// for its Show me (End now's share)
db.exec(
  "create table if not exists tips (key text primary key, request integer not null, at text not null, details text not null default '{}')",
);
// The pausing tip's cards, filed before it became the deadlines tip: its advice and key.
once('2026-10-29-pausing-tip-is-deadlines', () => {
  db.prepare(
    "update requests set body = replace(body, ?, ?) where id in (select request from tips where key = 'pausing')",
  ).run(
    'You can have work paused to make room for what matters more, and started again when you like: ask on the intercom. Projects shows what’s running.',
    // (in the plain names those cards were written in: and company.ts may not have loaded yet)
    tipOf('deadlines', { phone: 'desk phone', intercom: 'intercom' })!.lines({}),
  );
  db.exec("update tips set key = 'deadlines' where key = 'pausing'");
});

// The tip for an event that just happened, with the event's details for its lines: filed unless tips are off or it
// came before. A tip within a day of the last one waits off the phone until that day is up (requests.hidden_until).
// Returns the card's id, or null.
export function offer(key: string, details: Record<string, unknown> = {}, now = Date.now()) {
  const tip = tipOf(key, names());
  if (!tip) throw new Error(`no tip named ${key}`);
  if (off() || db.prepare('select 1 from tips where key = ?').get(key)) return null;
  const last = (db.prepare('select max(at) at from tips').get() as { at: string | null }).at;
  const at = Math.max(now, last ? Date.parse(last) + DAY_MS : 0);
  const { lastInsertRowid } = db
    .prepare(
      `insert into requests (created, kind, title, body, urgency, topic, hidden_until) values (?, '${KIND}', ?, ?, 'tip', 'Tips', ?)`,
    )
    .run(new Date(now).toISOString(), tip.title, tip.lines(details), at > now ? new Date(at).toISOString() : null);
  const id = Number(lastInsertRowid);
  db.prepare('insert into tips (key, request, at, details) values (?, ?, ?, ?)').run(
    key,
    id,
    new Date(at).toISOString(),
    JSON.stringify(details),
  );
  return id;
}

// A tip still to come: not offered yet, and tips on. A hook whose check costs more asks this first.
export const due = (key: string) => !off() && !db.prepare('select 1 from tips where key = ?').get(key);

// A card that shows on the desk phone, as it's filed or as later.ts lets it go. The first card from an agent brings the
// desk phone's tip. The first time CALLS_WAITING cards wait at once, the calls' tip comes.
const CALLS_WAITING = 3;
export function cardShows(card: { kind: string; agent: string | null }) {
  if (isTip(card)) return;
  if (card.agent) offer('deskphone');
  if (waitingCards() >= CALLS_WAITING) offer('calls');
}

// A seat's reading (jobs.ts setSeat): the first seat past SEAT_WEEK of its week brings the seats' tip, whether or not
// the seat warning is on
const SEAT_WEEK = 0.8;
export const seatRead = (seat: string, week: number | null) => {
  if (week !== null && week >= SEAT_WEEK) offer('seats', { seat });
};

// The tips that time passing brings, with the minute's sweep (server.ts): a run waiting long for the server, the
// company's seventh day, a full day with nothing asked on the intercom, and an open thread past its deadline.
const RUN_WAIT_MS = 30 * 60_000,
  LOOK_DAYS = 7;
export function sweep(now = Date.now()) {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const run = due('machines') && waitingRun(ago(RUN_WAIT_MS));
  if (run) offer('machines', { run: run.name, minutes: Math.floor((now - Date.parse(run.created)) / 60_000) }, now);
  const born = (db.prepare('select min(created) at from jobs').get() as { at: string | null }).at;
  if (born && born <= ago(LOOK_DAYS * DAY_MS)) offer('look', {}, now);
  if (born && born <= ago(DAY_MS) && due('asking') && !boardAsked(ago(DAY_MS))) offer('asking', {}, now);
  const late = due('deadlines') && lateThread(now);
  if (late) offer('deadlines', { thread: late.name }, now);
}
// The oldest hq run waiting since `before` for a helper to take it, named for the board by whose it is
function waitingRun(before: string) {
  const run = db
    .prepare("select agent, created from helper_runs where state = 'waiting' and created <= ? order by id limit 1")
    .get(before) as { agent: string; created: string } | undefined;
  return run && { name: `${cap(run.agent)}'s run`, created: run.created };
}
const boardAsked = (since: string) => !!db.prepare("select 1 from chat where who = 'board' and ts > ?").get(since);
const lateThread = (now: number) =>
  db.prepare("select name from threads where status = 'open' and deadline <= ? order by deadline limit 1").get(now) as
    { name: string } | undefined;

// The events only HQ's page sees, as they happen there. The logo pressed brings the look's tip. An urgent card on a
// device without notifications brings theirs, whatever the company's other devices have (push.js urgentCards).
// An event's name comes from the page: one that isn't in the table is refused.
const IN_PAGE: Record<string, () => number | null> = {
  look: () => offer('look', { pressed: true }),
  notifications: () => offer('notifications'),
};
export const offerEventTip = (key: string) => (Object.hasOwn(IN_PAGE, key) ? { id: IN_PAGE[key]() } : 400);

// The board's Got it, or the control Show me pointed at pressed (shown): the tip goes to the answered cards.
export function endTip(id: number, shown = false) {
  const ended = db
    .prepare(
      `update requests set status = 'answered', answer = ?, answered = ? where id = ? and kind = '${KIND}' and status = 'open'`,
    )
    .run(shown ? 'Shown' : 'Got it', new Date().toISOString(), id);
  return ended.changes ? { ok: true } : 404;
}

export const off = () => setting(OFF) === '1';
export const getTips = () => ({ off: off() });
// Off for the whole company: no new tips, and those waiting go with the answered cards.
export function setTips(body: { off?: unknown }) {
  if (typeof body.off !== 'boolean') return 400;
  remember(OFF, body.off ? '1' : null);
  if (body.off)
    db.prepare(
      `update requests set status = 'answered', answer = 'Tips turned off', answered = ? where kind = '${KIND}' and status = 'open'`,
    ).run(new Date().toISOString());
  return getTips();
}

// A tip waiting its day off the phone (offer), not one the board put off with Later: SQL on a requests row
export const WAITING_ITS_DAY = `(kind = '${KIND}' and hidden_until = (select at from tips where tips.request = requests.id))`;

// The desk phone's cards with each tip's name and its event's details on it (jobs.ts lists the tips after the cards
// that need an answer)
export function onPhone<Card extends { id: number; kind: string }>(cards: Card[]) {
  const rows = db.prepare('select key, request, details from tips').all() as TipRow[],
    tips = new Map(rows.map(t => [t.request, t]));
  return cards.map(c => {
    if (!isTip(c)) return c;
    const t = tips.get(c.id)!;
    return { ...c, tip: t.key, details: JSON.parse(t.details) };
  });
}
type TipRow = { key: string; request: number; details: string };
