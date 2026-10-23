# The care service's contracts: the widget's API and the line to HQ

The two contracts the engine speaks besides the order endpoint (that one is in `../README.md`, "The order endpoint each
app adds"): the widget ↔ the service, on the app's own host, and the service → HQ's Care app. Both are the engine's,
the same for every company. The code is the final word; this is the map.

## The widget's API (same origin, `/__care/*`)

The widget is `<script type="module" src="./__care/widget.js"></script>` on the app's page (relative: on a shelf it is
`/<slug>/__care/`). Caddy sends `/__care/*` on
every host of an app with `care: true` to the service and **sets** `X-Care-App` (`<slug>`, or `<slug>@preview` on the
preview host), dropping any copy the client sent; the service trusts nothing else for the app and refuses a request
without it. It sets `X-Care-Shop` the same way: the shop whose session the request is in (the app itself on a host of its
own; on a shop's shelves, the shop, whose stalls share the cookie and the chat: README.md, "One chat for a shop"), and the
service refuses an app that isn't a stall of it. On a preview host the route is behind the board's preview login; on a public app's live host it's open.

**Transport**: JSON `POST`s to `/__care/api/<what>`, and one `EventSource` on `GET /__care/api/stream` carrying the
server's messages, one JSON object per event, with a `: ping` every 25 s. The full list of messages each way, with
their fields, is the header comment of `public/widget.js`. A `reply` the model wrote, and each such item in `hello`
and `earlier`, carries `aiGenerated: true`, and a template's doesn't; an email card whose note the model wrote carries
`noteAiGenerated: true` on its widget (README.md, "The AI mark").

| Route | What |
|---|---|
| `POST hello { lang }` | the only call that makes a session (30 new sessions an hour per address); answers the conversation so far, from the server (nothing is kept in the browser's storage), the check level, online and busy, the conversation's language (the page's `lang` from then on: a greeting with nothing said to it yet is said again in it), the app's name and its slug (`stall`), and what the delete step offers (`may`: `delete` where this device may delete the server's copy, `kept` where forgetting it here leaves that copy) |
| `GET stream` | the server's messages: `status`, `typing`, `line`, `reply`, `close`, `note`, `wait`, `earlier`, `toast`, `renew`, `level`, `forget`, and `drop`/`redact` for the health check |
| `POST say { id, text, answer? }` | a message, or a tap (`answer` names a widget and an action id: the server stored what it does, and renders every label) |
| `POST typing { on }` | only on a change |
| `POST code { code, widget, id }` | the code box, checked without the model |
| `POST link { token }` | a signed link from the service's emails (the URL fragment `#<link>=<token>`, cleared from the address bar) |
| `POST copy`, `forget`, `delete`, `renew` | email a copy (to a code-checked address only); forget this chat on this device; delete the conversation; take a new session id after a grant rose |
| `POST diagnostics { id, widget, action, bundle }` | the bug report (below) |
| `POST photo?shot=&widget=&id=` | a claim's photo as `image/jpeg` (3 MB at most), when a plug-in's tool asked for photos. Room for its body is taken before it's read (12 MB service-wide by `Content-Length`, 3 MB without one, 2 at once per address; past it `503`, unread), held until its decode ends, and a body still coming after a minute gets `408` <!-- --> |
| `POST tools` | the conversation's tool calls, for an eval: only on a local run or a preview app (else 404) |
| `GET health` | `{ ok, model: 'up' \| 'down' \| 'cap' }` |

**Rules on every POST**: a JSON body (16 KB at most; the bug report 256 KB, read only for a live session), an `Origin`
equal to the host (else 403), and the `x-care-tab` header, a random id the page keeps in memory: a grant a tool raised
is held for the page that typed the proof, so someone else holding the cookie can't take it. A POST whose cookie names
no live session gets `401 { retry: true }`, never a new session. What a conversation may store is bounded per hour
(`say` 120, `code` 20, `link` 10; past it, `429`). No GET changes anything.

**The cookie**: `CARE_COOKIE` (always `__Host-`, default `__Host-care`), `Secure; HttpOnly; SameSite=Lax; Path=/`, 30
days sliding; the database keeps only its hash. Caddy strips it from every request that goes to a product, like the
board's preview key.

**Widgets** come from the server as data and `public/catalogue.js` draws them, text only. Every button is
`{ action, label, primary?, ask? }`: the label is the server's, the action an id in the action store.

### The bug report

The helper's `offer_snapshot` tool puts a consent card on screen, once per conversation, with three buttons of equal
weight: "See what we'd send", "Send it", "No thanks". Nothing leaves the device before "Send it".

- **The log**: `public/telemetry.js` (`/__care/telemetry.js`), a ring buffer of 100 events in the page's memory only:
  errors, unhandled rejections, failed requests (method, path pattern, status; never headers or bodies), page views,
  and the app's own `track(name, data)` steps. `track` keeps only the shared keys (`step`, `ok`, `n`, `count`, `ms`,
  `kind`, `status`, `code`, `variant`, `size`, `format`, `lang`, `source`, `action`, `screen`) as numbers, booleans or
  short words. Redacted before it enters the buffer: query strings and fragments, id-like path segments, email
  addresses, runs of 6 or more digits; each text cut to 200 characters. Only the last ten minutes go.
- **The picture**: `public/snapshot.js` draws the visible page from the page itself (no screen share, nothing
  fetched). Form fields are hatched boxes, never their value; the chat and anything marked `data-no-snapshot` are left
  out.
- **The route** refuses a bundle unless the tap was a live "Send it" on this conversation's consent card (403), checks
  the schema exactly (400), takes one Send (409), and redacts every string again on the server. It files a `bug` case
  for HQ with the bundle; the report carries no reply address and no orders.
- **Kept** until HQ marks the bug fixed, 90 days at most; "Delete this conversation" takes it too.

## The line to HQ (service → HQ's Care app)

The service calls HQ's public host with `Authorization: Bearer <CARE_HQ_TOKEN>` (products.py gives both ends the
token); HQ can't reach the service. A call that fails is made again in the next run. HQ away (no answer, or a 5xx: its
gateway's 502, 503 or 504, or its own 500, which HQ logs itself) is what a
deploy looks like, so a step that fails that way is logged only once it has failed for 10 minutes running. Every
minute, and at once when a case is filed:

- `POST /api/care/cards` `{ kind, app, case, check, to, lang, words, summary, facts, chat, draft, translation?,
  bundle?, health? }` → `{ ok, id }`: a case as a card. `kind` is `person` (an email to a person), `question` (one the
  knowledge base couldn't answer, with its summary in general words), `rights` (a data request: the customer's own
  words, its receipt in `facts`, no chat and no draft), `bug`, or another HQ takes (a plug-in's `claim`).
  The same case again is the same card: a data request that went without `to` takes it then.
  `chat` is the conversation the email card promised (person cases only). `draft` is the reply for the board to edit
  and send, in the customer's language, with a `translation` into the board's language when it's another; `summary`
  is in the board's language too (state's `board`). **`health: true`**: a health detail went to a
  person with this case, so no model drafts it, ever, and HQ never sends it or its chat to a model.
- `{ kind: 'more', app, case, chat, health? }`: what the customer wrote after HQ took a person case; also how HQ hears,
  once, that a case it already has became a health case.
- `{ kind: 'draft', app, case, draft, summary?, translation?, ask? }`: a draft that came after its card, or the redraft
  for the board's "Ask for changes" (`ask`).
- `{ kind: 'answered', case }`: a question answered by email from a new knowledge entry; the card closes.
- `POST /api/care/photos?case=&name=` (a JPEG body): a claim's photo, after its card; the service deletes its copy
  once HQ has it.
- `POST /api/care/numbers { app, day, counts, partial? }`: each finished day's counts per app, for Care › Numbers.
  `emails` counts the emails the email service took for that app that day (its plan has a monthly limit).
- `GET /api/care/state` → `{ busy, queue, redraft, fixed, erased, numbers?, drafts, board }`: the busy switch and the queue;
  the redrafts asked for; the bug cases marked fixed and the cases the board deleted at a customer's request (the
  service deletes its copies); days of numbers wanted again; and the drafts HQ wants for its own email cards, answered
  once each as cards with `want` (an email in another language than the board's with its words translated,
  `boardWords`); `board` is the board's language (`en`, `nl`, `de`), which every summary and translation for the board
  is written in, kept through a restart.

**Retries**: a case stays in the service and is sent every minute until HQ has it. A 4xx about the card itself (not
401, 403, 404, 408 or 429, which are the line, not the case) is retried for a day, then left unsent in the database
for a person to find. HQ's side of this contract is `platform/coordinator/src/care.ts`.
