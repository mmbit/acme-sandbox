// Throwaway work's one light review (reviewlenses.ts THROWAWAY, the review-panel playbook): when triage judges a change
// throwaway, the consolidator reads it beside only its security readers (reviewtriage.ts read), and what that read leaves
// ends at the merge (followups.ts).
import { selections } from './reviewtriage.ts';

// Whether triage judged a pull request's latest round throwaway
export const throwaway = (pr: number) => selections(pr)[0]?.throwaway === true;

// What a re-review's triage hears of an earlier round's judgment, so it holds across rounds
export const EARLIER = `An earlier round judged this throwaway work: keep "throwaway": true unless the fixes made it code
that lasts.`;
