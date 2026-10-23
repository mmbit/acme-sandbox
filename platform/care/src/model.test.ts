// node --test src/model.test.ts   (the fake provider, as the engine's tests and the local harness use it; throwaway DATA_DIR)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let model: typeof import('./model.ts'), fake: typeof import('./fake.ts');
before(async () => {
  process.env.DATA_DIR = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'care-model-'));
  delete process.env.CARE_ANTHROPIC_API_KEY;
  delete process.env.CARE_PROVIDER; // no key on a local run: the fake, so a page works without one
  process.env.CARE_LOCAL = '1';
  model = await import('./model.ts');
  fake = await import('./fake.ts');
});

const opts = (signal = new AbortController().signal) => ({ cached: 'The helper\'s instructions. '.repeat(40), system: 'Shop',
  messages: [{ role: 'user' as const, content: 'hi, where is ORD-1042?' }], tools: [], signal });
async function collect(gen: AsyncGenerator<any>) { const out: any[] = []; for await (const e of gen) out.push(e); return out; }

test('without a key the plain fake answers, and the second call reads the prefix from the "cache"', async () => {
  fake.script();
  const first = await collect(model.stream(opts()));
  assert.match(first.filter(e => e.type === 'text').map(e => e.text).join(''), /stand-in model.*ORD-1042/);
  assert.equal(first.at(-1).stop, 'end_turn');
  const u1 = first.findLast(e => e.type === 'usage').usage, u2 = (await collect(model.stream(opts()))).findLast(e => e.type === 'usage').usage;
  assert.ok(u1.cacheWrite > 0 && u1.cacheRead === 0 && u1.output > 0);
  assert.ok(u2.cacheWrite === 0 && u2.cacheRead === u1.cacheWrite);
});

test('a script plays tool calls and failures, and an abort during a wait ends it at once', async () => {
  fake.script(({ messages }) => messages.length === 1 ? [{ text: 'Checking.' }, { tool: 'order_status', input: { order: 'ORD-1042' } }] : [{ fail: 529 }]);
  const events = await collect(model.stream(opts()));
  const done = events.at(-1);
  assert.equal(done.stop, 'tool_use');
  assert.deepEqual(done.content.map((b: any) => b.type), ['text', 'tool_use']);
  assert.equal(events.find(e => e.type === 'tool').id, done.content[1].id);

  const next = { ...opts(), messages: [...opts().messages, { role: 'assistant' as const, content: done.content },
    { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: done.content[1].id, content: '{"status":"shipped"}' }] }] };
  await assert.rejects(collect(model.stream(next)), (e: any) => e instanceof model.ProviderError && e.retryable);

  fake.script(() => [{ text: 'One moment' }, { wait: 60_000 }, { text: 'never' }]);
  const stop = new AbortController();
  const t = Date.now();
  setTimeout(() => stop.abort(), 50);
  const seen: string[] = [];
  await assert.rejects(async () => { for await (const e of model.stream(opts(stop.signal))) if (e.type === 'text') seen.push(e.text); },
    (e: any) => model.isAbort(e));
  assert.deepEqual(seen, ['One ', 'moment']);
  assert.ok(Date.now() - t < 1000);
});

test('on the server, no key is the model being down (the outage card), never the stand-in', () => {
  const env = { ...process.env, CARE_LOCAL: '', CARE_PROVIDER: '', CARE_ANTHROPIC_API_KEY: '' };
  delete (env as any).CARE_LOCAL; delete (env as any).CARE_PROVIDER; delete (env as any).CARE_ANTHROPIC_API_KEY;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { PROVIDER } = await import(${JSON.stringify(new URL('./config.ts', import.meta.url).href)});
    const model = await import(${JSON.stringify(new URL('./model.ts', import.meta.url).href)});
    try { for await (const _ of model.stream({ system: '', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal })); console.log(PROVIDER, 'answered'); }
    catch (e) { console.log(PROVIDER, e instanceof model.ProviderError && e.retryable); }`], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(out.trim(), 'anthropic true');
});
