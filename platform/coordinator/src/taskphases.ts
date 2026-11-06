// Shared phase definitions for whole-task time and feature costs.
export const COST_PHASES = ['work', 'reviews', 'fixes', 'feedback'] as const;
export type CostPhase = (typeof COST_PHASES)[number];
// syncs: an author's job on a pull request outside any review round, shown as send-backs: a check's before review (the
// tests, the gates, the previews), bringing it up to date with main, pushing it again. Mostly the checks', so it is no
// count of merges with main.
export type Phase = 'work' | 'reviews' | 'fixes' | 'syncs' | 'previews';
type Member = { kind: string; stage: string | null; round: number | null; fix: number; preview?: number };
const isReview = (member: Pick<Member, 'kind'>) => member.kind === 'review' || member.kind === 'consolidate';
export function phaseOf(member: Member): Phase {
  if (isReview(member)) return 'reviews';
  if (member.fix || member.stage === 'feedback' || (member.stage === 'fix' && member.round !== null)) return 'fixes';
  if (member.stage === 'fix') return 'syncs';
  if (member.preview) return 'previews';
  return 'work';
}
export const costPhase = (phase: Phase): CostPhase =>
  phase === 'work' ? 'work' : phase === 'reviews' || phase === 'previews' ? 'reviews' : 'fixes';
