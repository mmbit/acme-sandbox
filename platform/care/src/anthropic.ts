// The Anthropic Messages API, streamed over fetch and SSE (no SDK: product apps have no dependencies).
import { ANTHROPIC_API, ANTHROPIC_KEY, EFFORT } from './config.ts';
import { settings } from './company.ts';
import { ProviderError, abortError, type Block, type Event, type Message, type Options, type Usage } from './model.ts';

const MAX_TOKENS = 4096; // replies are a few short bubbles; this only stops a runaway, and thinking counts toward it

// What each model accepts (the Model releases note). Sonnet 5.5 can't turn thinking off: between_tools is its lowest
// setting, accepted at high effort or below, and it's also the one that returns the notes written between tool calls
// as text (in thinking blocks) without a display setting. Haiku 4.5 takes no effort and thinks only when asked.
// Haiku 5.5 takes effort and thinks adaptively unless told not to. It accepts thinking off at high effort or below, so
// it is off there, as for Sonnet 5, and a chat reply starts at once.
export const modelSettings = (model: string, effort: string): { thinking?: any; effort?: boolean; beta?: string } => {
  const low = ['low', 'medium', 'high'].includes(effort);
  if (model.startsWith('claude-sonnet-5-5')) return { thinking: low ? { type: 'between_tools' } : { type: 'adaptive' }, effort: true };
  if (model.startsWith('claude-opus-5-5'))
    return { thinking: { type: 'adaptive', display: 'updates' }, effort: true, beta: 'thinking-display-updates-2026-08-18' };
  if (model === 'claude-sonnet-5') return { thinking: { type: 'disabled' }, effort: true };
  if (model.startsWith('claude-haiku-5-5')) return low ? { thinking: { type: 'disabled' }, effort: true } : { effort: true };
  if (model.startsWith('claude-haiku-4-5')) return {};
  return { effort: true };
};

// Strict tool use (schema-valid input, since forcing a tool is gone) needs a closed schema, so it's on only for a tool whose
// schema is closed. Strict tools share two API limits, 24 optional fields and 16 union fields in all, and past either the
// API refuses the whole request. A tool that would go past one is sent without strict, and later tools still get it if they
// fit
const STRICT_LIMITS = { optional: 24, unions: 16 };
export function tools(list: Options['tools']) {
  const used = { optional: 0, unions: 0 };
  return list.map(t => {
    if (t.input_schema?.additionalProperties !== false) return t;
    const counted = countStrictFields(t.input_schema);
    if (used.optional + counted.optional > STRICT_LIMITS.optional || used.unions + counted.unions > STRICT_LIMITS.unions) return t;
    used.optional += counted.optional;
    used.unions += counted.unions;
    return { ...t, strict: true };
  });
}

function countStrictFields(schema: any): { optional: number; unions: number } {
  const total = { optional: 0, unions: 0 };
  if (!schema || typeof schema !== 'object') return total;
  if (Array.isArray(schema.type) || schema.anyOf) total.unions++;
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties ?? {});
  total.optional += properties.filter(([name]) => !required.has(name)).length;
  for (const child of [...properties.map(([, propertySchema]) => propertySchema), schema.items, ...(schema.anyOf ?? [])]) {
    const inner = countStrictFields(child);
    total.optional += inner.optional;
    total.unions += inner.unions;
  }
  return total;
}

// A second cache breakpoint on the newest block, so the next call in this turn (after a tool) and the next turn read
// the conversation so far from the cache too. Copies: the caller's history stays as it was.
function withBreakpoint(messages: Message[]): any[] {
  const out: any[] = messages.slice();
  const last = out.at(-1);
  if (!last) return out;
  const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.slice();
  const end = content.at(-1);
  if (end && (end.type === 'text' || end.type === 'tool_result')) content[content.length - 1] = { ...end, cache_control: { type: 'ephemeral' } };
  out[out.length - 1] = { ...last, content };
  return out;
}

