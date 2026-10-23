// The provider-neutral model interface: one stream() for every provider, picked by PROVIDER.
import { PROVIDER } from './config.ts';
import * as anthropic from './anthropic.ts';
import * as fake from './fake.ts';

export type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [k: string]: any }; // thinking and the like: passed back untouched, never edited
export type Message = { role: 'user' | 'assistant'; content: string | Block[] };
export type ToolDef = { name: string; description: string; input_schema: any };
export type Usage = { input: number; cacheWrite: number; cacheRead: number; output: number };
export type Event = { type: 'text'; text: string }   // a delta of the visible reply
  | { type: 'note'; text: string }                    // a progress note the model wrote between tool calls (not the reply)
  | { type: 'tool'; id: string; name: string; input: any } // a complete tool call
  | { type: 'usage'; usage: Usage }                   // cumulative so far (sent early and at the end)
  | { type: 'done'; stop: string; content: Block[] }; // the assistant turn's blocks, to append before the tool results
// warm: only to have the prompt read into the cache, the caller stopping at the first usage event
export type Options = { system: string; cached?: string; messages: Message[]; tools: ToolDef[]; signal: AbortSignal;
  model?: string; maxTokens?: number; warm?: boolean };

// A failed call. retryable: worth one more try (and counts toward the breaker); otherwise it's our request that's wrong.
export class ProviderError extends Error {
  status: number;
  retryable: boolean;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryableStatus(status);
  }
}
// 0 is a network failure; 408/409 are the API's own "try again"; 529 is overloaded
export const retryableStatus = (status: number) => status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;

// What every provider throws when the signal fires, whatever it was doing (a reason given to abort() isn't passed on)
export const abortError = () => new DOMException('The model call was stopped', 'AbortError');
export const isAbort = (err: any) => err?.name === 'AbortError';

// The most model calls one turn makes, a chat answer or a phone turn (helper.ts, phone.ts). The bound is the turn's time,
// not the model's context: a round adds only its tool calls and their results to the request, while the person waits
// through every round (the chat shows the tools' status lines until the round that answers, engine.ts Out.release, and
// the caller hears the steps). A turn that reaches it with tools' results still unread says so (rounds_out). 6 isn't
// derived from measured times yet: care counts them (numbers.ts took(), rounds()), and nothing bounds a whole turn's
// wait (engine.ts FIRST_MS times only its first event).
export const TURN_ROUNDS = 6;

const providers: Record<string, (o: Options) => AsyncGenerator<Event>> = { anthropic: anthropic.stream, fake: fake.stream };
if (!providers[PROVIDER]) throw new Error(`Care has no model provider called ${PROVIDER} (CARE_PROVIDER: anthropic or fake)`);

export function stream(o: Options): AsyncGenerator<Event> {
  return providers[PROVIDER](o);
}
