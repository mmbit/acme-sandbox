// Observed run-history complications that exclude a job from clean timing comparisons.
export type TimingFlag =
  | 'rebuilt'
  | 'unknown_seat'
  | 'invalid_time'
  | 'resumed'
  | 'yielded'
  | 'parked'
  | 'interrupted'
  | 'failed'
  | 'limited'
  | 'lost'
  | 'snagged'
  | 'up' // a run handed up from a lighter model
  | 'unknown_outcome'
  | 'replacement';
export type TimingEvidence = {
  outcomes: string;
  invalid_runs: number;
  unknown_seats: number;
  // The job replaces another (it has an instead_of), not that a later job replaced it.
  is_replacement: number;
  runs: number;
};

// These are exclusion signals, not a claim that the recorded duration is inflated. A yield's queue gap is already absent.
export function timingFlags(evidence: TimingEvidence): TimingFlag[] {
  const flags: TimingFlag[] = [];
  const outcomes = new Set(evidence.outcomes.split(','));
  if (evidence.unknown_seats) flags.push('unknown_seat');
  if (evidence.invalid_runs) flags.push('invalid_time');
  if (evidence.runs > 1) flags.push('resumed');
  if (evidence.is_replacement) flags.push('replacement');
  for (const outcome of outcomes) {
    if (outcome === 'done') continue;
    if (OUTCOMES.has(outcome)) flags.push(outcome as TimingFlag);
    else if (!flags.includes('unknown_outcome')) flags.push('unknown_outcome');
  }
  return flags;
}
const OUTCOMES = new Set(['rebuilt', 'yielded', 'parked', 'interrupted', 'failed', 'limited', 'lost', 'snagged', 'up']);
