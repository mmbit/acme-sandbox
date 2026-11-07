// Why a seat's claims come back empty, so a stall explains itself. Each seat has one row (db.ts empty_claims) while its
// claims do: the first check the best job for it failed (jobs.ts claim). The worker claims thousands of times an hour.
// A claim writes only when its reason changes, and its last sighting at most once a minute. A claim that starts work
// clears the row.
import { db } from './db.ts';
import { storedEmptyClaim, type StoredEmptyClaim } from './seatstatus.ts';
import type { EmptyClaim } from '../../worker/hq/seatwords.ts';

const SEEN_MS = 60_000;
// Each seat's row as last written (null: none), so an unchanged reason costs no read or write.
const kept = new Map<string, { reason: string; seen: number } | null>();
const reasonOf = (e: EmptyClaim) =>
  JSON.stringify([e.check, e.job, e.against ?? null, e.until ?? null, e.wait ?? null]);

export function record(seat: string, empty: EmptyClaim, now = Date.now()) {
  const reason = reasonOf(empty),
    last = known(seat);
  if (last?.reason === reason) {
    if (now - last.seen < SEEN_MS) return;
    db.prepare('update empty_claims set seen = ? where seat = ?').run(now, seat);
  } else
    db.prepare(
      `insert or replace into empty_claims (seat, check_name, job, against, until, wait, since, seen)
      values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seat,
      empty.check,
      empty.job,
      empty.against ?? null,
      empty.until ?? null,
      empty.wait ? JSON.stringify(empty.wait) : null,
      now,
      now,
    );
  kept.set(seat, { reason, seen: now });
}

export function clear(seat: string) {
  if (known(seat) === null) return;
  db.prepare('delete from empty_claims where seat = ?').run(seat);
  kept.set(seat, null);
}

function known(seat: string) {
  if (!kept.has(seat)) {
    const row = db.prepare('select * from empty_claims where seat = ?').get(seat) as StoredEmptyClaim | undefined;
    kept.set(seat, row ? { reason: reasonOf(storedEmptyClaim(row)), seen: row.seen } : null);
  }
  return kept.get(seat)!;
}
