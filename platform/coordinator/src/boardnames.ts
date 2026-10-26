// The names the board reads: each project's, project sentence's, thread's (and its "done when") and task's plain
// version, and what a finished task did, written by a small model from the agent's words (plainnames.ts). The agent's words stay on their row for the
// agents, and a plain version stands only while the words it was made from do. Until it's made, or once they change,
// the board reads the agent's own words, and the plain version replaces them when it comes; why a naming failed stays
// on its row, for the agents. Review seats and tasks holding customer details aren't named: HQ's or the agent's own
// title is theirs.
import { db, prepared, redacted } from './db.ts';

// (meeting: its topic, by its id; did: what a finished task did, by its job's id, from its report.)
export type Kind = 'project' | 'sentence' | 'thread' | 'goal' | 'task' | 'meeting' | 'did';
// kind and id: what it names (a task by its job's id, a sentence by its project's); words: the agent's, as the plain
// version was asked for; plain: the model's, null until it answers well; error: why the latest try for these words
// failed, in words for the board, null while none has; claimed: when the latest call for them went out (ms), null once
// answered.
db.exec(`create table if not exists board_names (kind text not null, id text not null, words text not null, plain text,
  error text, claimed integer, primary key (kind, id))`);
// (a key saved later leaves a report's copy and its summary too, as it leaves the report: db.ts scrub())
redacted('board_names', 'words', 'plain', 'error');

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
// (`name`: how each is read, one at a time unless a view read them all: boardNames)
function withNames<T, F extends keyof T & string>(x: T, id: string, fields: Record<F, Kind>, name = named): T {
  const out = { ...x };
  for (const [field, kind] of Object.entries(fields) as [F, Kind][])
    (out as Record<string, unknown>)[field] = name(kind, id, String(x[field]));
  return out;
}
// Jobs as the board reads them (rows of jobs.ts jobRows, or any with an id and a title): each one's title, its after's
// and its waits', each the plain one, or the agent's own while it has none; a fix round's own title in what it fixes
// (reviewrows.ts) the same; and a finished one's `did`, what it did in plain words, once made (none before: its report
// is no summary)
type Titles = {
  title: string | null;
  did?: string;
  after?: number | null;
  after_title?: string | null;
  waits?: { id: number; title: string | null }[];
  fixes?: { title?: string | null };
};
export function boardJobs<T extends { id: number }>(rows: T[]): (T & Titles)[] {
  const listed = rows as (T & Titles)[];
  const ids = listed.flatMap(j => [j.id, ...(j.after ? [j.after] : []), ...(j.waits ?? []).map(w => w.id)]);
  // (the jobs through db.ts jobs_listed, never their rows.)
  // (what a task did stands once made: its report doesn't change once it's done, plainnames.ts didNames; none for one
  // done before they were made, whose row says nothing.)
  const named = prepared(
    `select j.id, n.plain, d.plain did from jobs j indexed by jobs_listed left join board_names n on n.kind = 'task'
    and n.id = cast(j.id as text) and n.words = j.title left join board_names d on d.kind = 'did' and d.id = cast(j.id as text)
    and d.plain <> '' where ${namedTask('j')} and coalesce(n.plain, d.plain) is not null and j.id in (select value from json_each(?))`,
  ).all(JSON.stringify([...new Set(ids)])) as { id: number; plain: string | null; did: string | null }[];
  const plain = new Map(named.filter(r => r.plain !== null).map(r => [r.id, r.plain!]));
  const did = new Map(named.filter(r => r.did !== null).map(r => [r.id, r.did!]));
  // (one job's: its own title where there's no plain one)
  const titled = (id: number, title: string | null) => plain.get(id) ?? title;
  return listed.map(j => {
    const title = titled(j.id, j.title);
    return {
      ...j,
      title,
      ...(did.has(j.id) && { did: did.get(j.id) }),
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
// The same for a view that shows every project, thread and sentence (projects.ts listProjectBoard): their plain names
// read at once, not one read for each.
export function boardNames() {
  const key = (kind: string, id: string, words: string) => JSON.stringify([kind, id, words]);
  const plain = new Map(
    (
      prepared(
        "select kind, id, words, plain from board_names where kind in ('project', 'thread', 'goal', 'sentence') and plain is not null",
      ).all() as { kind: Kind; id: string; words: string; plain: string }[]
    ).map(n => [key(n.kind, n.id, n.words), n.plain]),
  );
  const name = (kind: Kind, id: string, words: string) => plain.get(key(kind, id, words)) ?? words;
  return {
    project: <T extends { id: string; name: string }>(p: T) => withNames(p, p.id, { name: 'project' }, name),
    thread: <T extends { id: string; name: string; goal: string }>(t: T) =>
      withNames(t, t.id, { name: 'thread', goal: 'goal' }, name),
    sentence: <T extends { text: string }>(project: string, s: T) => withNames(s, project, { text: 'sentence' }, name),
  };
}
export type BoardNames = ReturnType<typeof boardNames>;

// A meeting's topic as the board reads it, the plain one, or the agents' own while it has none (meetingboard.ts
// meetingSeats).
export const boardMeeting = (m: { id: number; topic: string }) =>
  withNames({ topic: m.topic }, String(m.id), { topic: 'meeting' });
