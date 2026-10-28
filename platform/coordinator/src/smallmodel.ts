// The small model the coordinator asks for short structured answers (the sizer's sizes, a meeting's bubbles): its name,
// the longest prompt it reads, and its answer read from the CLI's result. The worker makes the call (worker.ts smallCall).

import { randomUUID } from 'node:crypto';
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

// ---------------------------------------------------------------- the reads queue
// One short call on the worker's small model, put up for the worker to claim (POST /api/worker/reads/claim, worker.ts
// readLoop) and answered by it (/answer): the board's handwriting read into type (handwriting.ts) and the book's judge
// (ink/bookjudge.ts). The content (pictures and words) lives in memory only, for the length of the call. Each caller
// bounds its own calls a day and checks its own answer (check: the answer, or what's wrong with it).
// A claimed call that hasn't answered within CALL_MS has died (oneLine kills the CLI at 90 s): due again, TRIES in all.
const CALL_MS = 95_000,
  TRIES = 2;
export type Claimed = { reading: string; model: string; content: unknown[]; schema: string };
type Waiting = {
  id: string;
  name: string;
  content: unknown[];
  schema: string;
  claimed: number;
  tries: number;
  check: (result: unknown) => unknown;
  failed: string;
  done: (r: unknown) => void;
};
// (ids unique across restarts: a worker's call outlives the coordinator, and its answer must not meet a later call's id)
const waiting: Waiting[] = [];

// The model's answer to content (the prompt: pictures and text) in the schema's shape, as check reads it; 504 when none
// came within wait ms, 502 when the model's answers were no use. name: who asks, as the log and the refusals say it.
// keepAlive false: a call no request waits on doesn't hold the process open.
export function smallCall<T>(c: {
  name: string;
  content: unknown[];
  schema: object;
  check: (result: unknown) => T | string;
  wait: number;
  late?: string;
  failed?: string;
  keepAlive?: boolean;
}): Promise<T | [number, string]> {
  return new Promise(resolve => {
    const w: Waiting = {
      id: randomUUID(),
      name: c.name,
      content: c.content,
      schema: JSON.stringify(c.schema),
      claimed: 0,
      tries: 0,
      check: c.check,
      failed: c.failed ?? `${c.name} couldn't answer`,
      done: answer => {
        clearTimeout(late);
        waiting.splice(waiting.indexOf(w), 1);
        resolve(answer as T | [number, string]);
      },
    };
    const late = setTimeout(() => w.done([504, c.late ?? `${c.name} gave no answer in time`]), c.wait);
    if (c.keepAlive === false) late.unref();
    waiting.push(w);
  });
}

// POST /api/worker/reads/claim: the next call to make, with its prompt and the answer's schema; null while there's none
export function claim(now = Date.now()): Claimed | null {
  const w = waiting.find(x => !x.claimed || (x.claimed <= now - CALL_MS && x.tries < TRIES));
  if (!w) return null;
  w.claimed = now;
  w.tries++;
  return { reading: w.id, model: MODEL, content: w.content, schema: w.schema };
}

// POST /api/worker/reads/answer: the model's answer, or the call's failure (due again while it has tries left)
export function answer(given: { reading?: unknown; result?: unknown; error?: unknown }) {
  const w = waiting.find(x => x.id === given.reading);
  if (!w) return { written: 0, why: 'no reading waits for it' };
  const a = given.error === undefined ? w.check(given.result) : 'the call failed';
  if (typeof a === 'string') {
    console.error(
      `Small model (${w.name}): call ${w.id} failed: ${a}${given.error ? `: ${redact(String(given.error)).slice(-200)}` : ''}`,
    );
    if (w.tries < TRIES) w.claimed = 0;
    else w.done([502, w.failed]);
    return { written: 0, why: a };
  }
  w.done(a);
  return { written: 1 };
}
