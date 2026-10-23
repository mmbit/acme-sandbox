// The small model the coordinator asks for short structured answers (the sizer's sizes, a meeting's bubbles): its name,
// the longest prompt it reads, and its answer read from the CLI's result. The worker makes the call (worker.ts smallCall).

import { redact } from './secrets.ts';

// The model's name, as the CLI takes it and as the sizer's sizes are marked (sizes.ts).
export const MODEL = 'haiku';

// A prompt fits the model's context: Haiku's 200,000 tokens less the most it may write back, at three characters a
// token (prose takes four: paths and code take more tokens, and the CLI's own system prompt the rest).
const CONTEXT_TOKENS = 200_000,
  REPLY_TOKENS = 64_000,
  CHARS_PER_TOKEN = 3;
export const PROMPT_CHARS = (CONTEXT_TOKENS - REPLY_TOKENS) * CHARS_PER_TOKEN;

// The answer, or what's wrong with it: the structured output the schema asked for (the result's own text when the CLI
// didn't give one). Each caller checks its own fields.
export function answerOf(result: unknown): Record<string, unknown> | string {
  const r = result as { is_error?: boolean; structured_output?: unknown; result?: unknown } | null;
  if (!r || typeof r !== 'object') return 'no answer';
  // (with the CLI's own words, an API error or a refused prompt, so the log says why.)
  if (r.is_error) return `the call failed${typeof r.result === 'string' ? `: ${redact(r.result).slice(0, 200)}` : ''}`;
  let a = r.structured_output as Record<string, unknown> | undefined;
  if (a === undefined && typeof r.result === 'string')
    try {
      a = JSON.parse(r.result);
    } catch {
      return "an answer that isn't JSON";
    }
  if (!a || typeof a !== 'object') return 'no answer';
  return a;
}
