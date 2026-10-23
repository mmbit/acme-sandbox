// One turn of a phone call (phone.ts runs the routes): the caller's words in, the code read out of them first, in
// code; the model's reply out as lines as it's written, its language tag taken off (phonelang.ts), its tools run
// (phonetools.ts); and what stops the phone.
import { CAP } from './config.ts';
import { now } from './db.ts';
import * as model from './model.ts';
import * as ledger from './ledger.ts';
import * as numbers from './numbers.ts';
import { t, languageName } from './texts.ts';
import { settings } from './company.ts';
import { healthTerm } from '../public/health.js';
import { save, about, store, hold, type Conv } from './phonecall.ts';
import { readCode } from './phonecode.ts';
import { instructions, tools, run, facts, recordObjection } from './phonetools.ts';
import { history, tagOf, tagged, tagging, wording, UntaggedError, OffLanguageError, type Spoken } from './phonelang.ts';

const TEXT_MAX = 2000; // a turn's words: a long one is a minute or two of speech

// ---- what stops the phone: off (no month of its own), its own month or the month's total (and an app's day), the breaker
export const phoneCap = () => Math.max(CAP.phoneMonth ?? settings.phoneMonth, 0);
// probe: a turn may be the breaker's probe while it's down (one every 30 s); a call doesn't start on one
export function stopped(app: string, probe: boolean): 'off' | 'cap' | 'down' | null {
  if (!(phoneCap() > 0)) return 'off';
  if (ledger.monthSpend('phone') >= phoneCap() - 1e-9) return 'cap';
  if (ledger.blocked({ app, verified: true })) return 'cap';
  if (ledger.breaker.state() === 'down' && !(probe && ledger.breaker.probe())) return 'down';
  return null;
}

// ---- one turn: the caller's words in, the reply out as lines as it's written. Stops (the signal) when the line closes
// the request: what was written until then is kept.
export type Line =
  | { text: string }
  | { lang: string }
  | { step: string }
  | { used: string }
  | { end: true; model?: Tally }
  | { unanswered: 'cap' | 'down' | 'error' };
// Timed for Numbers from the caller's words to the turn's end, as the line takes its words (numbers.ts took(); a turn the
// line stopped, or stopped taking, is cut)
type Turn = { rounds: number; out: boolean; outcome: numbers.Outcome };
// the turn's model calls, for the line's log of where a reply's wait went: how many, the prompt's tokens read from the
// cache and written to it, and when its first words came (s from the turn's start)
type Tally = { rounds: number; read: number; written: number; first?: number };
export async function* turn(c: Conv, said: string, l: string, signal: AbortSignal): AsyncGenerator<Line> {
  const t0 = now(),
    seen: Turn = { rounds: 0, out: false, outcome: 'done' };
  let ended = false;
  try {
    yield* turning(c, said, l, signal, seen);
    ended = true;
  } catch (err) {
    seen.outcome = 'failed';
    ended = true;
    throw err;
  } finally {
    const how = signal.aborted || !ended ? 'cut' : seen.outcome;
    if (seen.rounds) numbers.took(about(c), 'phone', 'turn', how, now() - t0);
    if (seen.rounds && how === 'done') numbers.rounds(about(c), 'phone', seen.rounds, seen.out);
  }
}
async function* turning(c: Conv, said: string, l: string, signal: AbortSignal, seen: Turn): AsyncGenerator<Line> {
  if (c.state.lang !== l) {
    c.state.lang = l;
    save(c);
  }
  const why = stopped(about(c), true);
  if (why) return void (yield { unanswered: why === 'off' ? 'cap' : why });
  const messages = heard(c, said);
  if (!messages.length) return void (yield { end: true });
  const ask = { cached: cachedPart(c, l), offered: tools(), messages };
  const spoken: Spoken = { any: false, lang: l, tagged: !tagged() };
  const tally: Tally = { rounds: 0, read: 0, written: 0 };
  for (let n = 0; n < model.TURN_ROUNDS; n++) {
    if (n > 0) {
      const w = stopped(about(c), false);
      if (w) {
        seen.outcome = w === 'down' ? 'failed' : 'cut';
        return void (yield { unanswered: w === 'off' ? 'cap' : w });
      }
    }
    seen.rounds = n + 1;
    const m0 = now();
    const r = yield* answered(c, ask, signal, spoken, tally);
    numbers.took(about(c), 'phone', 'model', r && r !== 'failed' ? 'done' : numbers.outcomeOf(signal), now() - m0);
    if (r === 'failed') {
      seen.outcome = 'failed';
      return void (yield { unanswered: 'error' });
    }
    if (!r) {
      if (!signal.aborted) seen.outcome = 'failed';
      return;
    }
    if (!r.calls.length) break;
    const { results, done } = yield* runTools(c, spoken.lang, r.calls, spoken);
    if (done || signal.aborted) break;
    // (the last round's results reach no model)
    if (n + 1 === model.TURN_ROUNDS) {
      console.log(`care: phone conversation ${c.id}: no answer after ${model.TURN_ROUNDS} model calls`);
      seen.out = true;
      const say = t('phone_rounds_out', l);
      yield { text: `${spoken.any ? ' ' : ''}${say}` };
      store(c, 'ai', say);
      break;
    }
    // the tools that weren't run (after hang_up) need no result: the turn ended with it
    messages.push({ role: 'assistant', content: r.content }, { role: 'user', content: results });
  }
  yield { end: true, model: tally };
}

