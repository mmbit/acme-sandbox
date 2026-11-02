// Agent-supplied token expectations, separate from scheduling time and subscription meters.
import { readConfidence } from './confidence.ts';
import { COST_PHASES as phases, type CostPhase } from './taskphases.ts';
export type TokenBudget = { tokens: Record<CostPhase, number>; feedback_rounds: number };
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function readBudget(value: unknown): TokenBudget | string {
  if (!value || typeof value !== 'object') return 'give a token split and expected feedback_rounds beside time';
  const budget = value as Partial<TokenBudget>;
  if (!budget.tokens || phases.some(phase => !nonnegative(budget.tokens?.[phase])))
    return 'tokens must give nonnegative work, reviews, fixes and feedback counts';
  if (!nonnegative(budget.feedback_rounds)) return 'feedback_rounds must be a nonnegative expected count';
  return {
    tokens: Object.fromEntries(phases.map(phase => [phase, budget.tokens![phase]])) as TokenBudget['tokens'],
    feedback_rounds: budget.feedback_rounds,
  };
}

export function readSizing(value: unknown) {
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      value = JSON.parse(value);
    } catch {
      return 'size must be valid JSON with time, tokens, feedback_rounds and confidence';
    }
  }
  if (typeof value === 'string') return { time: value, budget: null, confidence: null };
  if (!value || typeof value !== 'object')
    return 'give --size with time, tokens, feedback_rounds and confidence as JSON';
  const budget = readBudget(value);
  if (typeof budget === 'string') return budget;
  const time = (value as { time?: unknown }).time;
  if (typeof time !== 'string') return 'size.time must give agent time, such as 35m';
  const confidence = readConfidence((value as { confidence?: unknown }).confidence);
  if (typeof confidence === 'string') return confidence;
  return { time, budget, confidence };
}
