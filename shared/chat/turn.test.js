// node --test shared/chat/turn.test.js   (a fake clock and a fake model: no network, no keys)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversation as start } from './turn.js';

// The company's own words when the model keeps failing, with its way to a person.
const FALLBACK = 'Sorry, I can\'t answer right now. Try again in a moment, or tap "A person".';
const conversation = opts => start({ fallback: FALLBACK, ...opts });

const flush = () => new Promise(r => setImmediate(r));

// A clock the test moves by hand; timers fire in order, and the promises they settle run before the next one.
function fakeClock() {
  let now = 0, ids = 0;
  const timers = new Map();
  return {
    now: () => now,
    set(fn, ms) { timers.set(++ids, { at: now + ms, fn }); return ids; },
    clear(id) { timers.delete(id); },
    async to(at) {
      for (;;) {
        const [id, next] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
        if (!next || next.at > at) break;
        timers.delete(id); now = next.at; next.fn(); await flush();
      }
      now = at; await flush();
    },
  };
}

// A model that takes `ms` to write a reply naming every customer message it read. `script` lets a test have it call tools.
function fakeModel(clock, ms, { obeysAbort = true, script = async () => {} } = {}) {
  const runs = [];
  const draft = async ({ messages, signal, mode, tool }) => {
    const read = messages.filter(m => m.from === 'customer').map(m => m.text);
    const run = { read, mode, aborted: false };
    runs.push(run);
    signal.addEventListener('abort', () => { run.aborted = true; });
    await script(tool, messages);
    await new Promise((resolve, reject) => {
      const id = clock.set(resolve, ms);
      if (obeysAbort) signal.addEventListener('abort', () => { clock.clear(id); reject(new Error('aborted')); });
    });
    return `reply to: ${read.join(' / ')}`;
  };
  return { draft, runs };
}

// The customer's side: typing signals once a second while writing, then send, like the widget does.
async function write(clock, chat, text, at, ms) {
  for (let t = at; t < at + ms; t += 1000) { await clock.to(t); chat.typing(); }
  await clock.to(at + ms); chat.hear(text);
}

test('a burst of three messages gets one reply, and it read all three', async () => {
  const clock = fakeClock(), said = [];
  const model = fakeModel(clock, 2500);
  const chat = conversation({ draft: model.draft, say: r => said.push(r), clock });
  await write(clock, chat, 'hi', 0, 800);
  await write(clock, chat, 'my parcel never arrived', 1200, 3000);
  await write(clock, chat, 'order MB-1042', 4600, 2000);
  await clock.to(20_000);
  assert.equal(said.length, 1);
  assert.equal(said[0].text, 'reply to: hi / my parcel never arrived / order MB-1042');
  assert.ok(model.runs.length > 1, 'it drafted ahead while the customer was still writing');
});

test('a message that arrives mid-draft throws the draft away, even from a model that ignores the abort', async () => {
  const clock = fakeClock(), said = [];
  const model = fakeModel(clock, 2000, { obeysAbort: false });
  const chat = conversation({ draft: model.draft, say: r => said.push(r), clock });
  chat.hear('hi');
  await clock.to(1500);
  assert.equal(model.runs.length, 1, 'a draft started after a short quiet gap');
  chat.hear('where is my order?');
  assert.equal(model.runs[0].aborted, true);
  await clock.to(20_000);
  assert.deepEqual(said.map(r => r.text), ['reply to: hi / where is my order?']);
});

test('a finished draft waits while the customer is typing, and is said once they stop', async () => {
  const clock = fakeClock(), said = [];
  const model = fakeModel(clock, 500);
  const chat = conversation({ draft: model.draft, say: r => said.push(r), clock });
  chat.hear('hi');
  for (let t = 1000; t <= 6000; t += 1000) { await clock.to(t); chat.typing(); }
  assert.equal(said.length, 0, 'nothing is said over someone who is still typing');
  await clock.to(9000);   // they stopped (the last signal lapsed at 9000) without sending
  assert.deepEqual(said.map(r => r.text), ['reply to: hi']);
});

