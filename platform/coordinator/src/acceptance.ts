// Queue an accepted proposal with its owner's saved scope estimate.
import { db } from './db.ts';
import * as jobs from './jobs.ts';
import type { Proposal } from './proposals.ts';
import type { QueuedSize } from './sizes.ts';
import type { JobThreadAsk } from './projects.ts';

export type Ask = JobThreadAsk & {
  for?: unknown;
  findings?: unknown;
  code?: unknown;
  size?: unknown;
  refs?: unknown;
  why?: unknown;
};

type Work = { agent: string; title: string; code: string; size: QueuedSize; thread?: string; from?: number };

export function queue(proposal: Proposal, by: string, work: Work) {
  const job = jobs.createJob({
    ...work,
    prompt: `${proposal.brief}\n\n(Proposed by ${proposal.agent}, accepted by ${by}.)`,
    queuedBy: proposal.agent,
    plannedBy: by,
  });
  db.prepare("update proposals set status = 'accepted', decided = ?, accepted = ? where id = ?").run(
    new Date().toISOString(),
    job.id,
    proposal.id,
  );
  return { job: job.id, code: job.code, thread: jobs.threadOf(job.id) };
}
