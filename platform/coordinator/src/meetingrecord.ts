// An ended meeting's record (meetings.ts): its transcript, a search document (memory.ts), and its outcome in the hq history
// of everyone in it.
import { db, meetingChanges } from './db.ts';
import { ceo } from './company.ts';
import { seats, type Line, type Meeting, type Seat } from './meetings.ts';

// The transcripts of ended meetings, a search document each (memory.ts): who was there, the lines, what each changed
export function transcripts() {
  return (db.prepare("select * from meetings where status = 'done' order by id").all() as Meeting[]).map(m => {
    const lines = db
      .prepare('select at, agent, text from meeting_lines where meeting = ? order by id')
      .all(m.id) as Line[];
    const out = seats(m.id).map(s => `${s.agent} changed: ${s.changed ?? '(no line)'}`);
    const owned = meetingChanges(m.id).map(c => `${c.by}'s plan change, ${c.project}: ${c.what}`);
    return {
      id: m.id,
      title: `Meeting #${m.id}: ${m.topic}, ${(m.started ?? m.created).slice(0, 10)}`,
      text: [...lines.map(l => `${l.at.slice(11, 16)} ${l.agent}: ${l.text}`), ...out, ...owned].join('\n'),
    };
  });
}

// The ended meetings an agent sat in, newest first, for its hq history (memory.ts): each seat's line of what it changed
// (none while its hand-in was taken back), the chair's summary, why it ended and the transcript's pointer. A seat counts
// once its job started: one cancelled before it ever ran wasn't in the meeting.
export function attended(agent: string, limit: number, id?: number) {
  const startedSeats = 'meeting_seats s join jobs j on j.id = s.job and j.started is not null';
  const sat = `select 1 from ${startedSeats} where s.meeting = m.id and s.agent = ?`;
  const chair = ceo();
  return (
    db
      .prepare(
        `select * from meetings m where status = 'done' and exists (${sat})${id === undefined ? '' : ' and id = ?'} order by id desc limit ?`,
      )
      .all(agent, ...(id === undefined ? [] : [id]), limit) as Meeting[]
  ).map(m => ({
    id: m.id,
    topic: m.topic,
    ended: m.ended,
    why: m.why,
    summary: m.summary,
    seats: (db.prepare(`select s.* from ${startedSeats} where s.meeting = ? order by s.rowid`).all(m.id) as Seat[]).map(
      s => ({ agent: s.agent, chair: s.agent === chair, changed: s.handed ? s.changed : null }),
    ),
    pointer: `hq meeting ${m.id}`,
  }));
}
