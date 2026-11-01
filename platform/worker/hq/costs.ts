// Feature costs beside time, with missing measurements and approval kept explicit.
import type { featureCosts } from '../../coordinator/src/featurecost.ts';
import type { TokenBudget } from '../../coordinator/src/tokenbudget.ts';
import type { Confidence } from '../../coordinator/src/confidence.ts';
import { text } from './output.ts';
export type FeatureCost = ReturnType<ReturnType<typeof featureCosts>['report']>;
const tokens = (count: number) => `${Math.round(count).toLocaleString('en-GB')} tokens`;
const weeks = (count: number | null) =>
  count === null ? 'seat-week use unmeasured' : `${(count * 100).toFixed(1)}% of a seat-week attributed`;
export function costLines(cost?: FeatureCost | null): string[] {
  if (!cost) return [];
  const expected = cost.expected;
  const planned = expected
    ? `${tokens(Object.values(expected.tokens).reduce((a, b) => a + b, 0))}, ${weeks(expected.seat_weeks)}, ${expected.feedback_rounds} expected board rounds`
    : 'not estimated';
  const used = cost.used;
  return [
    `Feature cost through approval: expected ${planned}; recorded so far ${tokens(used.total.tokens)}, ${weeks(used.total.seat_weeks)}.`,
    `  ${Object.entries(used.split)
      .map(([phase, spend]) => `${phase} ${tokens(spend.tokens)}`)
      .join(', ')}. ${cost.feedback_rounds} board feedback rounds, ${cost.review_rounds} review rounds.`,
    `  First delivery ${cost.first_delivery ?? 'not recorded'}; board approval ${cost.approved ?? 'not recorded'}.`,
    `  Meter gains are shared by run time on each seat. Tokens include cache reuse. Jobs without token reports: ${used.missing_usage}. Metered run time: ${Math.round(used.total.metered_ms / 60_000)} min. Unmetered work is excluded from seat use.`,
    ...(cost.after_delivery
      ? [
          `  Since first delivery${cost.approved ? ' through board approval' : ' so far'}: ${tokens(cost.after_delivery.total.tokens)}, ${weeks(cost.after_delivery.total.seat_weeks)}.`,
        ]
      : []),
    ...(expected
      ? [
          `  Expected split: ${Object.entries(expected.tokens)
            .map(([phase, count]) => `${phase} ${tokens(count)}`)
            .join(', ')}.`,
        ]
      : []),
    ...(expected ? [`  ${confidenceLine(expected.confidence)}`] : []),
    ...(expected ? [`  Basis (${text(expected.by)}): ${text(expected.why)}`] : []),
  ];
}

export function budgetLine(budget?: TokenBudget | null) {
  if (!budget) return 'Token estimate: not recorded.';
  const total = Object.values(budget.tokens).reduce((sum, count) => sum + count, 0);
  const split = Object.entries(budget.tokens)
    .map(([phase, count]) => `${phase} ${tokens(count)}`)
    .join(', ');
  return `Token estimate: ${tokens(total)} (${split}), ${budget.feedback_rounds} expected feedback rounds. Tokens include cache reuse. This is separate from the feature budget through approval.`;
}

export function confidenceLine(confidence?: Confidence | null) {
  return confidence
    ? `Estimate confidence: ${text(confidence.level)}. ${text(confidence.why)}`
    : 'Estimate confidence: not recorded.';
}
