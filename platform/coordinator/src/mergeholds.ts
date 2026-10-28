// Visual decisions hold the merge endpoint, while review and the pictures' separate branch can go on.
import { db } from './db.ts';
import type { QueuedJob } from './playtypes.ts';

export function holdMerges(jobs: QueuedJob[], answers: (request: number) => number) {
  const holds = db
    .prepare(
      `select m.pr, d.card_job, d.request from decision_merges m
    join decisions d on d.id = m.decision where d.answered is null and d.released is null`,
    )
    .all() as { pr: number; card_job: number | null; request: number | null }[];
  const byPr = new Map(holds.map(hold => [hold.pr, hold]));
  // (pictures merged, or ended without any, are no longer queued: the merge then waits only for the answer, waitReason)
  const queued = new Set(jobs.map(job => job.id));
  for (const job of jobs) {
    const hold = job.review && byPr.get(job.review.pr);
    if (!hold) continue;
    job.mergeHold = {
      job: hold.card_job !== null && queued.has(hold.card_job) ? hold.card_job : null,
      card: hold.request === null ? null : { request: hold.request, at: answers(hold.request) },
    };
  }
}