// A turn's model call, asked once more when its reply had no language tag, or came in another language than the one
// the call is held to (told so). failed: the second try didn't do either.
async function* answered(c: Conv, ask: Ask, signal: AbortSignal, spoken: Spoken, tally: Tally) {
  let r = yield* round(c, spoken.lang, ask, signal, spoken, tally);
  if (r === 'wrong_language')
    r = yield* round(c, spoken.lang, { ...ask, messages: offLanguage(c, ask.messages) }, signal, spoken, tally);
  else if (r === 'untagged') r = yield* round(c, spoken.lang, ask, signal, spoken, tally);
  return r === 'untagged' || r === 'wrong_language' ? ('failed' as const) : r;
}

// what every model call of the call reads from the cache: the instructions, the knowledge, the tools (with the tagging)
const cachedPart = (c: Conv, l: string) => [instructions(c, l), tagging()].filter(Boolean).join('\n\n');

// The call's first turn reads its instructions and knowledge from the model's cache, written now while the opening
// plays (12 s and more), not in the caller's first wait: on a line that's quiet for five minutes, every call's first
// turn would write it. One request, stopped at its first event, once the prompt has been read
export async function warm(c: Conv, l: string) {
  const ctl = new AbortController(),
    timer = setTimeout(() => ctl.abort(), 30_000);
  let usage: model.Usage | null = null;
  try {
    const messages: model.Message[] = [{ role: 'user', content: '(The call has just been picked up.)' }];
    const o = { system: '', cached: cachedPart(c, l), messages, tools: tools(), signal: ctl.signal, warm: true };
    for await (const ev of model.stream({ ...o, model: settings.model }))
      if (ev.type === 'usage') {
        usage = ev.usage;
        break;
      }
  } catch (err: any) {
    if (!model.isAbort(err))
      console.error(`care: phone conversation ${c.id}: the warm-up failed:`, err?.status ?? '', err?.message);
  } finally {
    clearTimeout(timer);
  }
  if (usage)
    ledger.record({
      app: about(c),
      conversation: c.id,
      purpose: 'phone',
      model: settings.model,
      usage,
      estimate: true,
    });
}

// The caller's words in: the code read out of them first, in code; then a health detail, which no model ever reads (the
// chat's rule). Held until they've heard their language's notice (phonecall.ts hold()), and the call's turns for the
// model with what the server checked as a line after the caller's words
function heard(c: Conv, said: string): model.Message[] {
  const read = readCode(c, said.slice(0, TEXT_MAX));
  const health = !!healthTerm(read.text);
  hold(c, health ? '' : read.text, health ? { health: 'removed' } : {}, tagged() ? undefined : settings.langs[0]);
  const messages = history(c);
  const checked: Record<string, string> = {
    right: `[The server checked the code they read out: right. Order ${c.state.phone.granted?.order} is open to this call.]`,
    wrong: `[The server checked the code they read out: wrong. ${read.left} more ${read.left === 1 ? 'try' : 'tries'}.]`,
    spent: "[The server checked the code they read out: it can't be used any more. Offer a new one (send_code).]",
    misheard: "[They read out a number that wasn't six digits: ask them to read the code again, slowly.]",
  };
  const notes = [
    read.result ? checked[read.result] : '',
    health
      ? '[What they said held a health detail, kept from you. You never need one: say so in a line, and ask what they need without it.]'
      : '',
  ].filter(Boolean);
  const last = messages.at(-1);
  if (notes.length && last?.role === 'user') last.content += `\n${notes.join('\n')}`;
  return messages;
}

