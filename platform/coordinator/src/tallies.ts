// What the board's projects view counts (projects.ts): a done thread's jobs, a thread's lines changed, and a project's
// jobs done since its sentence.
import { db, prepared } from './db.ts';
import { workBranch } from './jobs.ts';

type Counts = { jobs: number; done: number; last: string | null };
type Lines = { added: number; removed: number };

// Every thread's tallies at once, through the thread's index, which holds each job's state, end
// and branch: the view reads them all in two reads, not two per thread.
export function tallies() {
  const counts = new Map(
    (
      prepared(
        `select j.thread, count(*) jobs, sum(j.status = 'done') done, max(j.finished) last from jobs j
        indexed by jobs_thread_state where j.thread is not null group by j.thread`,
      ).all() as (Counts & { thread: string })[]
    ).map(({ thread, ...counted }) => [thread, counted]),
  );
  const lines = linesByThread();
  const linesOf = (id: string): Lines | null => lines.get(id) ?? null;
  // A done thread's jobs, how many of them are done, and its lines. finished: when it was complete, its close (the
  // thread's done) or its last job's end, whichever came later, for the latest done ones.
  const tally = (th: { id: string; done: string | null }) => {
    const { last, ...counted } = counts.get(th.id) ?? { jobs: 0, done: 0, last: null };
    const finished = last !== null && (th.done === null || last > th.done) ? last : th.done;
    return { ...counted, finished, lines: linesOf(th.id) };
  };
  return { tally, linesOf };
}
export type Tallies = ReturnType<typeof tallies>;

// A thread's lines alone, without counting its jobs.
export const linesOf = (thread: string): Lines | null => linesByThread(thread).get(thread) ?? null;

// The lines a thread's pull requests added and removed (merged.ts counts them at the merge), each pull request once
// however many of the thread's jobs share its branch. None while none of them has its counts.
function linesByThread(thread?: string) {
  const one = thread === undefined ? '' : 'and j.thread = $thread',
    values: Record<string, string> = thread === undefined ? {} : { thread };
  return new Map(
    (
      prepared(
        `select t.thread, coalesce(sum(p.added), 0) added, coalesce(sum(p.removed), 0) removed
        from (select distinct j.thread, ${workBranch('j')} branch from jobs j indexed by jobs_thread_state
          where j.thread is not null ${one}) t
        join prs p on p.branch = t.branch where p.added is not null group by t.thread`,
      ).all(values) as (Lines & { thread: string })[]
    ).map(({ thread, ...counted }) => [thread, counted]),
  );
}

// How many of a project's jobs were done since a time (its sentence's)
export const doneSince = (project: string, at: string) =>
  (
    db
      .prepare(
        `select count(*) n from jobs where status = 'done' and finished > ?
      and thread in (select id from threads where project = ?)`,
      )
      .get(at, project) as { n: number }
  ).n;
