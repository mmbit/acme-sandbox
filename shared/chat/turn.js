// The turn-taker: a customer's burst of messages becomes one reply, drafted while they type (README.md).

// The widget sends a typing signal at most once a second while keys are pressed; one that isn't renewed lapses, so a
// pause or a closed tab isn't typing forever.
export const TIMINGS = {
  typingMs: 3000, // a typing signal lasts this long unless renewed
  quietMs: 700, // speculative: start drafting this long after a message, even while they type
  settleMs: 1500, // the customer has stopped: nothing sent for this long and not typing. Only then is a reply said
  maxThrown: 3, // thrown-away drafts per turn before we stop speculating and wait: a burst can't run up the bill
  retries: 2, // a draft that fails (overloaded, timed out, offline) is tried again this many times
  retryMs: 1500, // ... after this long, then the turn gets the fallback rather than silence
  offerMs: 10 * 60_000, // an offer runs only within this long of being shown: a tap acts on what the customer just saw
};

const realClock = { now: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) };

// One conversation, its options as README.md ("Using it") lists them. The fallback names the company's own way to a
// person that works without the model, so the customer is never left in silence (rule 5).
export function conversation({
  draft,
  tools = {},
  say,
  speculate = true,
  clock = realClock,
  timings = {},
  onDraft = () => {},
  fallback,
}) {
  if (!fallback)
    throw new Error('A conversation needs a fallback: what the customer hears when the model keeps failing');
  const chat = {
    ...{ draft, tools, say, speculate, clock, fallback },
    timings: { ...TIMINGS, ...timings },
    event: (name, d) => onDraft({ event: name, n: d.n, saw: d.saw, mode: d.mode }),
    messages: [], // { from: 'customer' | 'assistant' | 'tool', text?, tool?, input?, result? }
    offers: new Map(), // id → { tool, input, at }: acts waiting for the customer's tap
    ...{ lastMessage: 0, typingUntil: 0, timer: null, current: null, drafts: 0, offerIds: 0 },
    ...newTurn(),
  };
  return {
    messages: chat.messages,
    hear: text => hear(chat, text),
    typing: () => typing(chat),
    confirm: id => confirm(chat, id),
    decline: id => decline(chat, id),
  };
}

// actTurn: a draft this turn wanted to act, so only a final draft may follow. failed: drafts this turn that failed,
// retryAt: when to try again.
const newTurn = () => ({ held: null, thrown: 0, actTurn: false, failed: 0, retryAt: 0 });

// A message is sent the moment the customer presses send; the input stays open.
function hear(chat, text) {
  chat.messages.push({ from: 'customer', text });
  chat.lastMessage = chat.clock.now();
  chat.typingUntil = 0;
  abandon(chat);
  step(chat);
}

// A keystroke (the widget throttles these to about one a second).
function typing(chat) {
  chat.typingUntil = chat.clock.now() + chat.timings.typingMs;
  step(chat);
}

// The customer's tap on an offer: only now does the act run, and only once. Choosing one offer answers the others
// under the same reply (a replacement or a refund, never both).
async function confirm(chat, id) {
  const w = chat.offers.get(id);
  if (!w) return { ok: false, reason: 'that offer was already answered' };
  chat.offers.clear();
  // A late tap isn't met with silence: the expiry is an outcome, so the chat says so and offers it again.
  if (chat.clock.now() - w.at > chat.timings.offerMs) {
    const result = { ok: false, reason: 'expired' };
    outcome(chat, [answer(w, result)]);
    return result;
  }
  return { ok: true, result: await act(chat, w) };
}

// "Neither, thanks": every offer under that reply is answered with a no, and the chat says it's left as it is.
function decline(chat, id) {
  if (!chat.offers.has(id)) return;
  const answers = [...chat.offers.values()].map(w => answer(w, { ok: false, reason: 'the customer said no' }));
  chat.offers.clear();
  outcome(chat, answers);
}

// Throw the draft away: it hasn't seen what just arrived. A model that ignores the signal still can't be said:
// the draft's result is only taken while it's still the current one.
function abandon(chat) {
  chat.current?.ctl.abort();
  for (const d of [chat.current, chat.held].filter(Boolean)) {
    chat.thrown++;
    chat.event('thrown', d);
  }
  chat.current = chat.held = null;
}

// The one place that decides what happens next, run on every message, typing signal, finished draft and timer.
function step(chat) {
  const now = chat.clock.now();
  const { messages, timings } = chat;
  if (!messages.length || messages.at(-1).from === 'assistant') return;
  const stoppedAt = Math.max(chat.lastMessage + timings.settleMs, chat.typingUntil);
  if (chat.held) {
    if (now < stoppedAt) return wake(chat, stoppedAt - now);
    return commit(chat, chat.held).catch(err => console.error('chat: a reply could not be committed:', err.message));
  }
  if (chat.current) return;
  if (now < chat.retryAt) return wake(chat, chat.retryAt - now);
  if (now >= stoppedAt) return start(chat, 'final');
  // Speculating is only worth it until a turn has thrown away maxThrown drafts, or once it's clear this turn acts:
  // then wait for the customer to stop.
  if (!chat.speculate || chat.thrown >= timings.maxThrown || chat.actTurn) return wake(chat, stoppedAt - now);
  if (now < chat.lastMessage + timings.quietMs) return wake(chat, chat.lastMessage + timings.quietMs - now);
  start(chat, 'speculative');
}

