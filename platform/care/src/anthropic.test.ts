// node --test src/anthropic.test.ts   (a local node:http server plays the Messages API's SSE; throwaway DATA_DIR)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Handler = (req: IncomingMessage, res: ServerResponse, body: any) => void;
let handle: Handler = () => {};
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => handle(req, res, JSON.parse(raw || '{}')));
});

let model: typeof import('./model.ts');
before(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  process.env.DATA_DIR = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'care-anthropic-'));
  process.env.CARE_PROVIDER = 'anthropic';
  process.env.CARE_ANTHROPIC_API = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.CARE_ANTHROPIC_API_KEY = 'test-key-not-real';
  process.env.CARE_MODEL = 'claude-sonnet-5-5';
  process.env.CARE_EFFORT = 'low';
  model = await import('./model.ts');
});
after(() => server.close());

const sse = (res: ServerResponse, events: any[]) => {
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
};
const start = (res: ServerResponse) => res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_test' });
const opts = (signal = new AbortController().signal) => ({
  cached: 'You are the helper. '.repeat(50), system: 'This chat is about the shop.', signal,
  messages: [{ role: 'user' as const, content: 'where is my parcel' }],
  tools: [{ name: 'order_status', description: 'Look up an order', input_schema: { type: 'object', properties: { order: { type: 'string' } },
    required: ['order'], additionalProperties: false } }],
});
async function collect(gen: AsyncGenerator<any>) { const out: any[] = []; for await (const e of gen) out.push(e); return out; }

test('a streamed turn gives the text as it comes, the tool call whole, the usage and the blocks to pass back', async () => {
  let sent: any, key: string | undefined;
  handle = (req, res, body) => {
    sent = body; key = req.headers['x-api-key'] as string;
    start(res);
    sse(res, [
      { type: 'message_start', message: { usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
      { type: 'ping' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'Looking up the order.' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig123' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'order_status', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"order": "BUD-' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '1042"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 57 } },
      { type: 'message_stop' },
    ]);
    res.end();
  };
  const events = await collect(model.stream(opts()));

  assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), 'Let me check.');
  assert.deepEqual(events.find(e => e.type === 'note'), { type: 'note', text: 'Looking up the order.' });
  assert.deepEqual(events.find(e => e.type === 'tool'), { type: 'tool', id: 'toolu_1', name: 'order_status', input: { order: 'BUD-1042' } });
  const usages = events.filter(e => e.type === 'usage');
  assert.equal(events[0].type, 'usage', 'usage comes first, so a draft cut short still knows its input');
  assert.deepEqual(usages.at(-1).usage, { input: 40, cacheWrite: 0, cacheRead: 900, output: 57 });
  const done = events.at(-1);
  assert.equal(done.stop, 'tool_use');
  assert.deepEqual(done.content[1], { type: 'thinking', thinking: 'Looking up the order.', signature: 'sig123' });
  assert.deepEqual(done.content[2], { type: 'tool_use', id: 'toolu_1', name: 'order_status', input: { order: 'BUD-1042' } });

  // the request Sonnet 5.5 accepts: no 'disabled' thinking, no forced tool, no temperature; the long part cached
  assert.equal(key, 'test-key-not-real');
  assert.equal(sent.model, 'claude-sonnet-5-5');
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.thinking, { type: 'between_tools' });
  assert.deepEqual(sent.output_config, { effort: 'low' });
  assert.deepEqual(sent.tool_choice, { type: 'auto' });
  assert.equal(sent.tools[0].strict, true);
  assert.equal('temperature' in sent, false);
  assert.deepEqual(sent.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(sent.system[1].text, 'This chat is about the shop.');
  assert.equal(sent.system[1].cache_control, undefined);
});

test("Haiku 5.5's request at care's low effort: the effort, thinking off, no temperature", async () => {
  const { request } = await import('./anthropic.ts');
  const { body } = request({ ...opts(), model: 'claude-haiku-5-5' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal('temperature' in body, false);
});

test('Haiku 5.5 above high effort: the effort, and no thinking setting, so it thinks adaptively', async () => {
  const { modelSettings } = await import('./anthropic.ts'); // EFFORT is read once at import: the rule itself, at xhigh
  assert.deepEqual(modelSettings('claude-haiku-5-5', 'xhigh'), { effort: true });
});

test("a tool that would take the strict tools past the API's limits is sent without strict", async () => {
  const { tools } = await import('./anthropic.ts');
  const closed = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
  const optional = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: 'string' }]));
  const nullable = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}`, { type: ['string', 'null'] }]));
  const sent = tools([
    { name: 'open', description: '', input_schema: { type: 'object', properties: optional(30) } }, // not closed: never strict, counts nothing
    { name: 'a', description: '', input_schema: closed({ report: closed(optional(10)) }, ['report']) }, // 10 optional, nested
    { name: 'b', description: '', input_schema: closed({ list: { type: 'array', items: closed(optional(10)) } }, ['list']) }, // 20
    { name: 'c', description: '', input_schema: closed(optional(5)) }, // 25: past the limit, without strict
    { name: 'd', description: '', input_schema: closed(optional(4)) }, // 24: still fits
    { name: 'e', description: '', input_schema: closed(nullable(16), Object.keys(nullable(16))) }, // 16 unions, none optional
    { name: 'f', description: '', input_schema: closed({ x: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, ['x']) }, // the 17th
  ]);
  assert.deepEqual(sent.map(t => [t.name, (t as any).strict ?? false]),
    [['open', false], ['a', true], ['b', true], ['c', false], ['d', true], ['e', true], ['f', false]]);
});

test('a tool call cut off by max_tokens is left out of the blocks passed back, so no tool_use goes without its result', async () => {
  handle = (_req, res) => {
    start(res);
    sse(res, [
      { type: 'message_start', message: { usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'order_status', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"order": "BUD-1042"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'order_status', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"order": "BUD-' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } },
      { type: 'message_stop' },
    ]);
    res.end();
  };
  const events = await collect(model.stream(opts()));
  assert.deepEqual(events.filter(e => e.type === 'tool').map(e => e.id), ['toolu_1']);
  const done = events.at(-1);
  assert.equal(done.stop, 'max_tokens');
  assert.deepEqual(done.content.map((b: any) => b.id), ['toolu_1']);
});

test('an overloaded API is a retryable ProviderError, before or during the stream; a bad request is not retryable', async () => {
  handle = (_req, res) => { res.writeHead(529, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'); };
  await assert.rejects(collect(model.stream(opts())), (e: any) => e instanceof model.ProviderError && e.status === 529 && e.retryable);

  handle = (_req, res) => {
    start(res);
    sse(res, [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
    res.end();
  };
  await assert.rejects(collect(model.stream(opts())), (e: any) => e.status === 529 && e.retryable);

  handle = (_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"invalid_request_error","message":"no"}}'); };
  await assert.rejects(collect(model.stream(opts())), (e: any) => e.status === 400 && !e.retryable);
});

test('an abort mid-stream ends the generator with an AbortError and closes the connection at once', async () => {
  let closed: Promise<void> = Promise.resolve();
  handle = (_req, res) => {
    closed = new Promise(r => res.on('close', () => r()));
    start(res);
    sse(res, [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }]);
    // and then nothing: the model is still "writing"
  };
  const stop = new AbortController();
  const seen: string[] = [];
  await assert.rejects(async () => {
    for await (const e of model.stream(opts(stop.signal))) if (e.type === 'text') { seen.push(e.text); stop.abort(); }
  }, (e: any) => model.isAbort(e));
  assert.deepEqual(seen, ['Hello']);
  await closed; // the server saw the connection close (the test would hang here otherwise)
});
