// A scripted model provider: the tests say what it answers, and the local harness gets a plain one that needs no key.
import { readFileSync, writeFileSync } from 'node:fs';
import { ProviderError, abortError, type Block, type Event, type Message, type Options, type ToolDef, type Usage } from './model.ts';

// until: the stream goes on once the test opens that gate (a step that happens when the test says, not after a guess)
export type Step = { text: string } | { tool: string; input: any } | { note: string } | { wait: number } | { until: Promise<unknown> } | { fail: number };
export type Script = (o: { system: string; cached?: string; messages: Message[]; tools: ToolDef[] }) => Step[] | Promise<Step[]>;

const textOf = (c: Message['content']) => typeof c === 'string' ? c : c.map((b: any) => b.type === 'text' ? b.text : '').join('');

// The local harness's model: says plainly what it is, echoes the newest words, calls no tools
const plain: Script = ({ messages }) => {
  const said = textOf([...messages].reverse().find(m => m.role === 'user')?.content ?? '').trim().slice(0, 200);
  return [{ text: `I'm the stand-in model on this test server, so I can't really help yet. You wrote: "${said}"` }];
};

let current: Script = plain;
// Set the script for the next calls; no argument goes back to the plain one
export const script = (fn?: Script) => { current = fn ?? plain; };

// The local harness drives the model from outside this process (demo/shop.mjs fake()): CARE_FAKE_FILE names a JSON file
// holding { fail: true } (the provider is down: every call fails as overloaded) or { next: [[step, …], …] } (the next
// calls' answers, one list each, used up in order). No file, or nothing in it: the script above answers.
const CONTROL = process.env.CARE_FAKE_FILE;
function control(): Step[] | null {
  if (!CONTROL) return null;
  let c: any;
  try { c = JSON.parse(readFileSync(CONTROL, 'utf8')); } catch { return null; }
  if (c?.fail) return [{ fail: 529 }];
  if (!Array.isArray(c?.next) || !c.next.length) return null;
  const steps = c.next.shift();
  writeFileSync(CONTROL, JSON.stringify(c));
  return Array.isArray(steps) ? steps : null;
}

const tokens = (s: string) => Math.ceil(s.length / 4); // about four characters a token: made up, but plausible
const seen = new Set<string>(); // the cached prefixes "written" so far, so a second call reads them like the real cache

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(abortError()); };
    signal.addEventListener('abort', stop, { once: true });
  });
}
// the gate opening, or the call's abort, whichever comes first
function opened(gate: Promise<unknown>, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const stop = () => reject(abortError());
    signal.addEventListener('abort', stop, { once: true });
    gate.then(() => { signal.removeEventListener('abort', stop); resolve(); }, reject);
  });
}

export async function* stream(o: Options): AsyncGenerator<Event> {
  // (a warm-up only reads the prompt: it takes no answer of the script's)
  const steps = o.warm ? [] : control() ?? await current({ system: o.system, cached: o.cached, messages: o.messages, tools: o.tools });
  const prefix = (o.cached ?? '') + JSON.stringify(o.tools);
  const fresh = !seen.has(prefix);
  seen.add(prefix);
  const usage: Usage = {
    input: tokens(o.system + JSON.stringify(o.messages)),
    cacheWrite: fresh ? tokens(prefix) : 0,
    cacheRead: fresh ? 0 : tokens(prefix),
    output: 0,
  };
  yield { type: 'usage', usage: { ...usage } };

  const content: Block[] = [];
  let calls = 0;
  for (const step of steps) {
    await sleep(0, o.signal); // a turn of the event loop between steps, so an abort lands mid-stream
    if ('fail' in step) throw new ProviderError(step.fail, `Fake: ${step.fail}`);
    if ('wait' in step) await sleep(step.wait, o.signal);
    if ('until' in step) await opened(step.until, o.signal);
    if ('text' in step) {
      const block = { type: 'text', text: '' };
      content.push(block);
      for (const word of step.text.match(/\S+\s*/g) ?? []) {
        await sleep(0, o.signal);
        block.text += word;
        usage.output += tokens(word);
        yield { type: 'text', text: word };
      }
    }
    if ('note' in step) { // a progress note between tool calls, as Sonnet 5.5 sends it: a thinking block
      content.push({ type: 'thinking', thinking: step.note, signature: 'fake' });
      usage.output += tokens(step.note);
      yield { type: 'note', text: step.note };
    }
    if ('tool' in step) {
      const id = `toolu_fake_${++calls}_${Math.random().toString(36).slice(2, 8)}`;
      content.push({ type: 'tool_use', id, name: step.tool, input: step.input });
      usage.output += 20 + tokens(JSON.stringify(step.input));
      yield { type: 'tool', id, name: step.tool, input: step.input };
    }
  }
  yield { type: 'usage', usage: { ...usage } };
  yield { type: 'done', stop: calls ? 'tool_use' : 'end_turn', content };
}
