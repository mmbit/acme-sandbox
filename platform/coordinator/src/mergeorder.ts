// Merge precedence survives the author's re-sync and its merge check.
import * as boardmerges from './boardmerges.ts';
import { db } from './db.ts';
import { OPEN_PRS } from './jobs.ts';
import * as panel from './panel.ts';
import { findThread } from './projects.ts';

type Pull = { number: number; files: string };
type Ruling = { id: number; pr: number; round: number; sha: string; finished: string };
type Place = { at: string; id: number };

// A pass keeps its original place through further merge checks. Another decision releases it. Reading the existing
// rulings also recovers the order after a restart and for pull requests that passed before this code was deployed.
export function predecessor(pr: Pull, decision: (job: Ruling) => string | undefined) {
  const pulls = db.prepare(`select number, branch, files from prs where status in ${OPEN_PRS}`).all() as (Pull & {
    branch: string;
  })[];
  const files = new Set(JSON.parse(pr.files) as string[]);
  const related = pulls.filter(
    pull => pull.number === pr.number || (JSON.parse(pull.files) as string[]).some(file => files.has(file)),
  );
  const numbers = new Set(related.map(pull => pull.number));
  const places = new Map<number, Place>();
  const rulings = db
    .prepare(
      `select j.id, j.pr, j.round, j.sha, j.finished from prs p
    join jobs j indexed by jobs_pr_loop on j.pr = p.number
    where p.status in ${OPEN_PRS} and j.kind = 'consolidate' and j.status = 'done'
    and j.id > p.review_since and j.voided is null and coalesce(j.stage, '') != 'triage'
    order by j.finished, j.id`,
    )
    .all() as Ruling[];
  for (const job of rulings) {
    if (!numbers.has(job.pr)) continue;
    const decided = decision(job);
    if (decided === 'merge') {
      if (!places.has(job.pr)) places.set(job.pr, { at: job.finished, id: job.id });
    } else if (decided) {
      places.delete(job.pr);
      const answered = decided === 'board' ? boardmerges.answeredMerge(job.id) : undefined;
      if (answered) places.set(job.pr, { at: answered, id: job.id });
    }
  }
  const own = places.get(pr.number);
  return related
    .filter(pull => {
      const place = places.get(pull.number);
      if (pull.number === pr.number || !place || (own && compare(place, own) >= 0)) return false;
      const thread = panel.threadOfBranch(pull.branch);
      if (!thread || findThread(thread)?.deadline == null) return false;
      return true;
    })
    .sort((a, b) => compare(places.get(a.number)!, places.get(b.number)!))[0]?.number;
}

const compare = (a: Place, b: Place) => a.at.localeCompare(b.at) || a.id - b.id;
