// The names the board reads: each project's, project sentence's, thread's (and its "done when") and task's plain
// version, written by a small model from the agent's words (plainnames.ts). The agent's words stay on their row for the
// agents, and a plain version stands only while the words it was made from do. Until it's made, or once they change,
// the board reads the agent's own words, and the plain version replaces them when it comes; why a naming failed stays
// on its row, for the agents. Review seats and tasks holding customer details aren't named: HQ's or the agent's own
// title is theirs.
import { db, prepared } from './db.ts';

export type Kind = 'project' | 'sentence' | 'thread' | 'goal' | 'task' | 'meeting'; // (meeting: its topic, by its id.)
// kind and id: what it names (a task by its job's id, a sentence by its project's); words: the agent's, as the plain
// version was asked for; plain: the model's, null until it answers well; error: why the latest try for these words
// failed, in words for the board, null while none has; claimed: when the latest call for them went out (ms), null once
// answered.
db.exec(`create table if not exists board_names (kind text not null, id text not null, words text not null, plain text,
  error text, claimed integer, primary key (kind, id))`);

// The tasks the model names, of the jobs as `j`: work, never a review's seats (HQ names those) nor one holding customer
// details (house rule 7)
export const namedTask = (j: string) => `(${j}.kind = 'work' and ${j}.customers = 0)`;

// What the board reads for the agent's words: their plain version, or the words themselves while there's none
function named(kind: Kind, id: string, words: string): string {
  const row = prepared('select plain from board_names where kind = ? and id = ? and words = ?').get(kind, id, words) as
    { plain: string | null } | undefined;
  return row?.plain ?? words;
}
// A thing the board reads with its names in `fields` (each field's words: its kind) as the board's
function withNames<T, F extends keyof T & string>(x: T, id: string, fields: Record<F, Kind>): T {
  const out = { ...x };
  for (const [field, kind] of Object.entries(fields) as [F, Kind][])
    (out as Record<string, unknown>)[field] = named(kind, id, String(x[field]));
  return out;
}
// Jobs as the board reads them (rows of jobs.ts jobRows, or any with an id and a title): each one's title, its after's
// and its waits', each the plain one, or the agent's own while it has none; a fix round's own title in what it fixes
// (reviewrows.ts) the same
type Titles = {
  title: string | null;
  after?: number | null;
  after_title?: string | null;
  waits?: { id: number; title: string | null }[];
  fixes?: { title?: string | null };
};
export function boardJobs<T extends { id: number }>(rows: T[]): (T & Titles)[] {
  const listed = rows as (T & Titles)[];
  const ids = listed.flatMap(j => [j.id, ...(j.after ? [j.after] : []), ...(j.waits ?? []).map(w => w.id)]);
  const plain = new Map(
    (
      prepared(
        `select j.id, n.plain from jobs j join board_names n on n.kind = 'task' and n.id = cast(j.id as text)
        and n.words = j.title where ${namedTask('j')} and n.plain is not null and j.id in (select value from json_each(?))`,
      ).all(JSON.stringify([...new Set(ids)])) as { id: number; plain: string }[]
    ).map(r => [r.id, r.plain]),
  );
  // (one job's: its own title where there's no plain one)
  const titled = (id: number, title: string | null) => plain.get(id) ?? title;
  return listed.map(j => {
    const title = titled(j.id, j.title);
    return {
      ...j,
      title,
      ...(j.fixes?.title !== undefined && { fixes: { ...j.fixes, title } }),
      ...(j.after && j.after_title !== undefined && { after_title: titled(j.after, j.after_title) }),
      ...(j.waits && { waits: j.waits.map(w => ({ ...w, title: titled(w.id, w.title) })) }),
    };
  });
}

// One, or none
export const boardJob = <T extends { id: number }>(j: T | null) => j && boardJobs([j])[0];

export const boardProject = <T extends { id: string; name: string }>(p: T) => withNames(p, p.id, { name: 'project' });
export const boardThread = <T extends { id: string; name: string; goal: string }>(t: T) =>
  withNames(t, t.id, { name: 'thread', goal: 'goal' });
export const boardSentence = <T extends { text: string }>(project: string, s: T) =>
  withNames(s, project, { text: 'sentence' });

// A meeting's topic as the board reads it, the plain one, or the agents' own while it has none (meetingboard.ts
// meetingSeats).
export const boardMeeting = (m: { id: number; topic: string }) =>
  withNames({ topic: m.topic }, String(m.id), { topic: 'meeting' });
