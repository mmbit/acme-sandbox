// Recorded branch, review, explicit fix and held-preview ownership for feature cost attribution.
import { db } from './db.ts';
import type { CostJob } from './featurecost.ts';
export function assignments(jobs: CostJob[]) {
  const byBranch = Map.groupBy(jobs, job => job.branch);
  const prs = db.prepare('select number, branch from prs').all() as { number: number; branch: string }[];
  const branchOf = new Map(prs.map(pr => [pr.number, pr.branch]));
  const fixes = db
    .prepare(
      `select job, pr from review_fix_tasks
    union select r.job, f.pr from review_followup_jobs r join findings f on f.id = r.finding`,
    )
    .all() as { job: number; pr: number }[];
  const fixOf = new Map(fixes.map(fix => [fix.job, fix.pr]));
  const previews = db.prepare('select job, pr from card_merges').all() as { job: number; pr: number }[];
  const previewOf = Map.groupBy(previews, row => row.job);
  const owners = branchOwners(byBranch, branchOf, fixOf);
  return new Map(
    jobs.map(job => {
      const held = previewOf.get(job.id);
      const branches = held ? [...new Set(held.flatMap(row => branchOf.get(row.pr) ?? []))] : [];
      if (branches.length) {
        const parts = branches.flatMap(branch => {
          const threads = owners(branch);
          return threads.map(thread => ({ thread, share: 1 / branches.length / threads.length }));
        });
        return [job.id, parts];
      }
      if (job.thread && !fixOf.has(job.id)) return [job.id, [{ thread: job.thread, share: 1 }]];
      const pr = fixOf.get(job.id) ?? job.pr;
      const threads = owners((pr !== null && pr !== undefined ? branchOf.get(pr) : undefined) ?? job.branch);
      return [job.id, threads.map(thread => ({ thread, share: 1 / threads.length }))];
    }),
  );
}

function branchOwners(byBranch: Map<string, CostJob[]>, branchOf: Map<number, string>, fixOf: Map<number, number>) {
  const owners = (branch: string, visited = new Set<string>()): string[] => {
    if (visited.has(branch)) return [];
    visited.add(branch);
    const members = (byBranch.get(branch) ?? []).filter(job => job.kind === 'work' && !fixOf.has(job.id));
    const direct = [...new Set(members.flatMap(job => (job.thread ? [job.thread] : [])))];
    if (direct.length) return direct;
    const linked = (byBranch.get(branch) ?? [])
      .filter(job => fixOf.has(job.id))
      .flatMap(job => {
        const parent = branchOf.get(fixOf.get(job.id)!);
        return parent ? owners(parent, visited) : [];
      });
    return [...new Set(linked)];
  };
  return owners;
}
