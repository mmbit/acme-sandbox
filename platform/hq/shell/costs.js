// Feature cost beside ETA, in the same words in every HQ look.
import { esc } from '../util.js';
const count = value => Math.round(value).toLocaleString('en-GB');
const weeks = value =>
  value == null ? 'seat use unmeasured' : `${(value * 100).toFixed(1)}% of a seat-week attributed`;
export function costHtml(cost) {
  if (!cost) return '';
  const used = cost.used.total;
  const expected = cost.expected;
  const planned = expected
    ? `${count(Object.values(expected.tokens).reduce((a, b) => a + b, 0))} tokens, ${weeks(expected.seat_weeks)}`
    : 'not estimated';
  const parts = [
    `Expected through approval: ${planned}`,
    `Recorded so far: ${count(used.tokens)} tokens, ${weeks(used.seat_weeks)}`,
    `${cost.feedback_rounds} board feedback rounds included. ${cost.approved ? 'Board approval recorded' : 'Board approval not recorded'}`,
  ];
  if (cost.used.missing_usage || used.seat_weeks !== null)
    parts.push(`Metered work only. ${cost.used.missing_usage} jobs without token reports. Tokens include cache reuse.`);
  if (cost.after_delivery)
    parts.push(
      `Since first delivery${cost.approved ? ' through approval' : ' so far'}: ${count(cost.after_delivery.total.tokens)} tokens`,
    );
  return parts.map(part => `<small>${esc(part)}</small>`).join('');
}
export function projectCostHtml(cost) {
  if (!cost) return '';
  const expected =
    cost.missing_estimates === cost.features
      ? 'not estimated'
      : `${count(cost.expected_tokens)} tokens${cost.missing_estimates ? ' plus unestimated features' : ''}`;
  return `<small>${esc(`Feature cost: expected ${expected}. Recorded ${count(cost.used.total.tokens)} tokens, ${weeks(cost.used.total.seat_weeks)}`)}</small>`;
}
