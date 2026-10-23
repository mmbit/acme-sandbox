// The names the board reads: each project's, project sentence's, thread's (and its "done when") and task's plain
// version, written by a small model from the agent's words (plainnames.ts). The agent's words stay on their row for the
// agents, and a plain version stands only while the words it was made from do. Until it's made, or once they change,
// the board's view has no name for it (null) and says so in `naming`: that it's being named, or why its latest naming
// failed. Review seats and tasks holding customer details aren't named: HQ's or the agent's own title is theirs.
import { db, prepared } from './db.ts';

export type Kind = 'project' | 'sentence' | 'thread' | 'goal' | 'task';
// kind and id: what it names (a task by its job's id, a sentence by its project's); words: the agent's, as the plain
// version was asked for; plain: the model's, null until it answers well; error: why the latest try for these words
// failed, in words for the board, null while none has; claimed: when the latest call for them went out (ms), null once
// answered.
db.exec(`create table if not exists board_names (kind text not null, id text not null, words text not null, plain text,
  error text, claimed integer, primary key (kind, id))`);

// The tasks the model names, of the jobs as `j`: work, never a review's seats (HQ names those) nor one holding customer
// details (house rule 7)
export const namedTask = (j: string) => `(${j}.kind = 'work' and ${j}.customers = 0)`;

// What the board reads for the agent's words: their plain version, or null while there's none, with naming saying why
// (the latest failure, or null while it's being named)
function named(kind: Kind, id: string, words: string) {
  const row = prepared('select plain, error from board_names where kind = ? and id = ? and words = ?').get(
    kind,
    id,
    words,
  ) as { plain: string | null; error: string | null } | undefined;
  return row?.plain != null ? { plain: row.plain } : { plain: null, naming: row?.error ?? null };
}
// A thing the board reads with its names in `fields` (each field's words: its kind) as the board's: each the plain
// version, or null with `naming` holding, for each field that has none, why
type Board<T, F extends keyof T> = Omit<T, F> & { [K in F]: string | null } & { naming?: { [K in F]?: string | null } };
function withNames<T, F extends keyof T & string>(x: T, id: string, fields: Record<F, Kind>): Board<T, F> {
  const out = { ...x } as Record<string, unknown>,
    naming: Record<string, string | null> = {};
  for (const [field, kind] of Object.entries(fields) as [F, Kind][]) {
    const n = named(kind, id, String(x[field]));
    out[field] = n.plain;
    if (n.plain === null) naming[field] = n.naming;
  }
  return (Object.keys(naming).length ? { ...out, naming } : out) as Board<T, F>;
}
// Jobs as the board reads them (rows of jobs.ts jobRows, or any with an id and a title): each one's title, its after's
// and its waits', each the plain one, or null with its naming while it has none; a fix round's own title in what it
// fixes (reviewrows.ts) the plain one too, or none while there's none
type Naming = { title: string | null };
type Titles = {
  title: string | null;
  naming?: Naming;
  after?: number | null;
  after_title?: string | null;
  after_naming?: Naming;
  waits?: { id: number; title: string | null; naming?: Naming }[];
  fixes?: { title?: string };
};
export function boardJobs<T extends { id: number }>(rows: T[]): (T & Titles)[] {
  const listed = rows as (T & Titles)[];
  const ids = listed.flatMap(j => [j.id, ...(j.after ? [j.after] : []), ...(j.waits ?? []).map(w => w.id)]);
  const titles = new Map(
    (
      prepared(
        `select j.id, ${namedTask('j')} named, n.plain, n.error from jobs j left join board_names n on n.kind = 'task'
        and n.id = cast(j.id as text) and n.words = j.title where j.id in (select value from json_each(?))`,
      ).all(JSON.stringify([...new Set(ids)])) as {
        id: number;
        named: number;
        plain: string | null;
        error: string | null;
      }[]
    ).map(r => [r.id, r]),
  );
  // (one job's: its own title where the model doesn't name it)
  const titled = (id: number, title: string | null): { title: string | null; naming?: Naming } => {
    const t = titles.get(id)!;
    if (!t.named) return { title };
    return t.plain !== null ? { title: t.plain } : { title: null, naming: { title: t.error } };
  };
  return listed.map(j => {
    const after = j.after && j.after_title !== undefined ? titled(j.after, j.after_title) : null;
    const own = titled(j.id, j.title);
    const { title: _words, ...fixes } = j.fixes ?? {};
    return {
      ...j,
      ...own,
      ...(j.fixes?.title !== undefined && { fixes: own.title === null ? fixes : { ...fixes, title: own.title } }),
      ...(after && { after_title: after.title, ...(after.naming && { after_naming: after.naming }) }),
      ...(j.waits && { waits: j.waits.map(w => ({ ...w, ...titled(w.id, w.title) })) }),
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