export function request(o: Options) {
  const model = o.model || settings.model;
  const s = modelSettings(model, EFFORT);
  // tools render first, then system: the breakpoint on the cached block covers the tools, the instructions and the knowledge
  const system = [
    ...(o.cached ? [{ type: 'text', text: o.cached, cache_control: { type: 'ephemeral' } }] : []),
    ...(o.system ? [{ type: 'text', text: o.system }] : []),
  ];
  const body: any = { model, max_tokens: o.maxTokens ?? MAX_TOKENS, stream: true, system, messages: withBreakpoint(o.messages) };
  if (o.tools.length) { body.tools = tools(o.tools); body.tool_choice = { type: 'auto' }; }
  if (s.thinking) body.thinking = s.thinking;
  if (s.effort) body.output_config = { effort: EFFORT };
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' };
  if (s.beta) headers['anthropic-beta'] = s.beta;
  return { url: `${ANTHROPIC_API.replace(/\/$/, '')}/v1/messages`, headers, body };
}

// The API's error types, for an error that arrives inside a stream that began with a 200
const STATUS: Record<string, number> = { invalid_request_error: 400, authentication_error: 401, permission_error: 403,
  not_found_error: 404, request_too_large: 413, rate_limit_error: 429, api_error: 500, overloaded_error: 529 };

// One line per failure, status and error type only: never the message text, never the key
function fail(status: number, type: string, id: string | null): never {
  console.error(`anthropic: ${status || 'network'} ${type}${id ? ` (${id})` : ''}`);
  throw new ProviderError(status, `Anthropic: ${status || 'network'} ${type}`);
}

const usageOf = (u: any, prev: Usage): Usage => ({
  input: u?.input_tokens ?? prev.input,
  cacheWrite: u?.cache_creation_input_tokens ?? prev.cacheWrite,
  cacheRead: u?.cache_read_input_tokens ?? prev.cacheRead,
  output: u?.output_tokens ?? prev.output,
});

export async function* stream(o: Options): AsyncGenerator<Event> {
  if (!ANTHROPIC_KEY) fail(503, 'no_key', null); // the key isn't set yet: down, like an outage (config.ts PROVIDER)
  const { url, headers, body } = request(o);
  let res: Response;
  try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: o.signal }); }
  catch { if (o.signal.aborted) throw abortError(); fail(0, 'unreachable', null); }
  const id = res.headers.get('request-id');
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    fail(res.status, err?.error?.type ?? 'error', id);
  }

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const blocks: any[] = [];
  const json: string[] = []; // a tool call's input arrives as pieces of JSON text
  let usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let stop = '';
  let buffer = '';
  let finished = false;
  try {
    while (!finished) {
      let chunk;
      try { chunk = await reader.read(); }
      catch { if (o.signal.aborted) throw abortError(); fail(0, 'stream broke', id); }
      if (chunk.done) break;
      buffer += chunk.value.replace(/\r\n/g, '\n');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const e = JSON.parse(data);
        if (e.type === 'message_start') {
          usage = usageOf(e.message?.usage, usage);
          yield { type: 'usage', usage };
        } else if (e.type === 'content_block_start') {
          blocks[e.index] = { ...e.content_block };
          if (e.content_block.type === 'tool_use') json[e.index] = '';
        } else if (e.type === 'content_block_delta') {
          const b = blocks[e.index], d = e.delta;
          if (d.type === 'text_delta') { b.text += d.text; yield { type: 'text', text: d.text }; }
          else if (d.type === 'input_json_delta') json[e.index] += d.partial_json;
          else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
          else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + d.signature;
        } else if (e.type === 'content_block_stop') {
          const b = blocks[e.index];
          if (b.type === 'tool_use') {
            // a call cut off by max_tokens has broken JSON: it isn't emitted, nor kept in done.content (a tool_use there with
            // no tool_result would fail the next round), and done.stop says why
            try { b.input = json[e.index] ? JSON.parse(json[e.index]) : {}; } catch { blocks[e.index] = undefined; continue; }
            yield { type: 'tool', id: b.id, name: b.name, input: b.input };
          } else if (b.type === 'thinking' && b.thinking) yield { type: 'note', text: b.thinking };
        } else if (e.type === 'message_delta') {
          stop = e.delta?.stop_reason ?? stop;
          usage = usageOf(e.usage, usage);
          yield { type: 'usage', usage };
        } else if (e.type === 'message_stop') finished = true;
        else if (e.type === 'error') fail(STATUS[e.error?.type] ?? 500, e.error?.type ?? 'error', id);
      }
    }
    if (!finished) fail(0, 'stream ended early', id);
    yield { type: 'done', stop, content: blocks.filter(Boolean) as Block[] };
  } finally {
    // stopping early (an abort, an error, or the caller leaving the loop) closes the connection: output stops being billed
    reader.cancel().catch(() => { /* already closed */ });
  }
}
