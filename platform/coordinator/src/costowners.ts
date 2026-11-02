// Recorded branch, review, explicit fix and held-preview ownership for feature cost attribution.
import { db } from './db.ts';
import { heldBranches } from './tasklinks.ts';
import type { CostJob } from './featurecost.ts';
type Assignment = { thread: string; share: number };
export function assignments(jobs: CostJob[]) {
  const byBranch = Map.groupBy(jobs, job => job.branch);
  const prs = db.prepare('select number, branch from prs').all() as { number: number; branch: string }[];
  const branchOf = new Map(prs.map(pr => [pr.number, pr.branch]));
  const fixes = db
    .prepare(
      `select job, pr from review_fix_tasks
    union select r.job, f.pr from review_followup_jobs r join findings f on f.id = r.finding`,
    )
    .all() as {
    job: number;
    pr: number;
  }[];
  const fixOf = new Map(fixes.map(fix => [fix.job, fix.pr]));
  const held = heldBranches();
  const owners = branchOwners(byBranch, branchOf, fixOf, held);
  return new Map(
    jobs.map(job => {
      if (held.has(job.id)) return [job.id, shared(held.get(job.id)!, branch => owners(branch))];
      // A preview's entire branch family retains the held features' shares.
      if ((byBranch.get(job.branch) ?? []).some(member => held.has(member.id))) return [job.id, owners(job.branch)];
      if (job.thread && !fixOf.has(job.id)) return [job.id, [{ thread: job.thread, share: 1 }]];
      const pr = fixOf.get(job.id) ?? job.pr;
      return [job.id, owners((pr !== null && pr !== undefined ? branchOf.get(pr) : undefined) ?? job.branch)];
    }),
  );
}

function branchOwners(
  byBranch: Map<string, CostJob[]>,
  branchOf: Map<number, string>,
  fixOf: Map<number, number>,
  held: Map<number, string[]>,
) {
  const owners = (branch: string, visited = new Set<string>()): Assignment[] => {
    if (visited.has(branch)) return [];
    const next = new Set([...visited, branch]);
    const members = byBranch.get(branch) ?? [];
    const previews = [...new Set(members.flatMap(job => held.get(job.id) ?? []))];
    if (previews.length) return shared(previews, parent => owners(parent, next));
    const direct = [
      ...new Set(
        members
          .filter(job => job.kind === 'work' && !fixOf.has(job.id))
          .flatMap(job => (job.thread ? [job.thread] : [])),
      ),
    ];
    if (direct.length) return direct.map(thread => ({ thread, share: 1 / direct.length }));
    const linked = [
      ...new Set(
        members.flatMap(job => {
          const pr = fixOf.get(job.id);
          return pr === undefined ? [] : (branchOf.get(pr) ?? []);
        }),
      ),
    ];
    return shared(linked, parent => owners(parent, next));
  };
  return owners;
}

function shared(branches: string[], owners: (branch: string) => Assignment[]): Assignment[] {
  const shares = new Map<string, number>();
  for (const branch of branches)
    for (const part of owners(branch))
      shares.set(part.thread, (shares.get(part.thread) ?? 0) + part.share / branches.length);
  return [...shares].map(([thread, share]) => ({ thread, share }));
}
