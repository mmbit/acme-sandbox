// One model call that must end in one tool call, for the work done in the background: drafts, summaries, HQ's cards.
import * as model from './model.ts';
import * as ledger from './ledger.ts';
import { settings } from './company.ts';

export const TRIES = 3; // a call that failed is tried this many times in all (one without the tool costs each time)...
export const RETRY_MS = 5 * 60_000; // ...this far apart
const CALL_MS = 60_000; // a hung call mustn't hold its work for ever

// A piece of work whose calls failed: how many tries, and when the last one was
export type Failure = { n: number; at: number };
// Its tries spent, or the last too recent to try again
export const waiting = (f: Failure | undefined, t: number) => !!f && (f.n >= TRIES || t - f.at < RETRY_MS);
// One more failed try at t: returns the new count
export function recordFailure<K>(failed: Map<K, Failure>, id: K, t: number) {
  const n = (failed.get(id)?.n ?? 0) + 1;
  failed.set(id, { n, at: t });
  return n;
}

// A tool's input: every property required, nothing else
export const objectSchema = (props: Record<string, any>) => ({
  type: 'object',
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});
// A string field of the tool's input, trimmed and cut to max, else ''
export const clip = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');

type Call = {
  app: string;
  conversation: number | null;
  purpose: ledger.Purpose;
  what: string;
  system: string;
  content: string;
  tool: model.ToolDef;
};

// The tool's input, or null (logged by id and status only, never content)
export async function ask({ app, conversation, purpose, what, system, content, tool }: Call) {
  // the customers' chats probe a provider that's down (one probe per 30 s); background work waits for them, so it never
  // takes the probe or counts toward the breaker
  if (ledger.breaker.state() === 'down') return null;
  // the month's cap (every app together) and the app's day: a draft for the board is never worth a customer's chat
  if (ledger.blocked({ app, verified: true })) return null;
  let usage: model.Usage | null = null,
    out = 0,
    input: any = null;
  const messages: model.Message[] = [{ role: 'user', content }];
  const signal = AbortSignal.timeout(CALL_MS);
  const row = (u: model.Usage, estimate = false) =>
    ledger.record({ app, conversation, purpose, model: settings.model, usage: u, estimate });
  try {
    for await (const ev of model.stream({ system, messages, tools: [tool], signal, model: settings.model })) {
      if (ev.type === 'usage') usage = ev.usage;
      else if (ev.type === 'text') out += ev.text.length;
      else if (ev.type === 'tool' && ev.name === tool.name && !input) input = ev.input;
    }
  } catch (err: any) {
    // a call that failed after the provider reported usage, or timed out mid-stream, was still billed
    if (usage || out) row(ledger.estimate(usage, out, system.length + content.length), true);
    console.error(`care: ${what}: the ${purpose} call failed (${err?.status ?? err?.name ?? 'error'})`);
    return null;
  }
  row(usage ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  if (!input) console.error(`care: ${what}: the ${purpose} call ended without ${tool.name}`);
  return input;
}
