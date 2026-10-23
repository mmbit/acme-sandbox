// The turn-taker: a customer's burst of messages becomes one reply, drafted while they type (shared/chat/README.md).
// Pure logic, no network: the clock, the model (draft) and the tools are passed in, so the same file runs in the
// conversation server, a demo page and the tests. What it says is the company's: the fallback is a setting.

// The widget sends a typing signal at most once a second while keys are pressed; one that isn't renewed lapses, so a
// pause or a closed tab isn't typing forever.
export const TIMINGS = {
  typingMs: 3000,     // a typing signal lasts this long unless renewed
  quietMs: 700,       // speculative: start drafting this long after a message, even while they type
  settleMs: 1500,     // the customer has stopped: nothing sent for this long and not typing. Only then is a reply said
  maxThrown: 3,       // thrown-away drafts per turn before we stop speculating and wait: a burst can't run up the bill
  retries: 2,         // a draft that fails (overloaded, timed out, offline) is tried again this many times
  retryMs: 1500,      // ... after this long, then the turn gets the fallback rather than silence
  offerMs: 10 * 60_000,   // an offer runs only within this long of being shown: a tap acts on what the customer just saw
};

const realClock = { now: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) };

// One conversation. Options:
//   draft(ctx)  the model: async ({ messages, signal, mode, tool }) => text. mode is 'speculative' (the customer may
//               still be writing) or 'final' (they've stopped). It may call tool(name, input).
//   tools       { name: { kind: 'read' | 'act', run: async (input, { mode }) => result, confirm?: true, label?: input => text } }
//               read tools run in any draft. An act refuses in a speculative draft; in a final one it doesn't run either,
//               it becomes an offer (a Confirm button) or, without `confirm`, runs once the reply is said (a ticket).
//   say(reply)  { text, offers: [{ id, tool, input, label }], saw } once a reply is committed; saw = customer messages it read
//   speculate   draft while they may still be writing (cheap models), or only once they've stopped (expensive ones)
//   onDraft(e)  optional, for the demo: { event: 'start' | 'thrown' | 'parked' | 'held' | 'failed' | 'said', n, saw, mode }
//   fallback    required: what's said when the model keeps failing. The customer is never left waiting in silence, and
//               a person is always within reach (rule 5), so it names the company's own way to one, which must work
//               without the model (a button in the widget, an address)
export function conversation({ draft, tools = {}, say, speculate = true, clock = realClock, timings = {}, onDraft = () => {},
  fallback }) {
  if (!fallback) throw new Error('A conversation needs a fallback: what the customer hears when the model keeps failing');
  const t = { ...TIMINGS, ...timings };
  const messages = [];                         // { from: 'customer' | 'assistant' | 'tool', text?, tool?, input?, result? }
  const offers = new Map();                    // id → { tool, input, at }: acts waiting for the customer's tap
  let lastMessage = 0, typingUntil = 0, timer = null, current = null, held = null, thrown = 0, drafts = 0, offerIds = 0;
  let actTurn = false;                         // a draft this turn wanted to act: only a final draft may now follow
  let failed = 0, retryAt = 0;                 // drafts this turn that failed, and when to try again

  const customerCount = () => messages.filter(m => m.from === 'customer').length;
  const stoppedAt = () => Math.max(lastMessage + t.settleMs, typingUntil);
  const wake = (ms) => { clock.clear(timer); timer = clock.set(step, Math.max(0, ms)); };
  const heardSinceReply = () => messages.slice(messages.findLastIndex(m => m.from === 'assistant') + 1).some(m => m.from === 'customer');
  const event = (name, d) => onDraft({ event: name, n: d.n, saw: d.saw, mode: d.mode });

  // Throw the draft away: it hasn't seen what just arrived. A model that ignores the signal still can't be said:
  // the draft's result is only taken while it's still the current one.
  function abandon() {
    if (current) { current.ctl.abort(); thrown++; event('thrown', current); current = null; }
    if (held) { thrown++; event('thrown', held); held = null; }
  }

  // The one place that decides what happens next, run on every message, typing signal, finished draft and timer.
  function step() {
    const now = clock.now(), unanswered = messages.length && messages.at(-1).from !== 'assistant';
    if (!unanswered) return;
    if (held) {
      if (now < stoppedAt()) return wake(stoppedAt() - now);
      return commit(held).catch(err => console.error('chat: a reply could not be committed:', err.message));
    }
    if (current) return;
    if (now < retryAt) return wake(retryAt - now);
    if (now >= stoppedAt()) return start('final');
    // Speculating is only worth it until a turn has thrown away maxThrown drafts, or once it's clear this turn acts:
    // then wait for the customer to stop.
    if (!speculate || thrown >= t.maxThrown || actTurn) return wake(stoppedAt() - now);
    if (now < lastMessage + t.quietMs) return wake(lastMessage + t.quietMs - now);
    start('speculative');
  }

  function start(mode) {
    const ctl = new AbortController(), d = { ctl, n: ++drafts, saw: customerCount(), mode, wishes: [] };
    // Drafts may only read: nothing that moves money or changes an order happens on a guess about what the customer
    // meant. The tool layer on the server should check the same mode again.
    const tool = async (name, input) => {
      const spec = tools[name];
      if (!spec) return { ok: false, reason: `no tool called ${name}` };
      if (ctl.signal.aborted) return { ok: false, reason: 'this draft was thrown away' };
      if (spec.kind === 'read') return spec.run(input, { mode });
      if (mode === 'speculative') {
        // It can't be said without the act, so stop paying for it now; a final draft follows once the customer has
        // stopped (an act turn costs one extra call, and most turns don't act).
        if (current === d) { ctl.abort(); current = null; actTurn = true; event('parked', d); step(); }
        return { ok: false, reason: 'speculative' };
      }
      d.wishes.push({ tool: name, input });
      return { ok: true, pending: spec.confirm ? 'shown to the customer with a Confirm button under this reply' : 'runs once this reply is sent' };
    };
    current = d;
    event('start', d);
    draft({ messages: messages.slice(), signal: ctl.signal, mode, tool })
      .then(text => { if (current === d) finish(d, text); })
      .catch(err => {
        if (ctl.signal.aborted || current !== d) return;   // thrown away on purpose
        console.error('chat: a draft failed:', err.message);
        current = null;
        event('failed', d);
        if (++failed > t.retries) return giveUp(d);
        retryAt = clock.now() + t.retryMs;
        step();
      });
  }

  // The fallback is said like any reply: once the customer has stopped, and thrown away if they write again.
  function giveUp(d) {
    retryAt = 0;
    finish({ ...d, wishes: [] }, fallback);
  }

  function finish(d, text) {
    current = null; held = { ...d, text };
    event('held', d);
    step();
  }

  async function commit(d) {
    held = null; thrown = 0; actTurn = false; failed = 0; retryAt = 0;
    messages.push({ from: 'assistant', text: d.text });
    // The conversation has moved on: offers under an earlier reply can't be tapped any more. The model offers again
    // if the customer still wants it.
    offers.clear();
    const shown = [];
    for (const w of d.wishes.filter(w => tools[w.tool].confirm)) {
      const id = `o${++offerIds}`;
      offers.set(id, { ...w, at: clock.now() });
      shown.push({ id, tool: w.tool, input: w.input, label: tools[w.tool].label?.(w.input) ?? w.tool });
    }
    event('said', d);
    say({ text: d.text, offers: shown, saw: d.saw });
    // acts that need no tap (open a ticket) run now that the reply is said, and their outcome starts a short turn
    for (const w of d.wishes.filter(w => !tools[w.tool].confirm)) await act(w);
  }

  async function act(w) {
    // A tool that throws (the coordinator is down) is an outcome like any other: the chat says it couldn't be done.
    const result = await Promise.resolve()
      .then(() => tools[w.tool].run(w.input, { mode: 'final' }))
      .catch(err => ({ ok: false, reason: `the tool failed: ${err.message}` }));
    outcome([{ tool: w.tool, input: w.input, result }]);
    return result;
  }

  // An outcome starts a short turn of its own. With nothing from the customer since the last reply there's nothing to
  // wait for; if they've written since, their burst still settles first, so it gets one reply, not two.
  function outcome(results) {
    for (const r of results) messages.push({ from: 'tool', ...r });
    if (!heardSinceReply()) lastMessage = -Infinity;
    abandon();                 // a draft under way hasn't seen the outcome
    step();
  }

  return {
    messages,
    // A message is sent the moment the customer presses send; the input stays open.
    hear(text) {
      messages.push({ from: 'customer', text });
      lastMessage = clock.now(); typingUntil = 0;
      abandon();
      step();
    },
    // A keystroke (the widget throttles these to about one a second).
    typing() {
      typingUntil = clock.now() + t.typingMs;
      step();
    },
    // The customer's tap on an offer: only now does the act run, and only once. Choosing one offer answers the others
    // under the same reply (a replacement or a refund, never both).
    async confirm(id) {
      const w = offers.get(id);
      if (!w) return { ok: false, reason: 'that offer was already answered' };
      offers.clear();
      // A late tap isn't met with silence: the expiry is an outcome, so the chat says so and offers it again.
      if (clock.now() - w.at > t.offerMs) {
        const result = { ok: false, reason: 'expired' };
        outcome([{ tool: w.tool, input: w.input, result }]);
        return result;
      }
      return { ok: true, result: await act(w) };
    },
    // "Neither, thanks": every offer under that reply is answered with a no, and the chat says it's left as it is.
    decline(id) {
      if (!offers.has(id)) return;
      const all = [...offers.values()];
      offers.clear();
      outcome(all.map(w => ({ tool: w.tool, input: w.input, result: { ok: false, reason: 'the customer said no' } })));
    },
  };
}
