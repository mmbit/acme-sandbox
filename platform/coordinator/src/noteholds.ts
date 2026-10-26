// What holds the work the board's notes are in or would go to (routing.ts), so that they'd wait with it: read from the
// play's outlook, and the notes in such work, for the play's after-hook that gives them back (feedback.ts sendBack) and
// HQ's Notes (feedback.ts listNotes).
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import * as forecast from './forecast.ts';
import type { Forecast } from './forecast.ts';
import { findProject, findThread } from './projects.ts';
import * as pauses from './pauses.ts';

// What holds open work, so that notes in it would wait with it: a pause on its thread or project, or the desk's (what it
// pauses: any pause holds until it's resumed, pauses.ts), or one on work it waits for that stalls it, or a card of the
// board's, its own or that of the work it waits for: the play's outlook reads the whole chain (playoutlook.ts). Not the
// board's pause of the whole company, which holds every job alike, or the seats: they hold all work, not this. Null for
// work that can start, and for any that has.
export type Hold = { pause: string } | { card: number };
export function holdOf(job: number, f: Forecast = forecast.current()): Hold | null {
  if (!db.prepare("select 1 from jobs where id = ? and status = 'queued' and session is null").get(job)) return null;
  const paused = jobs.pausedOn(job);
  if (paused) return { pause: paused };
  for (const w of f.usual.get(job)?.waits ?? []) {
    if (w.on === 'stalled' && w.pause) return { pause: w.pause };
    if (w.on === 'board' && w.request) return { card: w.request };
  }
  return null;
}
// A hold in an agent's words (hq route, a refusal, a note sent back), and in the board's (HQ's notes: feedback.ts)
export const holdWords = (h: Hold) =>
  'pause' in h ? `${h.pause} is paused` : `it waits for the board's answer on card #${h.card}`;
export const boardHoldWords = (h: Hold) =>
  'pause' in h ? `${pauseName(h.pause)} is paused` : `it waits for your answer on card #${h.card}`;
const pauseName = (target: string) => findThread(target)?.name ?? findProject(target)?.name ?? jobs.pauseName(target);

// Why a new task of notes can't go where it's placed (server.ts, once jobPlacement resolved it): the card it waits for
// (still open: jobOrigin took only an open one), the thread it goes in (named, new or inherited) paused, which holds its
// queued work until it's resumed (backlog.ts holdForPauses), or held work it would wait for: a queued task ahead of it
// there, or the job it goes after. Undefined when none is.
export type Place = { thread: string | null; after: number | null; card: number | null };
export function placeRefusal({ thread, after, card }: Place) {
  if (card !== null)
    return `it would wait for the board's answer on card #${card}, and its notes with it: queue the notes' task without --after request, and the step that needs the answer apart`;
  const [paused] = pauses.holding(thread);
  if (paused)
    return `${paused.target} is paused, so a task of notes there would wait with it: put it in a thread that isn't held`;
  const f = forecast.current();
  const queued = thread
    ? (db.prepare("select id from jobs where thread = ? and status = 'queued' order by id").all(thread) as {
        id: number;
      }[])
    : [];
  const held = [...(after ? [after] : []), ...queued.map(j => j.id)]
    .map(id => ({ id, hold: holdOf(id, f) }))
    .find(h => h.hold);
  if (held)
    return `job #${held.id} is held (${holdWords(held.hold!)}), and a task of notes ${held.id === after ? 'after' : 'behind'} it would wait with it: put it where work can start`;
}

// The notes the board sees rerouting, by id, with why in its words: those back in routing, and those in queued work the
// play finds held (feedback.ts listNotes).
export function waiting(ids: number[], f: Forecast = forecast.current()) {
  const said = new Map<number, string>();
  if (!ids.length) return said;
  const rows = db
    .prepare(
      `select n.id, n.job, r.note is not null and r.routed is null routing, r.board_why from review_notes n
    left join note_routes r on r.note = n.id
    where n.status = 'sent' and n.fixed is null and n.answered is null and n.id in (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as { id: number; job: number | null; routing: number; board_why: string | null }[];
  for (const r of rows) {
    const hold = !r.routing && r.job ? holdOf(holder(r.job), f) : null;
    if (r.routing && r.board_why) said.set(r.id, `${r.board_why}, so it's being routed to other work`);
    else if (hold) said.set(r.id, `The work it's in is held: ${boardHoldWords(hold)}`);
  }
  return said;
}

// The notes in queued work, still open (none marked fixed or answered), each job's, for the play's after-hook
// (feedback.ts sendBack): a note sent to a job that failed is the job's that took its place (holder).
export const carried = () =>
  (
    db
      .prepare(
        `select j.id job, json_group_array(n.id) notes from review_notes n
    join jobs j on j.id in (${jobs.lineageFrom('select n.job')})
    where n.status = 'sent' and n.fixed is null and n.answered is null and j.kind = 'work' and j.status = 'queued'
      and j.session is null and not exists (select 1 from note_routes r where r.note = n.id and r.routed is null)
    group by j.id order by j.id`,
      )
      .all() as { job: number; notes: string }[]
  ).map(c => ({ job: c.job, notes: JSON.parse(c.notes) as number[] }));
// Whose a note sent to `job` is now: that job, else the job that took its place, the last of them (jobs.ts replacementOf).
//
export function holder(job: number) {
  for (let next = jobs.replacementOf(job); next; next = jobs.replacementOf(job)) job = next;
  return job;
}