test('in patient mode no draft starts while the customer is typing', async () => {
  const clock = fakeClock(), said = [];
  const model = fakeModel(clock, 500);
  const chat = conversation({ draft: model.draft, say: r => said.push(r), clock, speculate: false });
  await write(clock, chat, 'hi', 0, 500);
  await write(clock, chat, 'the app crashes when I open it', 1000, 4000);
  await clock.to(20_000);
  assert.equal(model.runs.length, 1);
  assert.deepEqual(said.map(r => r.saw), [2]);
});

test('a refund is never run by a draft: speculative drafts are refused, a final one offers it, the tap runs it once', async () => {
  const clock = fakeClock(), said = [], answers = [];
  let lookups = 0, refunds = 0;
  const tools = {
    order: { kind: 'read', run: async () => { lookups++; return { ok: true, order: 'MB-1042', paid: 2400, status: 'delivered' }; } },
    refund: { kind: 'act', confirm: true, run: async () => { refunds++; return { ok: true }; }, label: i => `Refund ${i.order}` },
  };
  const script = async (tool) => { await tool('order', { order: 'MB-1042' }); answers.push(await tool('refund', { order: 'MB-1042' })); };
  const model = fakeModel(clock, 2000, { script });
  const chat = conversation({ draft: model.draft, tools, say: r => said.push(r), clock });
  chat.hear('MB-1042 arrived broken');
  await clock.to(1200);
  chat.hear('can I have my money back?');
  await clock.to(20_000);
  assert.deepEqual(model.runs.map(r => r.mode), ['speculative', 'final'], 'once a draft wants to act, the turn waits for a final one');
  assert.equal(lookups, 2, 'every draft may read');
  assert.deepEqual(answers.map(a => a.reason ?? 'pending'), ['speculative', 'pending']);
  assert.equal(refunds, 0, 'not even the final draft refunded anything');
  assert.equal(said.length, 1);
  assert.deepEqual(said[0].offers.map(o => o.label), ['Refund MB-1042']);
  await chat.confirm(said[0].offers[0].id);
  assert.equal(refunds, 1);
  assert.equal((await chat.confirm(said[0].offers[0].id)).ok, false, 'a second tap does nothing');
  assert.equal(refunds, 1);
});

test('an outcome that lands mid-burst waits for the burst to settle: one reply, and it read everything', async () => {
  const clock = fakeClock(), said = [];
  let settle;
  const tools = {
    refund: { kind: 'act', confirm: true, run: () => new Promise(r => { settle = r; }), label: () => 'Refund' },
  };
  const script = async (tool, messages) => { if (messages.at(-1).text === 'refund please') await tool('refund', {}); };
  const model = fakeModel(clock, 500, { script });
  const chat = conversation({ draft: model.draft, tools, say: r => said.push(r), clock, speculate: false });
  chat.hear('refund please');
  await clock.to(1500);
  assert.equal(said.length, 0);
  await clock.to(2000);
  assert.equal(said.length, 1, 'the offer is shown');
  const tap = chat.confirm(said[0].offers[0].id);
  await clock.to(2500); chat.hear('also');
  await clock.to(2600); settle({ ok: true }); await tap;
  await clock.to(3500); chat.hear('the box was torn too');
  await clock.to(20_000);
  assert.equal(said.length, 2, 'the refund and the burst get one reply between them');
  assert.equal(said[1].saw, 3);
});

