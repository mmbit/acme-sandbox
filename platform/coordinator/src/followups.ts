// The project's review follow-ups (the review-panel playbook, "Rounds"): what a pull request's reviews found that it
// doesn't fix itself (refactoring, conventions, documentation, hardening that isn't security, and findings in code it
// didn't change) go, when it ends, into one open proposal per project in its owner's inbox. The owner prioritises it in
// the plan and assigns it, a thread of its own for refactoring or hardening; later pull requests' follow-ups join it
// while it stays open. A finding in code of a review domain none of the pull request's files are in cuts across
// projects: it goes to the CEO's bundle (no project), who passes it to the project it belongs to. What a ruling from
// the upstream round on says went wrong before review reaches the owner the same way, in a proposal of its own.
import { db, inOneStep } from './db.ts';
import { findThread } from './projects.ts';
import * as panel from './panel.ts';
import * as findings from './findings.ts';

const TITLE = 'Review follow-ups: refactoring and hardening';

// A pull request ended, merged or not (findings.followUpsOf): its follow-ups into their bundles
export async function collect(pr: number, merged: boolean) {
  const { branch } = db.prepare('select branch, files from prs where number = ?').get(pr) as {
    branch: string;
    files: string;
  };
  const left = findings
    .followUpsOf(pr, merged)
    .filter(f => !db.prepare('select 1 from review_followups where finding = ?').get(f.id));
  if (!left.length) return;
  const project = projectOf(branch);
  const proposals = await import('./proposals.ts');
  const agent = panel.consolidator(pr);
  for (const [to, list] of [
    [project, left.filter(f => !f.cross_project)],
    [null, left.filter(f => f.cross_project)],
  ] as const) {
    if (!list.length) continue;
    const open = db
      .prepare(
        `select f.proposal from review_followups f join proposals p on p.id = f.proposal
        where p.status = 'open' and p.project is ? order by f.proposal desc limit 1`,
      )
      .get(to) as { proposal: number } | undefined;
    const joined = open ? [...linesOf(open.proposal), ...list.map(lineOf(pr))] : list.map(lineOf(pr));
    // a bundle grown past a proposal's size starts the next one
    const into = open && briefOf(joined).length <= proposals.BRIEF_MAX ? open.proposal : undefined;
    const brief = briefOf(into ? joined : list.map(lineOf(pr)));
    inOneStep(() => {
      const id = proposals.bundle({ agent, title: TITLE, brief, project: to }, into);
      const add = db.prepare('insert into review_followups (finding, proposal) values (?, ?)');
      for (const f of list) add.run(f.id, id);
    });
  }
}

// Each finding as its bundle lists it
const lineOf = (pr: number) => (f: findings.FollowUp) =>
  `- Finding #${f.id}, PR #${pr} (${f.kind === 'pre-existing' ? 'in code it did not change' : 'not fixed in it'}), ` +
  `${f.file ?? '(no file)'}${f.line ? `:${f.line}` : ''}: ${f.issue}`;
const linesOf = (proposal: number) => {
  const rows = db
    .prepare(
      `select f.id, f.pr, f.kind, f.file, f.line, f.issue from findings f join review_followups r on r.finding = f.id
      where r.proposal = ? order by f.id`,
    )
    .all(proposal) as (findings.FollowUp & { pr: number })[];
  return rows.map(f => lineOf(f.pr)(f));
};
const briefOf = (lines: string[]) => `What reviews found that their pull requests didn't fix: refactoring, conventions,
documentation, hardening that isn't security, and findings in code a change didn't touch. Pre-existing findings can
concern customers or security: prioritise each finding by its actual impact.

It's yours to prioritise and assign: accept it as a thread of its own for refactoring or hardening
(\`hq inbox accept <id> --for <agent> --code WORD --thread new:<project> "name" "done when"\`), with the findings worth
fixing named in the thread's "done when"; or drop it with why. Findings in
another project's code: propose them there (\`hq propose "title" <brief-file> --project <id>\`).

${lines.join('\n')}`;

// A ruling from the upstream round on said what went wrong before review (review.ts decide): the project's owner reads
// it in one open proposal per pull request, which each later such ruling adds its line to
export async function upstream(ruling: { id: number; pr: number }, line: string) {
  const proposals = await import('./proposals.ts');
  if (db.prepare('select 1 from review_upstream where ruling = ?').get(ruling.id)) return;
  const { branch } = db.prepare('select branch from prs where number = ?').get(ruling.pr) as { branch: string };
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
    const agent = panel.consolidator(ruling.pr);
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
