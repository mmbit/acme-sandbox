// Completed ruling candidates for a reviewed head and for merge precedence across heads.
import { db } from './db.ts';
import { OPEN_PRS } from './jobs.ts';

export type Ruling = {
  id: number;
  pr: number;
  round: number;
  sha: string;
  finished: string;
};

// A reset retires every earlier ruling, and triage does not decide whether a branch may merge.
const ELIGIBLE = `j.kind = 'consolidate' and j.status = 'done' and coalesce(j.stage, '') != 'triage'
  and j.id > p.review_since and j.voided is null`;

export const latest = (pr: number, round: number, sha: string) =>
  db
    .prepare(
      `select j.id, j.pr, j.round, j.sha, j.finished, j.stage, j.output
    from jobs j indexed by jobs_pr_loop join prs p on p.number = j.pr
    where ${ELIGIBLE} and j.pr = ? and j.round = ? and j.sha = ? order by j.id desc limit 1`,
    )
    .get(pr, round, sha) as (Ruling & { stage: string | null; output: string | null }) | undefined;

export const history = () =>
  db
    .prepare(
      `select j.id, j.pr, j.round, j.sha, j.finished
    from prs p join jobs j indexed by jobs_pr_loop on j.pr = p.number
    where p.status in ${OPEN_PRS} and ${ELIGIBLE} order by j.finished, j.id`,
    )
    .all() as Ruling[];
