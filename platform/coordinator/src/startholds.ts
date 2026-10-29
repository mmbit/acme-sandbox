// What stood in the way of a ready job's start, over time, for hq estimate --calibration's line (threadwaits.ts): each
// seat's state as the worker reported it (jobs.ts setSeat), a spell per state, and the worker's spells short of memory
// (room.ts reportRoom's short and since). The seats table and room.ts keep only the last report, so these are the record.
// A seat's spell: its state as reported ('ready', 'draining' at its drain level, 'sleeping' at a limit, 'closed',
// 'login', 'paused') and whether it was paced (its week ahead of pace, so it took only work due before its reset). A
// state lasts until the next report changes it; the worker reports every minute. Kept KEEP_MS after they end.
import { db } from './db.ts';

const KEEP_MS = 60 * 24 * 60 * 60_000;
db.exec(`create table if not exists seat_spells (id integer primary key, seat text not null, engine text not null,
    state text not null, paced integer not null, began integer not null, ended integer);
  create index if not exists seat_spells_open on seat_spells (seat, ended);
  create table if not exists room_spells (id integer primary key, began integer not null, ended integer)`);

type SeatSpell = { id: number; engine: string; state: string; paced: number };

// A seat's report, as setSeat has just written it: a new spell when its engine, state or pace changed
export function seatReported(seat: string, now = Date.now()) {
  const s = db
    .prepare(
      `select engine, state, iif(pace is null or week_resets is null or week_resets <= ?, 0, 1) paced from seats
      where id = ?`,
    )
    .get(now, seat) as Omit<SeatSpell, 'id'> | undefined;
  const open = db.prepare('select * from seat_spells where seat = ? and ended is null').get(seat) as
    SeatSpell | undefined;
  if (!s || (open && open.engine === s.engine && open.state === s.state && open.paced === s.paced)) return;
  if (open) db.prepare('update seat_spells set ended = ? where id = ?').run(now, open.id);
  db.prepare('insert into seat_spells (seat, engine, state, paced, began) values (?, ?, ?, ?, ?)').run(
    seat,
    s.engine,
    s.state,
    s.paced,
    now,
  );
  db.prepare('delete from seat_spells where ended < ?').run(now - KEEP_MS);
}

// Seats removed from the worker's list: their last spell ends
export function seatsGone(now = Date.now()) {
  db.prepare('update seat_spells set ended = ? where ended is null and seat not in (select id from seats)').run(now);
}

// The worker's room report: short opens a spell from its `since`, unless one is open; not short ends it
export function roomReported(short: boolean, since: number | undefined, now = Date.now()) {
  const open = db.prepare('select id from room_spells where ended is null').get() as { id: number } | undefined;
  if (!short && open) db.prepare('update room_spells set ended = ? where id = ?').run(now, open.id);
  if (!short || open) return;
  db.prepare('insert into room_spells (began) values (?)').run(since ?? now);
  db.prepare('delete from room_spells where ended < ?').run(now - KEEP_MS);
}

// The spells over a span, and from when they say anything (null: nothing recorded yet)
export function spellsOver(from: number, to: number, now = Date.now()) {
  const first = (db.prepare('select min(began) began from seat_spells').get() as { began: number | null }).began;
  const seats = db
    .prepare('select engine, state, paced, began, ended from seat_spells where began < ? and coalesce(ended, ?) > ?')
    .all(to, to + 1, from) as { engine: string; state: string; paced: number; began: number; ended: number | null }[];
  const short = db
    .prepare('select began, ended from room_spells where began < ? and coalesce(ended, ?) > ?')
    .all(to, to + 1, from) as { began: number; ended: number | null }[];
  const end = (t: number | null) => t ?? Infinity;
  return {
    recorded: first === null ? null : Math.max(first, now - KEEP_MS),
    // (a seat takes work only ready and not paced)
    seats: seats.map(s => ({
      engine: s.engine,
      ready: s.state === 'ready' && !s.paced,
      began: s.began,
      ended: end(s.ended),
    })),
    short: short.map(s => ({ began: s.began, ended: end(s.ended) })),
  };
}
export type Spells = ReturnType<typeof spellsOver>;
