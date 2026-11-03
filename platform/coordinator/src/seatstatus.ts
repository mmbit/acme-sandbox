// Current per-seat admission and active runs for the board and agent tools, read from the database it's given: the
// coordinator's own, or the status report's (infra/report.sh), which must not open it through db.ts.
import type { DatabaseSync } from 'node:sqlite';
import { seatStatusesOf, type SeatRow } from '../../worker/src/seatstatus.ts';

export function seatStatuses(database: DatabaseSync, now = Date.now()) {
  const rows = database
    .prepare(
      `select s.id, s.engine, s.state, s.until, s.util, s.resets,
    s.week, s.week_resets, l.stop, s.credits from seats s left join seat_list l on l.id = s.id`,
    )
    .all() as SeatRow[];
  const active = database
    .prepare('select seat, count(*) running from runs where ended is null group by seat')
    .all() as { seat: string; running: number }[];
  const running = new Map(active.map(row => [row.seat, row.running]));
  const pacingSetting = database.prepare("select value from settings where key = 'seats.pacing'").get() as
    { value: string } | undefined;
  return seatStatusesOf(rows, pacingSetting?.value !== 'off', running, now);
}
