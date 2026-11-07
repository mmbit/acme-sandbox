// Current per-seat admission and active runs for the board and agent tools, read from the database it's given: the
// coordinator's own, or the status report's (infra/report.sh), which must not open it through db.ts. With each, why its
// claims come back empty while they do (emptyclaims.ts).
import type { DatabaseSync } from 'node:sqlite';
import { seatStatusesOf, type SeatRow } from '../../worker/src/seatstatus.ts';
import type { EmptyClaim } from '../../worker/hq/seatwords.ts';
import type { Wait } from '../../worker/hq/waits.ts';

export function seatStatuses(database: DatabaseSync, now = Date.now()) {
  const rows = database
    .prepare(
      `select s.id, s.engine, s.state, s.until, s.util, s.resets,
    s.week, s.week_resets, l.stop, s.credits, s.pace_runs, s.pace_rest, s.held_until from seats s
    left join seat_list l on l.id = s.id`,
    )
    .all() as SeatRow[];
  const active = database
    .prepare('select seat, count(*) running from runs where ended is null group by seat')
    .all() as { seat: string; running: number }[];
  const running = new Map(active.map(row => [row.seat, row.running]));
  const pacingSetting = database.prepare("select value from settings where key = 'seats.pacing'").get() as
    { value: string } | undefined;
  const statuses = seatStatusesOf(rows, pacingSetting?.value !== 'off', running, now);
  const empties = database.prepare('select * from empty_claims').all() as (StoredEmptyClaim & { seat: string })[];
  for (const { seat, ...empty } of empties) {
    const status = statuses.get(seat);
    if (status) status.empty = storedEmptyClaim(empty);
  }
  return statuses;
}

// A seat's empty claim as stored (db.ts empty_claims), and as the claim gave it (emptyclaims.ts).
export type StoredEmptyClaim = Omit<EmptyClaim, 'check' | 'wait'> & {
  check_name: EmptyClaim['check'];
  wait: string | null;
  since: number;
  seen: number;
};
export const storedEmptyClaim = ({ check_name, wait, ...row }: StoredEmptyClaim) => ({
  ...row,
  check: check_name,
  wait: wait === null ? null : (JSON.parse(wait) as Wait),
});
