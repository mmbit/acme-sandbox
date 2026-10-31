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
  // its proposer's card: the job waits for its answer, or, answered already, has it in its brief, reads its pictures and,
  // if no job heard it, is the one that did (proposals.ts propose)
  if (proposal.request !== null) {
    jobs.holdForCard(job.id, proposal.request);
    jobs.heardHeldAnswer(proposal.request, job.id);
  }
  db.prepare("update proposals set status = 'accepted', decided = ?, accepted = ? where id = ?").run(
    new Date().toISOString(),
    job.id,
    proposal.id,
  );
  return { job: job.id, code: job.code, thread: jobs.threadOf(job.id) };
}