function wake(chat, ms) {
  chat.clock.clear(chat.timer);
  chat.timer = chat.clock.set(() => step(chat), Math.max(0, ms));
}

function start(chat, mode) {
  const ctl = new AbortController();
  const saw = chat.messages.filter(m => m.from === 'customer').length;
  const d = { ctl, n: ++chat.drafts, saw, mode, wishes: [] };
  chat.current = d;
  chat.event('start', d);
  const tool = (name, input) => runTool(chat, d, name, input);
  chat
    .draft({ messages: chat.messages.slice(), signal: ctl.signal, mode, tool })
    .then(text => chat.current === d && finish(chat, d, text))
    .catch(err => {
      if (ctl.signal.aborted || chat.current !== d) return; // thrown away on purpose
      console.error('chat: a draft failed:', err.message);
      chat.current = null;
      chat.event('failed', d);
      // The fallback is said like any reply: once the customer has stopped, and thrown away if they write again.
      if (++chat.failed > chat.timings.retries) return finish(chat, { ...d, wishes: [] }, chat.fallback);
      chat.retryAt = chat.clock.now() + chat.timings.retryMs;
      step(chat);
    });
}

// A draft's tool call. Drafts may only read: nothing that moves money or changes an order happens on a guess about
// what the customer meant. The tool layer on the server should check the same mode again.
async function runTool(chat, d, name, input) {
  const spec = chat.tools[name];
  if (!spec) return { ok: false, reason: `no tool called ${name}` };
  if (d.ctl.signal.aborted) return { ok: false, reason: 'this draft was thrown away' };
  if (spec.kind === 'read') return spec.run(input, { mode: d.mode });
  if (d.mode === 'speculative') {
    // It can't be said without the act, so stop paying for it now; a final draft follows once the customer has
    // stopped (an act turn costs one extra call, and most turns don't act).
    if (chat.current === d) {
      d.ctl.abort();
      chat.current = null;
      chat.actTurn = true;
      chat.event('parked', d);
      step(chat);
    }
    return { ok: false, reason: 'speculative' };
  }
  d.wishes.push({ tool: name, input });
  const pending = spec.confirm
    ? 'shown to the customer with a Confirm button under this reply'
    : 'runs once this reply is sent';
  return { ok: true, pending };
}

function finish(chat, d, text) {
  chat.current = null;
  chat.held = { ...d, text };
  chat.event('held', d);
  step(chat);
}

async function commit(chat, d) {
  Object.assign(chat, newTurn());
  chat.messages.push({ from: 'assistant', text: d.text });
  // The conversation has moved on: offers under an earlier reply can't be tapped any more. The model offers again
  // if the customer still wants it.
  chat.offers.clear();
  const shown = [];
  for (const w of d.wishes.filter(w => chat.tools[w.tool].confirm)) {
    const id = `o${++chat.offerIds}`;
    chat.offers.set(id, { ...w, at: chat.clock.now() });
    shown.push({ id, tool: w.tool, input: w.input, label: chat.tools[w.tool].label?.(w.input) ?? w.tool });
  }
  chat.event('said', d);
  chat.say({ text: d.text, offers: shown, saw: d.saw });
  // acts that need no tap (open a ticket) run now that the reply is said, and their outcome starts a short turn
  for (const w of d.wishes.filter(w => !chat.tools[w.tool].confirm)) await act(chat, w);
}

async function act(chat, w) {
  // A tool that throws (the coordinator is down) is an outcome like any other: the chat says it couldn't be done.
  const result = await Promise.resolve()
    .then(() => chat.tools[w.tool].run(w.input, { mode: 'final' }))
    .catch(err => ({ ok: false, reason: `the tool failed: ${err.message}` }));
  outcome(chat, [answer(w, result)]);
  return result;
}

// An outcome starts a short turn of its own. With nothing from the customer since the last reply there's nothing to
// wait for; if they've written since, their burst still settles first, so it gets one reply, not two.
function outcome(chat, answers) {
  const { messages } = chat;
  for (const a of answers) messages.push({ from: 'tool', ...a });
  const sinceReply = messages.slice(messages.findLastIndex(m => m.from === 'assistant') + 1);
  if (!sinceReply.some(m => m.from === 'customer')) chat.lastMessage = -Infinity;
  abandon(chat); // a draft under way hasn't seen the outcome
  step(chat);
}

const answer = (w, result) => ({ tool: w.tool, input: w.input, result });
