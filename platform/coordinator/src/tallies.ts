// What the board's projects view counts (projects.ts): a done thread's jobs, a thread's lines changed, and a project's
// jobs done since its sentence.
import { db } from './db.ts';
import { workBranch } from './jobs.ts';

// A done thread's jobs, how many of them are done, and its lines. finished: when it was complete, its close (the thread's
// done) or its last job's end, whichever came later, for the latest done ones.
export function tally(thread: { id: string; done: string | null }) {
  const { last, ...counted } = db
    .prepare(
      "select count(*) jobs, coalesce(sum(status = 'done'), 0) done, max(finished) last from jobs where thread = ?",
    )
    .get(thread.id) as { jobs: number; done: number; last: string | null };
  const finished = last !== null && (thread.done === null || last > thread.done) ? last : thread.done;
  return { ...counted, finished, lines: linesOf(thread.id) };
}

// The lines a thread's pull requests added and removed (merged.ts counts them at the merge), each pull request once
// however many of the thread's jobs share its branch. Null while none of them has its counts.
export function linesOf(thread: string) {
  const sums = db
    .prepare(
      `select count(*) prs, coalesce(sum(p.added), 0) added, coalesce(sum(p.removed), 0) removed from prs p
      where p.added is not null and p.branch in (select ${workBranch('j')} from jobs j where j.thread = ?)`,
    )
    .get(thread) as { prs: number; added: number; removed: number };
  return sums.prs ? { added: sums.added, removed: sums.removed } : null;
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
