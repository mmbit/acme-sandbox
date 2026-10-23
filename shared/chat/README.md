# shared/chat: the turn-taker for a customer chat

A customer writes in bursts. The turn-taker makes each burst one reply, drafted while they may still be typing, and
the input never locks. Pure logic, no network: the clock, the model and the tools are passed in, so the same file runs
in a product's conversation server, a demo page and the tests. A product copies it in.
What it says is the company's own: the `fallback` setting.


| File | What it is |
|---|---|
| `turn.js` | The turn-taker. Drafts start while the customer may still be writing, are thrown away when a new message arrives, and only read. |
| `turn.test.js` | Its behaviour: `node --test shared/chat/turn.test.js` |

## Using it

```js
import { conversation } from './turn.js';
const chat = conversation({ draft, tools, say, fallback, speculate: true });
chat.hear(text);      // a message, the moment it's sent
chat.typing();        // a keystroke (throttled to about one a second)
chat.confirm(id);     // the customer's tap on an offer: only now does an act run
chat.decline(id);     // "Neither, thanks": every offer under that reply is answered with a no
```

- `draft({ messages, signal, mode, tool })` calls the model and returns the reply text. `mode` is `speculative` or
  `final`, and goes to the tool layer with every tool call.
- `tools` are `{ kind: 'read' | 'act', run, confirm?, label? }`. A read runs in any draft. An act refuses in a
  speculative draft (`{ ok: false, reason: 'speculative' }`) and the turn then waits for a final draft; in a final
  draft it becomes an offer with a Confirm button (`confirm: true`) or runs once the reply is said (a ticket).
- An offer runs once, within 10 minutes. Confirming one answers the others under the same reply, and a new reply
  retires them all: the model offers again if the customer still wants it. A tap after 10 minutes runs nothing and is
  an outcome `{ ok: false, reason: 'expired' }`, so the chat says so and can offer it again.
- An outcome (a tap, a ticket) starts a short turn. If the customer has written since the last reply, it waits for
  their burst to settle like any turn, so the burst still gets one reply.
- A tool that throws is an outcome `{ ok: false, reason }`. A draft that fails is tried twice more, then the
  customer hears the `fallback`, said like any reply.
- `fallback` is required: the company's own words for when the model can't be reached. It names the company's way to
  a person (rule 5), one that works without the model, such as a button in the widget.
- `say({ text, offers, saw })` is called once per turn.
- `speculate: false` for an expensive model: no draft starts until the customer has stopped.
- `timings` overrides any of `TIMINGS` (how long typing lasts, when to draft, when the customer has stopped, the
  retries, an offer's lifetime); `onDraft(e)` reports each draft's life, for a demo.
