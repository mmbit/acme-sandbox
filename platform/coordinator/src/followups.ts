// A pull request's review follow-ups (the review-panel playbook, "Rounds"): what its reviews found that didn't hold its
// merge (nonblocking findings, those its author left open, and findings in code it didn't change) go, once it merges,
// into one job for its author, queued in the same deliverable, done after the work is live. A
// follow-up's own pull request leaves none: its findings end there, so follow-ups never chain. What a ruling from the
// upstream round on says went wrong before review reaches the project's owner in a proposal of its own.
// (its messages say deliverable, the board's word for a thread)
import { db, inOneStep } from './db.ts';
import { findThread } from './projects.ts';
import * as jobs from './jobs.ts';
import * as panel from './panel.ts';
import * as findings from './findings.ts';

// A pull request merged (review.ts pullRequestMerged, before its thread lets go of its branch): its follow-ups into one
// job for its author, titled after its work
export function collect(pr: number, work: string) {
  const { branch, author } = db.prepare('select branch, author from prs where number = ?').get(pr) as {
    branch: string;
    author: string;
  };
  if (isFollowUp(branch)) return;
  const left = leftOf(pr);
  if (!left.length) return;
  const drawn = panel.threadOfBranch(branch);
  const thread = drawn && findThread(drawn)?.status === 'open' ? drawn : null;
  inOneStep(() => {
    const job = jobs.createJob({
      agent: author,
      title: `Review follow-ups: ${work}`,
      prompt: briefOf(pr, left),
      thread,
      queuedBy: panel.attribution(pr),
    });
    takenBy(left, job.id);
  });
}

// An expedited pull request's review of what merged didn't pass (review.ts reviewedAfter): the job that fixes it, made
// by `fixJob` with the lines to add to its brief, is its one follow-up job and takes what its earlier rulings left too.
// The findings of `ruling` itself are in its verdict, which the job already reads.
export function intoFix(pr: number, ruling: number, fixJob: (earlier: string) => number) {
  const left = leftOf(pr);
  const earlier = left.filter(f => rulingOf(f.id) !== ruling);
  const lines = earlier.length
    ? `\n\nIts earlier rulings left these too. Fix the ones worth fixing, and for the rest say in your report why not:\n${earlier.map(lineOf).join('\n')}`
    : '';
  inOneStep(() => takenBy(left, fixJob(lines)));
}

// What a pull request's reviews left (findings.ts followUpsOf) that no follow-up job has taken yet
const leftOf = (pr: number) =>
  findings.followUpsOf(pr).filter(f => !db.prepare('select 1 from review_followup_jobs where finding = ?').get(f.id));
const takenBy = (left: findings.FollowUp[], job: number) => {
  const add = db.prepare('insert into review_followup_jobs (finding, job) values (?, ?)');
  for (const f of left) add.run(f.id, job);
};
const rulingOf = (finding: number) =>
  (db.prepare('select ruling from findings where id = ?').get(finding) as { ruling: number }).ruling;

// Whether a branch carries only follow-up jobs' work: its findings end with it (collect, the round's briefing). A thread
// task after a follow-up job may share its branch, and its work's findings go on as any work's.
export const isFollowUp = (branch: string) => {
  const { all, followUps } = db
    .prepare(
      `select count(*) "all", count(u.job) followUps from jobs j
      left join (select distinct job from review_followup_jobs) u on u.job = j.id
      where j.kind = 'work' and j.stage is null and coalesce(j.branch, 'job/' || j.id) = ?`,
    )
    .get(branch) as { all: number; followUps: number };
  return followUps > 0 && followUps === all;
};

const briefOf = (pr: number, list: findings.FollowUp[]) => `PR #${pr} merged and is live. Its reviews found these too,
and none of them held the merge: small bugs, styling, tidiness, hypothetical cases, and findings in code it didn't
change. Fix the ones worth fixing, each small, in one push. For the rest say in your report why not. If what went live
has a caveat the board must know about (something it will meet and might mistake for done), tell it on the desk phone
(\`hq ask\`). This push is reviewed like any work, and its own findings end with it: there's no follow-up of a follow-up.

${list.map(lineOf).join('\n')}`;
// Each finding as its follow-up job lists it
const lineOf = (f: findings.FollowUp) =>
  `- Finding #${f.id} (${f.kind === 'pre-existing' ? 'in code it did not change' : 'not fixed in it'}), ` +
  `${f.file ?? '(no file)'}${f.line ? `:${f.line}` : ''}: ${f.issue}`;

// A ruling from the upstream round on said what went wrong before review (review.ts decide): the project's owner reads
// it in one open proposal per pull request, which each later such ruling adds its line to
export async function upstream(ruling: { id: number; pr: number }, line: string) {
  const proposals = await import('./proposals.ts');
  if (db.prepare('select 1 from review_upstream where ruling = ?').get(ruling.id)) return;
  const branch = branchOf(ruling.pr);
  const open = db
    .prepare(
      `select u.proposal from review_upstream u join proposals p on p.id = u.proposal
      where u.pr = ? and p.status = 'open' order by u.proposal desc limit 1`,
    )
    .get(ruling.pr) as { proposal: number } | undefined;
  const said = open
    ? (
        db.prepare('select line from review_upstream where proposal = ? order by ruling').all(open.proposal) as {
          line: string;
        }[]
      ).map(u => u.line)
    : [];
  inOneStep(() => {
    const title = `Before review: what went wrong on PR #${ruling.pr}`;
    const brief = upstreamBrief([...said, line]);
    const { agent } = db.prepare('select agent from jobs where id = ?').get(ruling.id) as { agent: string };
    const id = proposals.bundle({ agent, title, brief, project: projectOf(branch) }, open?.proposal);
    db.prepare('insert into review_upstream (ruling, pr, line, proposal) values (?, ?, ?, ?)').run(
      ruling.id,
      ruling.pr,
      line,
      id,
    );
  });
}

const projectOf = (branch: string) => {
  const thread = panel.threadOfBranch(branch);
  return thread ? (findThread(thread)?.project ?? null) : null;
};
const upstreamBrief = (lines: string[]) => `A pull request went past the review's upstream round, and its rulings say
something before review went wrong (the brief, the design, how the work was split, its tests), not only its code. Its
rounds go on until it's right. The cause is yours to fix: accept this as a task for whoever should
(\`hq inbox accept <id> --for <agent> --code WORD\`), or drop it with why.

${lines.map(line => `- ${line}`).join('\n')}`;

// The branch of a pull request HQ knows.
export const branchOf = (pr: number) =>
  (db.prepare('select branch from prs where number = ?').get(pr) as { branch: string }).branch;