test('choosing one offer answers the others, a new reply retires old offers, and an offer lapses after 10 minutes', async () => {
  const clock = fakeClock(), said = [], ran = [];
  const tools = {
    resend: { kind: 'act', confirm: true, run: async () => { ran.push('resend'); return { ok: true }; } },
    refund: { kind: 'act', confirm: true, run: async () => { ran.push('refund'); return { ok: true }; } },
  };
  const script = async (tool, messages) => {
    if (messages.at(-1).from === 'customer' && messages.at(-1).text !== 'thanks') { await tool('resend', {}); await tool('refund', {}); }
  };
  const model = fakeModel(clock, 500, { script });
  const chat = conversation({ draft: model.draft, tools, say: r => said.push(r), clock });
  chat.hear('my parcel is lost');
  await clock.to(5000);
  const [resend, refund] = said[0].offers;
  assert.equal((await chat.confirm(resend.id)).ok, true);
  assert.equal((await chat.confirm(refund.id)).ok, false, 'a replacement or a refund, never both');
  await clock.to(10_000);
  chat.hear('my other parcel is lost too');
  await clock.to(15_000);
  const next = said.at(-1).offers;
  chat.hear('thanks');
  await clock.to(20_000);
  assert.equal((await chat.confirm(next[1].id)).ok, false, 'the conversation moved on');
  chat.hear('and a third one');
  await clock.to(25_000);
  await clock.to(25_000 + 10 * 60_000 + 1);
  assert.equal((await chat.confirm(said.at(-1).offers[0].id)).ok, false, 'lapsed after 10 minutes');
  assert.deepEqual(ran, ['resend']);
});

test('a model that keeps failing is tried again, then the customer hears the fallback rather than silence', async () => {
  const clock = fakeClock(), said = [];
  let calls = 0;
  const draft = async () => { calls++; throw new Error('overloaded'); };
  const chat = conversation({ draft, say: r => said.push(r), clock, speculate: false });
  chat.hear('hello?');
  await clock.to(20_000);
  assert.equal(calls, 3, 'the first try and two retries');
  assert.equal(said.length, 1);
  assert.equal(said[0].text, FALLBACK);
});

test('a conversation without a fallback is refused, so no company ships one that can fall silent', () => {
  assert.throws(() => start({ draft: async () => 'hi', say: () => {} }), /needs a fallback/);
});

test('a ticket tool that throws becomes an outcome the chat can tell the customer about', async () => {
  const clock = fakeClock(), said = [], unhandled = [];
  const onUnhandled = err => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  const tools = { ticket: { kind: 'act', run: async () => { throw new Error('coordinator down'); } } };
  const draft = async ({ messages, tool }) => {
    const last = messages.at(-1);
    if (last.from === 'tool') return `ticket: ${last.result.ok ? 'opened' : 'not opened'}`;
    await tool('ticket', {});
    return 'I am passing this on to our team.';
  };
  const chat = conversation({ draft, tools, say: r => said.push(r), clock });
  chat.hear('the app crashes');
  await clock.to(20_000);
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
  assert.deepEqual(said.map(r => r.text), ['I am passing this on to our team.', 'ticket: not opened']);
});

test('a tap on an offer older than 10 minutes gets a reply that offers it again, and runs nothing', async () => {
  const clock = fakeClock(), said = [], ran = [];
  const tools = { refund: { kind: 'act', confirm: true, run: async () => { ran.push('refund'); return { ok: true }; } } };
  const script = async (tool, messages) => {
    const last = messages.at(-1);
    if (last.from === 'customer' || last.result?.reason === 'expired') await tool('refund', {});
  };
  const model = fakeModel(clock, 500, { script });
  const chat = conversation({ draft: model.draft, tools, say: r => said.push(r), clock });
  chat.hear('my parcel is lost');
  await clock.to(5000);
  const late = said[0].offers[0];
  await clock.to(5000 + 10 * 60_000 + 1);
  assert.deepEqual(await chat.confirm(late.id), { ok: false, reason: 'expired' });
  await flush();   // the new turn's draft sets its timer before the clock moves on
  await clock.to(5000 + 11 * 60_000);
  assert.equal(said.length, 2, 'the late tap got a reply');
  assert.equal(said[1].offers.length, 1, 'and the offer was made again');
  assert.equal((await chat.confirm(said[1].offers[0].id)).ok, true);
  assert.deepEqual(ran, ['refund']);
});
