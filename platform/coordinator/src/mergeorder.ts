// Merge precedence survives the author's re-sync and its merge check.
import * as rulingjobs from './rulingjobs.ts';
import * as boardmerges from './boardmerges.ts';
import { db } from './db.ts';
import { OPEN_PRS } from './jobs.ts';
import * as panel from './panel.ts';
import { findThread } from './projects.ts';

type Pull = { number: number; files: string };
type Precedence = 'retain' | 'release' | 'boardAnswer';
type Place = { at: string; id: number };

// A pass keeps its original place through further merge checks. Another decision releases it. Reading the existing
// rulings also recovers the order after a restart. Only windowed predecessors hold shared files because later merges
// could force another re-sync and review cycle, delaying the promised window. Undated work makes no such promise.
export function predecessor(pr: Pull, precedence: (job: rulingjobs.Ruling) => Precedence | undefined) {
  const pulls = db.prepare(`select number, branch, files from prs where status in ${OPEN_PRS}`).all() as (Pull & {
    branch: string;
  })[];
  const files = new Set(JSON.parse(pr.files) as string[]);
  const related = pulls.filter(
    pull => pull.number === pr.number || (JSON.parse(pull.files) as string[]).some(file => files.has(file)),
  );
  const numbers = new Set(related.map(pull => pull.number));
  const places = new Map<number, Place>();
  const rulings = rulingjobs.history();
  for (const job of rulings) {
    if (!numbers.has(job.pr)) continue;
    const outcome = precedence(job);
    if (outcome === 'retain') {
      if (!places.has(job.pr)) places.set(job.pr, { at: job.finished, id: job.id });
    } else if (outcome) {
      places.delete(job.pr);
      const answered = outcome === 'boardAnswer' ? boardmerges.answeredMerge(job.id) : undefined;
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
