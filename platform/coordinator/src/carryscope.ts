// Mechanical occupancy comparisons from the type check and test areas each commit requires.
import type { PastJob, Work, Basis } from './matching.ts';

export type Scope = { typecheck: boolean; tests: string[] };

// Scope is the commit's type-check trigger and the test areas its own tree selects. Keep every overlapping
// comparison, weighted by the shared fraction of required test areas. Unknown scopes never dilute known scopes.
export function comparisons(work: Work, pool: PastJob[]) {
  const carries = pool.filter(job => job.origin === 'carry');
  const scope = work.carry_scope ? (JSON.parse(work.carry_scope) as Scope) : undefined;
  const basis: Basis = { kind: 'carry', agent: null, words: [] };
  if (!scope) {
    const picks = work.carry_code == null ? carries : carries.filter(job => job.carry_code === work.carry_code);
    return { picks, basis: { ...basis, ...(work.carry_code != null && { code: work.carry_code === 1 }) } };
  }
  const ranked = carries.flatMap(job => {
    if (!job.carry_scope) return [];
    const other = JSON.parse(job.carry_scope) as Scope;
    if (scope.typecheck !== other.typecheck || !!scope.tests.length !== !!other.tests.length) return [];
    const union = new Set([...scope.tests, ...other.tests]);
    const overlap = scope.tests.filter(area => other.tests.includes(area)).length;
    const score = union.size ? overlap / union.size : 1;
    return score ? [{ job, score }] : [];
  });
  return { picks: ranked.map(p => ({ ...p.job, comparison_weight: p.score })), basis: { ...basis, scope } };
}
