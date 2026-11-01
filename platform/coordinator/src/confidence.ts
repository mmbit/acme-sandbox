// The estimator's judgment about the evidence behind its time and token budget.
export const levels = ['low', 'medium', 'high'] as const;
export type Confidence = { level: (typeof levels)[number]; why: string };

export function readConfidence(value: unknown): Confidence | string {
  if (!value || typeof value !== 'object') return 'give confidence with level and why beside the estimate';
  const confidence = value as Partial<Confidence>;
  if (!levels.includes(confidence.level!))
    return 'confidence.level must be low, medium or high, chosen by the estimator';
  if (typeof confidence.why !== 'string' || !confidence.why.trim())
    return 'confidence.why must explain how many past examples fit, how close they are and what is missing';
  return { level: confidence.level!, why: confidence.why.trim() };
}
