// The meetings in the board's projects view (projects.ts listProjectBoard): their seats, each with its meeting.
import { db } from './db.ts';
import { jobRows } from './jobs.ts';
import { boardJobs, boardMeeting } from './boardnames.ts';

// The meetings' seats (meetings.ts), their own group beside the unsorted work: the open ones, and every seat of the
// last RECENT_MEETINGS to end, each with its meeting: its number and its topic as the board reads it (boardnames.ts
// boardMeeting).
const RECENT_MEETINGS = 3;
export function meetingSeats(loose: { id: number; kind: string }[], t: number) {
  const seats = db
    .prepare(
      `select s.job, m.id meeting, m.topic from meeting_seats s join meetings m on m.id = s.meeting
      where m.status != 'done' or m.id in (select id from meetings where status = 'done' order by ended desc, id desc
      limit ${RECENT_MEETINGS})`,
    )
    .all() as { job: number; meeting: number; topic: string }[];
  const of = new Map(seats.map(s => [s.job, s]));
  const open = loose.filter(j => j.kind === 'meeting' && of.has(j.id)),
    listed = new Set(open.map(j => j.id)),
    ended = seats.filter(s => !listed.has(s.job)).map(s => s.job);
  const rows = [...open, ...(ended.length ? boardJobs(jobRows(`j.id in (${ended.join(', ')})`, t)) : [])];
  const named = new Map(
    seats.map(s => [s.meeting, { id: s.meeting, ...boardMeeting({ id: s.meeting, topic: s.topic }) }]),
  );
  return rows.map(j => ({ ...j, meeting: named.get(of.get(j.id)!.meeting)! }));
}