// a reply tagged in another language than the one the call is held to, asked again with a line after the caller's words
function offLanguage(c: Conv, messages: model.Message[]): model.Message[] {
  const held = c.state.phone.locked!;
  const note = `[Your reply started in another language, but this call is in ${languageName(held)}: answer in ${languageName(held)} ${tagOf(held)}; if a turn made no sense, ask them to say it again. Only if they asked to go on in another language, call switch_language first.]`;
  const after = (x: model.Message['content']) =>
    typeof x === 'string' ? `${x}\n${note}` : [...x, { type: 'text', text: note }];
  return messages.map((m, n) => (n === messages.length - 1 ? { ...m, content: after(m.content) } : m));
}

// a model call's cost in the ledger, and in the turn's tally for the line's log
function charge(c: Conv, tally: Tally, u: model.Usage, estimate = false) {
  tally.rounds++;
  tally.read += u.cacheRead;
  tally.written += u.cacheWrite;
  ledger.record({ app: about(c), conversation: c.id, purpose: 'phone', model: settings.model, usage: u, estimate });
}

// One model call of a turn, streamed out as lines as it's written, and its cost recorded (an estimate when it's cut short).
// What it wrote is kept. null: it stopped (the line went, or the provider failed: its line said so)
type Call = { id: string; name: string; input: any };
type Ask = { cached: string; offered: model.ToolDef[]; messages: model.Message[] };
async function* round(
  c: Conv,
  l: string,
  { cached, offered, messages }: Ask,
  signal: AbortSignal,
  spoken: Spoken,
  tally: Tally,
): AsyncGenerator<Line, { content: model.Block[]; calls: Call[] } | 'untagged' | 'wrong_language' | null> {
  let streamed = 0,
    usage: model.Usage | null = null,
    content: model.Block[] = [];
  const calls: Call[] = [];
  const words = wording(c, spoken);
  const system = facts(c, l);
  try {
    for await (const ev of model.stream({ system, cached, messages, tools: offered, signal, model: settings.model })) {
      if (ev.type === 'text') {
        streamed += ev.text.length;
        yield* words.take(ev.text);
      } else if (ev.type === 'tool') {
        calls.push(ev);
        streamed += JSON.stringify(ev.input ?? {}).length;
        if (ev.name === 'no_transcript') recordObjection(c); // the line confirms it at the step: it holds even if the turn stops there
        yield { step: ev.name };
      } else if (ev.type === 'usage') usage = ev.usage;
      else if (ev.type === 'done') content = ev.content;
    }
    yield* words.end();
  } catch (err: any) {
    const asked = cached.length + system.length + JSON.stringify(messages).length + JSON.stringify(offered).length;
    if (model.isAbort(err) || usage || err instanceof UntaggedError)
      charge(c, tally, ledger.estimate(usage, streamed, asked), true);
    if (err instanceof UntaggedError) {
      const off = err instanceof OffLanguageError; // (in another language than the call's: asked again)
      if (!off) console.error(`care: phone conversation ${c.id}: the reply's first words had no language tag`);
      return off ? 'wrong_language' : 'untagged';
    }
    if (words.written.trim()) store(c, 'ai', words.written.trim(), { ai: true, lang: spoken.lang }); // stopped mid-way: what was said is kept
    if (model.isAbort(err) && signal.aborted) return null;
    const provider = err instanceof model.ProviderError ? err.retryable : model.isAbort(err);
    if (provider) ledger.breaker.failed();
    else console.error(`care: phone conversation ${c.id}: the turn failed:`, err?.status ?? '', err?.message);
    yield { unanswered: provider ? 'down' : 'error' };
    return null;
  }
  charge(c, tally, usage ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  ledger.breaker.ok();
  if (words.written.trim()) store(c, 'ai', words.written.trim(), { ai: true, lang: spoken.lang });
  return { content, calls };
}

// A round's tools, in order: a tool's own fixed words are spoken and kept; one that ends the turn (hang_up) ends the rest
async function* runTools(
  c: Conv,
  l: string,
  calls: Call[],
  spoken: Spoken,
): AsyncGenerator<Line, { results: model.Block[]; done: boolean }> {
  const results: model.Block[] = [];
  for (const x of calls) {
    const r0 = now();
    const r = await run(c, l, x.name, x.input);
    numbers.took(about(c), 'phone', 'tool', 'done', now() - r0);
    if (r.say) {
      yield { text: `${spoken.any ? ' ' : ''}${r.say}` };
      spoken.any = true;
      store(c, 'ai', r.say, { lang: l });
    }
    results.push({ type: 'tool_result', tool_use_id: x.id, content: r.content });
    yield { used: x.name };
    if (r.done) return { results, done: true };
  }
  return { results, done: false };
}
