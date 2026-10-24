# The care service: the support chat's engine

The care service is the support chat every app of a company shares. Its AI helper answers customers in the app's own
widget, and a person is always one tap away: their email goes to the board's Care app in HQ. The helper looks up an
order once the customer has proved it's theirs (the order number and email, then a 6-digit code). It tells them where
the parcel is and answers from the company's knowledge base. It hands what it can't do to a person, and keeps working
from templates when the model is down. A company that sets `chatFirst` (below) has a chat that never offers a person:
one who asks first hears that the chat can probably help better, and only one who insists gets the email card.
What it says comes from templates or from the model, but **what's true and
what's allowed is decided in code**: a tool takes no value the customer didn't type, a button runs only what the
server stored, and a health detail never reaches a model.

This folder is the engine, the same for every company. What's one company's (its helper's name and instructions, its
words in its languages, its own tools and rules, its calendar, its model, its look) lives in the company's **plug-in
folder**, `products/care/` in its repo. The engine reads it through the settings below and never names it. The
template's plug-in, `template/products/care/`, is a working minimal example: Pebble, an English helper with a tiny
knowledge base and no tools of its own.

## The pieces

| File | What |
|---|---|
| `src/server.ts` | HTTP: `/__care/*` on every app's host (the widget's files, its API, the health check), loads the plug-in first |
| `src/company.ts` | the plug-in: `load()` and every setting with the engine's default |
| `src/config.ts` | everything from the environment, read once |
| `src/db.ts` | the SQLite schema (sessions, conversations, messages, actions, codes, limits, the ledger, cases, photos, …) and retention |
| `src/session.ts`, `src/gate.ts` | the device's session and grants (the `__Host-` cookie), the identity gate (order + email, the code, signed links, limits) |
| `src/apps.ts` | the client for each app's order endpoint (below), with its `CARE_TOKEN` |
| `src/actions.ts` | the action store: a button sends an id, the server runs what it stored |
| `src/engine.ts` | one conversation's timing: the burst, drafts, holding while the customer types, delivery, the outage state |
| `src/helper.ts` | the instructions, the model's tools and what each does, one answer's tool loop |
| `src/person.ts` | the way to a person and the other template steps (the greeting, the email card, the outage card) |
| `src/rights.ts` | a request to exercise a data right: a case of its own with the customer's words and its receipt, for the person who handles it |
| `src/texts.ts` | the fixed texts' English defaults, and `t()` over the plug-in's |
| `src/days.ts`, `src/busy.ts` | the company's days and working days; the busy notice |
| `src/model.ts`, `src/anthropic.ts`, `src/fake.ts` | the provider adapter (no SDK), and a scripted stand-in for tests and the harness |
| `src/ledger.ts` | a row per model call, the price table, the caps, the outage breaker |
| `src/drafts.ts`, `src/summaries.ts`, `src/toolcall.ts`, `src/chat.ts` | drafts for the board; summaries and the question log; the one-tool model call they and `inbox.ts` share, with its retry bookkeeping; a conversation as the cards and the models read it |
| `src/answers.ts`, `src/inbox.ts` | answers from new knowledge by email; HQ's email cards |
| `src/phone.ts`, `src/phonecall.ts`, `src/phonecode.ts`, `src/phonetools.ts`, `src/phonelang.ts` | the phone (below): the voice line's routes on their own port and a call's turns; a call's record (its conversation, messages and fault notes); the code and the numbers read out of what the caller says; the instructions, facts and tools on a call; the reply's language tag |
| `src/hq.ts`, `src/numbers.ts` | the line to HQ (cards out, the state in, every minute); the counts for Care › Numbers |
| `src/photos.ts`, `magick/policy.xml` | a claim's photos: checks before decoding, the decode in ImageMagick under its policy, the push to HQ |
| `src/diagnostics.ts`, `src/toollog.ts`, `src/kb.ts`, `src/entry.ts`, `src/email.ts` | bug reports with consent; the tool log for the eval; the knowledge base's loader and the one reading of an entry; email out |
| `public/` | the widget (below) |
| `demo/` | the local harness and the widget's check in a real browser (below) |

`src/engine.ts` is this service's own turn-taker, not `shared/chat/turn.js`: that one keeps a conversation in memory
and says a reply whole, while this one stores every message (a restart resumes it), delivers a reply sentence by
sentence as the model streams, runs only buttons the server wrote, and has the outage message (with its "Email a person"
link) for when the model is down. `turn.js` suits a product's own small chat; bringing the two together is upstream work.

## Run it, test it, deploy it

- **Locally**: `node platform/care/demo/shop.mjs` (from the repo's root) runs an invented shop with the widget and the
  real service on the fake model, with the company's plug-in. A company without a plug-in yet runs it on the template's:
  `CARE_COMPANY_DIR=template/products/care node platform/care/demo/shop.mjs` (without one the server won't start: there's
  no health list). Or start the server alone:
  `DATA_DIR=$(mktemp -d) CARE_LOCAL=1 CARE_PROVIDER=fake node platform/care/src/server.ts`.
- **The engine's tests** run against the template's plug-in: `cd platform/care && node --test src/<x>.test.ts`, one
  file at a time. A company's own tests sit in its plug-in folder and run from the repo's root against its own
  plug-in (`node --test products/care/src/<x>.test.ts`). They import the engine by its path in the repo.
- **Deploying**: the service is the product `care` (`infra/products.py`'s `CARE`). It's deployed when the company
  has `products/care/product.yaml`. Its image is `platform/care/Dockerfile`, built from the repo's root
  (`platform/care/Dockerfile.dockerignore` says what goes in: the engine and the plug-in folder, without tests, demo or
  eval). The image lays them out as in the repo (`/app/platform/care`, `/app/products/care`), so a plug-in's imports
  of the engine work in both, and sets `CARE_COMPANY_DIR=/app/products/care`. It runs in its own container with its own
  SQLite volume (`/data`) and a network only Caddy joins. Customers reach it on their app's own host at `/__care/*`,
  for every product whose manifest says `care: true`. Caddy sets `X-Care-App` (`<slug>`, or `<slug>@preview` on the
  preview host), and the service trusts nothing else for the app. Caddy also sets `X-Care-Shop`, the shop the app is a
  stall of: apps on one origin (a company's shop of shelves) share one cookie, so they share one session, one
  conversation and its grants, and a checked email's orders come from every stall; elsewhere it's the app itself, a
  shop of one ("One chat for a shop", below). products.py gives it the apps
  (`CARE_APPS`, `CARE_TOKENS`, `CARE_NAMES`), the shops (`CARE_SHOPS`), its line to HQ (`CARE_HQ_URL`, `CARE_HQ_TOKEN`), its cookie's name (`CARE_COOKIE`, the
  last of `company/infra.env`'s `CARE_COOKIES`) and its keys (`CARE_ANTHROPIC_API_KEY`, `CARE_EMAIL_API_KEY`), which
  the board saves on the desk phone. Until the model key is set, the service is "model down": the outage card, with a
  person a tap away (in the ⋯ menu with `chatFirst`).
- **Switching it on** for a company, its steps and the board's in order (the plug-in, each app's part, the keys, the
  email service, preview then public): `docs/switch-on.md`.
- **HQ's side** is the coordinator's: the service sends its cards, a claim's photos and the day's numbers to HQ's
  `/api/care/*` and reads its state there, with its own token (`CARE_HQ_TOKEN`), and HQ's Care app shows them.

## The plug-in

A company's folder for the service, found through `CARE_COMPANY_DIR`. That's an absolute path, or one relative to the
repo's root, and it defaults to `products/care`. Everything in it is optional; what's missing is the engine's default.

```
products/care/
  care.ts          the server's part: the settings below, as named exports
  src/             its own modules (tools, rules, texts) and their tests, importing the engine as ../../../platform/care/src/x.ts
  public/          the widget's part: plugin.js and the files it names, served at /__care/company/<file>
  kb/              the knowledge: shared/*.md for every app, <app>/*.md for one app (kb/README.md in the template)
                   (an entry with `## <lang>` sections is read in the conversation's language only, its `## chat`
                   part in every one: kb.ts)
  apps/            each app's own words: <app>.json, { "<lang>": { "<text key>": "words" } }, over care.ts's texts
                   (named like the app's kb/ folder, CARE_KB's when it maps one)
  product.yaml     the service's manifest (name, memory, …): with it, the company runs the service
  demo/, eval/     its own harness pages and evals (not in the image)
```

`src/company.ts` loads `care.ts` and `public/plugin.js` once, before the server starts. A module of the plug-in may
import any of the engine's modules: the engine reads the settings only when it runs, never while a module loads, so
there's no cycle. The template's `care.ts` is the example.

### Settings in `care.ts`

| Export | What it is | The engine's default |
|---|---|---|
| `instructions(name, knowledge)` | the instructions' long, stable part, which is cached: who the helper is, how it talks, how it uses its tools, then the knowledge (`knowledge` is `''` when there's none) | a generic helper without tools of its own (`src/helper.ts` `DEFAULT`) |
| `texts` | `{ <lang>: { key: text } }`: the fixed texts in each language. A key missing in a language falls back to the first language's, then to `src/texts.ts`'s English, which has every key. `{helper}`, `{app}`, `{thing}`, `{aim}` and `{busy}` are filled in, and `{days}` (`busy.aim`) in the `aim` text. An app's own words (`appWords`, the same shape) go over these where the conversation is that app's: its greeting (`hi`, `can`, `what` and the chips `parcel`, `damage`, `broken`), the way to a person and the outage card. `hi` says it's an AI, and `can` what the chat can really do for that app | English |
| `liveKnowledge(lang)` | entries of its own made from live data (what its shop sells today, say), in a language: last in every conversation's knowledge, the chat's and the phone's (`src/kb.ts`), and written the same way for the same data, so the cached prefix changes only when the data does | `''`: none |
| `appWords` | each app’s fixed texts over `texts`, loaded from `apps/<kb folder>.json` with the same language and key shape. The folder name follows the app’s knowledge, including any `CARE_KB` mapping | no app overrides |
| `locales` | `{ <lang>: 'nl-NL' }`: the locale a language's dates are written in | the language itself, `en-GB` for English |
| `model` | the model the helper runs on (`CARE_MODEL` goes over it); the ledger's price table must know it | none: the server won't start on the real provider without one |
| `names`, `things` | `{ <slug>: 'Name' }`, `{ <slug>: 'mug' }`: an app's name, and what it makes (the starting chip "Something's wrong with my …"). `CARE_NAMES`/`CARE_THINGS` go over them | the slug, `order` |
| `sender` | `'Name <someone@its.domain>'`: the service's email comes from it, and only that domain may be a sender; a question's answer replies to `case-<n>@` that domain | `Care <care@example.com>` |
| `company`, `shop`, `about`, `partner`, `notToRepeat`, `remedy` | the company in the prompts for the board and the team: its name; a shop of its (`{company}`, `{thing}`); who it is, for HQ's email drafts (`{company}`, `{shops}`); the partner a claim goes to, in a claim's redraft ("<partner> <app>'s <thing>s"); a personalisation's detail a draft never repeats; its remedy policy, a clause no draft argues away | `the company`, `{company}'s shop`, `{company} sells through its shops ({shops}).`, `our partner, who makes and ships`, none, `a fault in what we made, or a parcel damaged or lost on its way, is for us to put right, as a person decides` |
| `timeZone` | the company's time zone: its days for Care › Numbers, the month's cap, the dates in emails, working days. Keep it the same as `company/org.yaml`'s, which HQ counts by | `UTC` |
| `holiday(day)` | `'YYYY-MM-DD'` → a public holiday (no working day), besides weekends | none |
| `busy` | `{ season(t), waiting, days, aim }`: the busy notice ("it may take longer") is on in the season (`season` returns its reason, or null), past `waiting` emails waiting or one older than `days` working days, and always past `aim`, the working days the texts promise ("we aim to reply within 3") | no season, no limits, `aim` 3 |
| `chatFirst` | the way to a person: `false`, every ask for a person, and the ⋯ menu's "Email a person", gets the email card at once, and every outage message ends in "Email a person"; `true`, the chat never offers a person: the engine's instructions and `ask_for_person` tool say so, a conversation's first ask for one of `caseFor`'s (while the helper can help) first gets the chat's one case for trying here (`person_case` in the menu's words) with "Let's try here" beside "Email a person", any later ask or an insist the card, and only `linkFor`'s outage messages end in the link. The company's own `instructions` must follow this policy. Its `texts` must override `helped_no`, `code_failed` and `team_reply` (the end of an emailed answer to a question for the team), whose engine defaults offer a person | `false` |
| `caseFor` | with `chatFirst`, the asks whose first one gets the case: the model's reasons for `ask_for_person` (`asked`, `complaint`, `dispute`, `no_photos`, `cant_help`) and `menu` for the ⋯ menu's "Email a person"; any other ask, and an insist always, gets the email card at once. `['asked']`: a case only for a plain ask in words, a complaint the card. A request to exercise a data right is never an ask: `privacy_request` files it ("A data request", below) | every reason but `insisted`, and `menu` |
| `linkFor` | with `chatFirst`, the outage causes whose message ends in the one small "Email a person" link: `service` (the AI service is down), `cap` (the spending cap), `stop` (this chat stopped for the day); any other's message has none, and the ⋯ menu still reaches the email card. All three: a person one tap away whatever the cause | `['stop']` |
| `hqMonth` | HQ's own email drafts' share of the month's cap, in euros (`CARE_CAP_HQ_MONTH` goes over it): they stop at it, and the chats at the rest. Over it, HQ's drafts wait and the chats go on | `0`: no share, everything shares the whole month |
| `tools` | `[{ def, status?, log?, run(c, session, input) }]`: the company's own tools for the model (below) | none |
| `taps` | `{ <kind>: (c, actionId, args, template) => void }`: what a button of its own does (a card option `{ kind, label, args }` its tool put on screen) | none |
| `facts(c)` | lines for the facts of a conversation, after the engine's (how what its tools started stands) | none |
| `beforeAnswer(c)` | runs before each answer (ask an app how something stands, so the facts are fresh) | nothing |
| `checkWaits(c)`, `afterCheck(c)` | a tap of its own that needs a fresh code: `checkWaits` says so (the model's note, or `''`), `afterCheck` goes on once the code is typed (true if one did) | none |
| `deliveryStatus(order, now)` | how an order stands by the company's delivery rule, given to the model beside the order (`delivery`) | none: no `delivery` |
| `resolved(app, from, to)` | conversations its own tools resolved without a person that day (Care › Numbers' `resolved_remedy`) | 0 |
| `files(session, name)` | a file of its own for this device: `GET /__care/api/file/<name>` (a link its tool put in the chat, in a `files` card) answers `{ type, name, body }` as a download (`attachment`, `nosniff`, a sandbox CSP, never cached), or `null` for a 404. The plug-in checks the device may have it; the route refuses a session without a cookie, one whose grant is held for another page, and past 60 an hour | none: every name is a 404 |
| `visitor(req)` | what its tools need of the visitor's own request (a cookie of the shop's, say), as `{ name: value }`: read from each of the widget's requests (never the stream's), held in memory beside the device's session and given to the answer that request starts and to a tap as `c.visitor`; never stored, so `{}` after a restart until the device's next request | `{}` |
| `start()`, `sweep(t)` | its timers, once the service is up; its retention, hourly with the engine's | nothing |
| `phoneMonth` | the phone's own month in euros (`CARE_CAP_PHONE_MONTH` goes over it): past it, a call doesn't start and a turn isn't answered ("The phone", below) | `0`: the phone is off |
| `phoneInstructions` | the phone's part of the instructions, after `instructions`: what's different on a call (spoken answers, the phone's tools, what the code unlocks) | the engine's own (`src/phonetools.ts` `PHONE_PART`) |
| `phoneTools` | `[{ def, run(call, input) }]`: the company's own tools on the phone, information only (below) | none |
| `phoneCore` | the engine's own caller tools its line offers, by name (`check_postcode`, `send_code`, `order_status`, `email_answer`, `report_fault`, `ask_for_person`, `pass_on_feedback`): `[]` for a line that isn't for customers, which offers only its `phoneTools` (and its own `phoneInstructions`). `switch_language`, `no_transcript` and `hang_up` are the line's own and always there | `null`: all of them |
| `phoneFacts(call)` | lines of its own for the facts of a call (`{ conversation, shop, lang, granted }`), after the engine's, on every turn | none |
| `orderRef` | `(digits) => boolean`: whether a run of digits a caller says is one of the company's order references, kept as said while a code is asked for ("The code, in code", below) | none: every run of five digits or more is a code or a number |

A **tool** of the company's goes into the model's list after the way to a person and the team's question, before the
health check and the closing tools. `def` is its definition (`{ name, description, input_schema }`). `status` is a
text's key for the line shown while it runs, and `log` names the input fields the eval's tool log keeps (never a note
or anything typed). `run` gets the context `c` (`c.conv`, `c.out`, `c.live`, `c.lang`, and `c.visitor`, the plug-in's `visitor()` of the device's request), the device's session as it is
now (already checked to be in this conversation), and the model's input. It returns
`{ content, widget?, done?, speaks?, email? }`. `content` goes back to the model as data. `widget` is a card under the answer.
`done` ends the answer. `speaks` says its words are all the server's (a card's, a start's), so what the model wrote in
that round and hasn't sent is taken back; what the tool itself writes stays, the model's words too when it gave them to
the tool to say (`c.out.modelSays()`). `email` says an order of that email's went to the model, so a reply drafted from this chat
talks about orders only to them. A tool that changes something does it as an effect at delivery (`c.out.effect()`) or through a button
(`taps`), never from the model's words alone. A claim's photos: a tool sets `c.conv.state.claim = { order, kind, shots }`
and shows `photos.slotsFor(app, shots, lang)` (labels from the texts `shot_<shot>` and `shot_<shot>_hint`); the upload
route and `photos.filled()` read it.

### The environment

| Variable | What |
|---|---|
| `CARE_COMPANY_DIR` | the plug-in's folder (above) |
| `PORT`, `CARE_HOST`, `DATA_DIR` | where it listens (8080, every interface) and its volume (`/data`) |
| `CARE_APPS`, `CARE_TOKENS`, `CARE_NAMES`, `CARE_THINGS`, `CARE_KB` | per X-Care-App: the app's base URL, its `CARE_TOKEN`, its name, what it makes, the kb folder it reads when not its slug's |
| `CARE_SHOPS` | per X-Care-Shop: the apps (stalls) of a shop of several, `{ "front": ["shop-a", "shop-b"] }`; a shop not listed is its own app |
| `CARE_HQ_URL`, `CARE_HQ_TOKEN` | the line to HQ |
| `CARE_COOKIE` | the session cookie's name, always `__Host-` or the service won't start (default `__Host-care`) |
| `CARE_ANTHROPIC_API_KEY`, `CARE_ANTHROPIC_API`, `CARE_MODEL`, `CARE_EFFORT`, `CARE_PROVIDER` | the model: its key, API base, model (over the plug-in's), effort, and the provider (`anthropic`, or `fake` on a local run) |
| `CARE_EMAIL_API_KEY`, `CARE_EMAIL_API` | the sending service (Lettermint); without a key a local run keeps an outbox |
| `CARE_CAP_MONTH`, `CARE_CAP_APP_DAY`, `CARE_CAP_CONVERSATION`, `CARE_CAP_SESSION`, `CARE_CAP_IP_DAY`, `CARE_EUR_PER_USD` | the caps in euros (19 a month for everything, 2 an app a day; for the company's day, 0.50 a conversation, and 0.15 a session and 0.60 an address before any check) |
| `CARE_CAP_HQ_MONTH` | HQ's drafts' share of the month, over the plug-in's `hqMonth` |
| `CARE_CAP_PHONE_MONTH` | the phone's own month, over the plug-in's `phoneMonth` |
| `CARE_PHONE_PORT`, `CARE_PHONE_TOKEN`, `CARE_PHONE_SHOP` | the phone's routes: their port (8081), opened only with the token (the voice line's, made like `VOICE_TOKEN`), and the shop a call is a conversation of (else the first of `CARE_SHOPS` that isn't a preview's) |
| `CARE_LINK_KEY` | the key that signs links in the service's emails (made on first start if not given) |
| `CARE_LOCAL`, `CARE_KB_DIR`, `CARE_MAGICK`, `CARE_FAKE_FILE`, `CARE_RETRY_MS`, `CARE_MAIL_RETRY_MS`, `CARE_HELPED_MS`, `CARE_PROBE_MS` | local runs and tests: plain http, another kb, the ImageMagick binary, the harness's model, faster timers |

## The order endpoint each app adds

All `POST`, JSON, `Authorization: Bearer <CARE_TOKEN>` (compared in constant time; anything else is a 401 with no body),
at `./api/care/<name>` relative to the app's address: its own host, or its shelf `www.<zone>/<slug>/`, where Caddy
takes the prefix off so the app sees `/api/care/<name>` either way. The service
never receives an order's email from the app.

| Path | Body | Answer |
|---|---|---|
| `match` | `{ order, email }` as typed (the app normalises) | `{ match: true, order: View, orders?: [View] }` or `{ match: false }`, the same shape and status either way. A number that names several of the app's orders (one customer's basket) answers them all as `orders`, the first as `order` |
| `orders` | `{ email }`, checked by the service's code | `{ orders: [View] }`: every order for that email in this app, newest first, at most 20 |
| `code` | `{ order, code, lang }`: a phone call's code for this stall (each stall gets its own), the order number as the caller said it in letters and digits only (the app finds its order whatever the separators were) | `{}`, after the same minimum time whether or not the order is the app's. If it's one of its paid orders, the app has the code emailed to its payer (in `lang`); care never learns the address |
| `view` | `{ order }` as for `code`, asked only once the caller passed a check for that number: this stall's, or another stall's of the same shop, as a basket's number is then asked of the shop's other stalls too, each answering its own orders under it | `{ match: true, order: View, orders?: [View] }` or `{ match: false }`: a basket's number, as for `match`, answers each of its orders. Its `View` has no `title` but `product`: what it is as the shop names it, with nothing of what's printed on it ("Textile poster 30 × 40 cm"), as a caller may not be who ordered |
| `postcode` | `{ order, postcode }`: the order number as for `code`, and the postcode the caller gave for it in letters and digits only, upper case | `{ match }`, after the same minimum time whatever it was: true when an order of the app's paid ones under that number goes to that postcode (compared in letters and digits). Care never learns the address |
| `answer` | `{ key, order, text, lang }`: the answer care wrote to a caller's questions after the call (plain text), with care's key for it (the call's and the order's: HQ sends one email a key) | `{ sent: true }` once HQ took it, to the payer of the app's paid order under that number; `{ sent: false, why }` when there's none, or HQ refused it, with `unsure: true` when it may have gone all the same (HQ's reply lost); a 503 when it surely didn't, as HQ can't be asked now (care tries again). Care tries again only what surely didn't go (no connection, a 502 or 503, a 4xx: `apps.ts` `callOnce`), never a timeout. Care never learns the address |

`View` is the minimal order view: `{ id, ref, number, placed_at, title, status ('paid' | 'printing' | 'shipped' | 'delivered' |
'cancelled' | 'refunded'), shipped_at, delivered_at, carrier, tracking_url, country, total_cents, address_masked, product? (the phone's `view` has it in `title`'s place) }`
(dates ISO 8601; `number`: the number the customer was told for it, which every order of one checkout shares, in
every app of the shop (the phone opens them together), or null;
),
and `ship_by` (YYYY-MM-DD), the day it should leave the printer, and `town`, the town or city it goes to
(the only part of the address the phone may say), when the app knows them. Never the personalisation where it's sensitive, never the full address. A company's own tools may
call paths of their own the same way (`apps.call(app, path, body)`). An app without a confirmed date for an order sends
`placed_at: null`, and the order card leaves the date out.

The service waits 5 s for an app. An app away (no answer in time, no connection, or a 502, 503 or 504), as during a
deploy, which Caddy holds for up to 30 s, is no answer to the caller, and its line is logged only once the app has been
away call after call (each within ten minutes of the last) for ten minutes. HQ's watch reports an app that's down. Any
other failure is logged at once.

An app paid through HQ's payments that keeps no payer email asks HQ instead: `POST /api/pay/payer {id, email}` says
whether its session was paid from that email, and `POST /api/pay/payer/sessions {email}` names its paid sessions for it
(`payments.ts`). HQ compares the email with Stripe's and never returns it.

## One chat for a shop

A company that sells several apps on one origin (shelves at `www.<zone>/<slug>/`) has one chat for all of them: the
shop is what Caddy sends as `X-Care-Shop`, its stalls are `CARE_SHOPS[shop]`, and the stall a request comes from is its
`X-Care-App`. What goes by which:

- **The shop** (whose session, grants, conversation and thread for an email; whose actions and signed links): the
  customer moves from one stall to the next in the same chat, and a link from our emails opens on any stall of the shop
  it was made for. A request from an app that isn't a stall of the shop it names is refused.
- **The stall the customer is in** (the latest request's, kept in the conversation's state): the helper's name, its
  instructions and knowledge (`kb/<stall>`), the words of the fixed texts, and `hello`'s `stall` (the widget's element
  carries it as `data-stall`, so the plug-in's stylesheet dresses each stall; a `data-stall` the page put on the element
  itself stays, for a stall that uses its shop's chat without one of its own). Never
  what the helper may show.
- **The order's app**: `check_order` asks every stall (an order number alone doesn't say whose; one number can match in
  two apps, or name several orders of one basket, and all are granted); `my_orders` lists every stall's, newest first; each order the tools give carries its
  `app` and `from` (the stall's name), and the order tools take `app` when two of the customer's orders share a number
  (`gate.find()`). A company's own tools take the order's app from there: its rules, remedies, claims and photos.
- **Spend and counts** (`config.ts aboutOf()`): the app of the orders the helper looked at when they're all one app's,
  the shop when they're several apps', else the stall. Numbers counts a conversation in each stall the customer wrote
  from that day (`messages.app`). A person's card names that app too; a question, the stall whose knowledge didn't answer.

## The phone

The phone line has two modes (the board, 2026-10-15), and the second is built:

**The recorded message** is the coordinator's (`platform/coordinator/src/phone.ts`): the board's own number reaches the
team with its PIN, and when the helper isn't answering (the company hasn't named one for the caller's line in brand.yaml's
`phoneLines`,
a number's fourth call of the day, the phone's month spent, care down) a caller hears a short message in each of the
company's languages that points them to the website and the email address, and then the call ends.

**The helper on the phone**: the platform's voice line (`platform/voice`, its `Care` brain) does the speech, and this
service the conversation, as for the chat: its tables, knowledge, model, ledger and caps, with tools of its own. No
audio is kept anywhere; care keeps the words, as a chat's. The pieces' table above names its four files.

**The routes** listen on a port of their own, `CARE_PHONE_PORT` (8081), opened only when `CARE_PHONE_TOKEN` is set.
Only the voice line reaches it, through Caddy's inside port (`http://caddy:8081/<deployment>/phone/*`, infra/products.py),
with the token of that deployment. Each is a `POST` of
JSON with `Authorization: Bearer <CARE_PHONE_TOKEN>`, compared in constant time; anything else is a 401 with no body.

| Route | Body | Answer |
|---|---|---|
| `/phone/start` | `{ call, lang? }` (Twilio's CallSid: in the log only, never stored; the opening's first language, in which care reads the call's prompt, its instructions, knowledge and tools, into the model's cache at once, one request stopped at its first event, so the first turn doesn't write it while the caller waits) | `{ conversation, helper, langs, words: { <lang>: { ai, transcript, ask, objected, reply_ai, fine? } } }`: the plug-in's texts `phone_ai`, `phone_transcript`, `phone_ask`, `phone_objected`, `phone_reply_ai` ("I'm Poppy, an AI assistant.", the AI line before a reply in a language the opening didn't have) and, where a language has its own, `phone_fine` ("English is fine too.", after the AI line of a language the opening has second), which the line says itself (the opening, AI Act art. 50(1), GDPR art. 13). Or 503 `{ why: 'off' \| 'cap' \| 'down' }`: no month for the phone, a cap reached, the provider down. The line then plays the recorded message |
| `/phone/turn` | `{ conversation, text, lang, informed }`: what the caller said, the call's language so far, and the languages whose AI and transcript lines they have heard played whole, the AI line alone once they objected (the hold below) | 200 `application/x-ndjson`, one JSON object a line: `{ lang }` first, the language the model tagged its reply with (the line speaks it in that language's voice), `{ text }` as the reply is written (the model's words, and the fixed words a tool says; after earlier words of the turn, a later model call's words and a tool's start with a space), `{ step: <tool> }` as a tool call starts, `{ used: <tool> }` once it has run, then `{ end: true, model }` (the turn's model calls for the line's log: `rounds`, `first`, the seconds to its first words, and the prompt's tokens `read` from the cache and `written` to it); or `{ unanswered: 'cap' \| 'down' \| 'error' }` in its place. Closing the request stops the model's stream (barge-in); what was written until then is kept (or held, as the caller's words), and its cost counted. A newer turn of the call stops the one before |
| `/phone/end` | `{ conversation, ended: 'hung_up' \| 'caller' \| 'limit' \| 'error', informed }` | `{}`. What's held is kept if `informed` now has its language, else dropped. The call's codes are spent and, if the caller objected, its words deleted. An ended call takes no more turns (404). A call the line never ends (a crash) is ended by the hourly sweep 15 minutes after its last words |

**A call's conversation** is a row of `conversations` of kind `phone`, in the shop `CARE_PHONE_SHOP` names (else the
first shop of `CARE_SHOPS` that isn't a preview's: a company's front). The caller's words and the helper's are its
messages, but only once they've heard the AI line and the transcript line played whole in the language they speak (GDPR
art. 12(1), 13): their words wait in care's memory, for the model, until a reply's tag says their language and the
line's `informed` has it; then they and all written after them (a fault note, an email answer's question too) are kept
as they came, in order. A call that ends first keeps none of them, an objection only a fault note (`src/phonecall.ts`,
`hold()`). The instructions are the plug-in's `instructions` (with the shop's
knowledge and each stall's own) and then its `phoneInstructions`: spoken answers, short, no lists, links or markdown,
numbers as said, never "type". Each model call is a ledger row of purpose `phone`, under the app it's about (the stall
of the order a code opened, else the shop).

**The call's language**: the reply's tag says it (`phonelang.ts`). The call
settles with the caller's second reply in a language they have heard the notice in (`state.phone.settled`). Each caller
turn counts once in each language its reply is tagged in (`replies`), as the line counts. One short first reply
("Hallo?" is Dutch and German) can't show which language they understand. Before the call settles, a switch (however
many) brings the new language's notice lines first. The call is held to the language it settled in, or to the one the
caller asked for (`state.phone.locked`), and the facts tell the model so. A reply tagged in another language is asked
again once, with a line that the call is in its language: a turn that reads as another is most often the speech
recogniser mishearing one. Only `switch_language`, the caller asking, moves it. A model that stays in the other language
when asked again leaves the turn unanswered, as a second untagged reply does. Once settled, the line says no notice line
again (`platform/voice`, `settled`).

**What stops it**: the phone's own month (`phoneMonth`, `CARE_CAP_PHONE_MONTH` over it; 0, the engine's default, is
the phone off), checked at the start, before each turn and between a turn's rounds; the month's total (and the HQ share,
the prepaid credit and the app's day cap) as for every model call; and the outage breaker (a turn may be its probe, a
call never starts on one). The line then plays the recorded message. A call is ten minutes at most (the line's limit).

**The tools** (information only: nothing on the phone changes an order, so no change, refund, voucher or reprint):

| Tool | What it does |
|---|---|
| `check_postcode(order, postcode, topic)` | where an order stands, without a code: asked of each stall's `postcode` at once. A match opens that order's status to the call (`state.phone.status`, apart from a code's `granted`); a wrong postcode and no such order are told alike. 3 a call, 5 per order number a day across calls (`hits`), then `phone_postcode_limit`. While a stall couldn't be asked, nothing is told, a match included, and it isn't a wrong postcode: it can't be checked now, and neither count is taken |
| `send_code(order, topic)` | for more than the status, once the caller said yes to it: one random 6-digit code per stall of the shop and of its preview (a tester's order is kept there), each kept as a hash with its stall and the order number as said (`phone_codes`), asked of each stall's `code` (the email goes from HQ to the order's payer). The model always hears the same words (`phone_code_sent`), whether the order exists or not. At most 3 per order number a day across calls (`hits`), then `phone_code_limit`. A new one replaces the call's last |
| `order_status(order?)` | before a check, nothing about any order. After one, that order from its stall's `view` (a basket's number, which that stall's orders carry as their `number`: every order under it, that stall's and the shop's other apps', the check standing for the checkout; an app that can't be asked is said to be missing), as `src/phoneorders.ts` gives it. After the postcode: status, the dates, the carrier, whether there's tracking and the plug-in's `deliveryStatus`. After a right code, also what it is (the view's `product`), quantity, `total_cents`, the street and town (`address_masked`) and country. Never the name, postcode, email or a personalisation, nor the chat's `title`. A code for one order and a postcode for another keep both open: `order` names which, else the newest check's; in full only the code's |
| `email_answer(order, question, topic)` | an answer by email after the call, once the caller said yes to it: the model hears `phone_answer_kept` whatever the order. The call's questions about one order are kept together (`phone_answers`), and once the call has ended `src/phoneanswer.ts` finds the order at whichever stall has it, has one model call answer them from the shop's knowledge and that order (as a code opens it; ledger purpose `answer`), and asks that stall's `answer` to have HQ email it. What they can't answer, the email says a person answers a reply (`phone_answer_unknown`). Nothing goes for no order; 3 per order number a day across calls, then `phone_answer_limit`; tried 5 times, 5 minutes apart, then left with an error line (a model output that won't do is a failed try; a send that may have gone is left at once, said in the log) |
| `report_fault(order, what)` | a dated note of a fault, with or without the code (below) and `phone_fault` for the model to say |
| `pass_on_feedback(feedback)` | general feedback for the team, as in the chat (below): a case of kind `feedback` in the model's general words, with no order, number or reply address (one with an email address or five digits in a row, single spaces, dots or dashes between them too, is refused, to be written again). Written as the call's other records are (`keep()`), and held from HQ (`held` `call`) until the call ends: an objection deletes it then, else it goes |
| `ask_for_person()` | speaks `phone_person` itself: the email address, as the recorded message says it. A written summary by email (the chat's "Email a person") isn't offered: care never has the order's email to reply to |
| the plug-in's `phoneTools` | `run({ conversation, shop, lang, granted }, input)` → `{ content, done? }`: information only, like these |
| `switch_language(lang)` | with several languages, only when the caller asks to go on in another: the call's settled language moves to it (below), and a caller informed in the one before counts as informed in it |
| `no_transcript()` | the caller objects: the line says `phone_objected`, and the words go at the call's end |
| `hang_up()` | after the goodbye: ends the turn, and the line hangs up |

**The code, in code** (`src/phonecode.ts`): once a code was asked for in a call, each turn the caller says is read before
anything else. Every run of six digits in it (digits, or number words in Dutch, German and English, one at a time or
in pairs, with "uh" between) is a code read out: compared with the round's hashes (10 minutes, 5 tries for the round)
and replaced by "(read out the code)" in what's kept and what the model reads; a run of five or seven is a code
misheard, taken out too and not a try. A run that is one of the company's order references (the plug-in's `orderRef`)
stays as said. The model gets only the result, as a line after the caller's words. A right code
opens that one order of that stall to this call (`state.phone.granted`), links the call to it (`conversations.linked`:
kept 12 months) and is spent.

**What callers ask** is counted from the log: each of the three tools above logs one line, `care: phone conversation
<id>: an ask by <postcode | code | email>, about <topic>` (status, contents, price, address, cancel, change, other), with
no words or numbers.

**Kept**: as chats, 30 days after the call's last words, or 12 months once a code linked it to an order. An objection
deletes the call's messages at its end; the code check's results (`state.phone.checks`), the link and a fault note stay.
So does a question for an answer by email (`phone_answers`), on purpose: the caller asked for that answer, and the email
still goes; the row is deleted once it has gone, or was given up (no such order, 5 tries, or a send that may have gone),
and at the latest with the call's conversation.
A caller's turn with a health detail is kept empty and never reaches the model, as in the chat.

**A data request** (GDPR arts. 12 and 15 to 21) is a case of kind `rights` (`src/rights.ts`). The model's
`privacy_request` names every right the request asks for and the customer's messages that make it, by their numbers. Care copies
those messages as they were written, never a model's summary, and the earliest one's time is the receipt, kept the
earliest when more words join it. The facts give
the rights asked for, the receipt, the last day to answer (a calendar month on), the other cases a person may need to look at,
and how to handle it. It needs no yes and no ask for a person, and the chat says only "I'll pass your data request to
the team for handling" (`rights_sent`, or `rights_address` when it asks for the reply address first). A request waiting
for its address is held (`held = 'address'`) and goes without one once its conversation has gone quiet. An address
that comes after that goes to its card in HQ as well, with the other cases under it, whatever step asked for it last
(a question for the team in between goes with it too). Nothing the customer wrote is cut on its way: a message too long
for one request to the service stays in the chat's box, whole, and the widget asks for it in parts. It carries no
chat, no model drafts or redrafts its reply, and the knowledge's `answers:` never answers or closes it, so HQ's card
waits until a person sends or closes it. A message with a health detail never goes with it.

**Feedback** (the chat's and the phone's `pass_on_feedback`, `src/person.ts` `feedback()`): what a customer asks the
helper to pass on to the team (praise, a wish, something that could be better), in the model's own general words, is a
case of kind `feedback`: no reply address, no orders, nothing of the conversation, so nobody replies to it, and the
helper says so. It goes to HQ as a card of its own, which HQ's Care app lists apart, as a note to read and close

**A fault reported by phone** (consumer law: a valid notice of a defect) is a case of kind `fault` in care's `cases`:
the order number as said, the day, what's wrong, and `checked` (`checked` when the caller read back that order's code,
else `none`). It's kept as a case is (12 months) and goes to HQ as no card of its own. It's read beside its order
(`faultsFor()`): the chat's order tools give it with the order (`reported_by_phone`), so the helper knows the
customer told us, and every card care sends HQ about that order (a person's case, a claim) carries it in its facts, which
HQ's Care app shows as "reported by phone".

## The widget (`public/`)

The engine's widget is `public/`: `widget.js` (the element, the conversation, the transport), `catalogue.js` (the cards,
drawn from the server's JSON), `i18n.js` (its own words, English, under the company's), `health.js` (the health-detail
matcher, which the server runs too), `snapshot.js` and `telemetry.js` (the bug report), and `chat.css` (the layout and a
plain default look). An app loads it with `<script type="module" src="./__care/widget.js"></script>`, and any element
with `data-care` (or the plug-in's `names.opener`) opens it. The address is relative, so on a shelf it is the shelf's own
(`/<slug>/__care/`): a page deeper down climbs with `../`.

The server serves the engine's files at `/__care/<file>` and the plug-in's `public/` folder at `/__care/company/<file>`,
both read at start. The widget imports `./company/plugin.js`, the plug-in's widget side (an empty module when the plug-in has none): plain data with no DOM, which
the server imports too (`company.ts`: `helper`, `langs`, `words`, `health`, `links`). Every export is optional:

| Export | What it is | The engine's default |
|---|---|---|
| `helper` | the helper's name: the header, About, the labels (`{helper}` in the words) | `the helper` |
| `names` | `{ tag, opener, link }`: the element, its `[data-<opener>]` Help links, the emails' `#<link>=<token>` | `care-chat`, `care`, `care` |
| `langs` | the languages it speaks; the first is the fallback | `['en']` |
| `words` | `{ <lang>: { key: text } }`, the widget's own words over the engine's English (`i18n.js` has every key). The knowledge quotes them by key (`{label:m_delete}`, `kb.ts`), in the customer's language. An About line (`ab_2` to `ab_5`) left `''` isn't shown | English |
| `health` | `{ <lang>: text }`, the health check's terms, one per line (`*` at an end: the word may go on; `#` a comment); `false`: no health-detail check, on purpose | none: the server won't start |
| `links` | the hosts the chat may link to besides the app's own (its sites, its carriers' tracking pages) | none |
| `art` | SVG drawings: `order` (an order without a picture), `box`, `label`, `flat`, `close`, `print`, `contents` (photo slots) | plain outlines |
| `avatar` | `({ title }) => svg`, the helper's mark (bubbles, header, launcher) | "AI" on the accent |
| `stylesheet` | a file in the plug-in's `public/`, loaded over `chat.css` | none |
| `launcher` | `false`: no launcher on any page, for apps whose Help link is built on demand | a launcher on a page without a Help link |

**The look.** An app themes the widget with five custom properties on its element: `--care-accent`, `--care-ink`,
`--care-paper`, `--care-font`, `--care-serif`. Every other colour is mixed from the first three. A plug-in's stylesheet
can map its own names to them, and give the conversation a texture. It does that by setting, on `:host`, `--c-me`,
`--c-ink`, `--c-bg`, `--sans`, `--serif`, `--grain` (an image over the log) and `--c-art` (the photo drawings' accent):
`chat.css`'s header comment says so.

**The AI mark** (AI Act art. 50(2)). What the model wrote for the customer carries a machine-readable mark, and a
template doesn't. Its chat messages: `aiGenerated: true` on a `reply` and on the items of `hello` and `earlier`,
`data-ai-generated="true"` on its bubble in the widget. The note it writes for the email card (`ask_for_person`):
`noteAiGenerated: true` on the summary widget, stored with it and in `hello`, and `data-ai-generated="true"` on the
card's text field until the customer changes the text (a note the customer changed comes back unmarked). Its
emails: the header `AI-Disclosure: mode=machine-generated` on one with the model's words in it (the team's answer to a
question, a copy of a chat that has some). The greeting, the outage message, the fixed texts (the email card's own words too), the code emails and a
person's replies have no mark. No standard names an HTML attribute for AI-generated text yet. An `ai-disclosure`
attribute is only a proposal (a W3C community group's), so the widget uses a plain data attribute that says what it
means. No mail standard names a header either. `AI-Disclosure` is the field an IETF draft (draft-abaris-aicdh) defines
for HTTP, in that draft's syntax. The header isn't the disclosure a reader sees (art. 50(1)): an answer by email opens
with it in words, the text `team_intro` (the team's answer to a question).

**The demo and the check.** `demo/shop.mjs` is a local shop that plays an app (the order endpoint, Caddy's part) and
starts the care server with the plug-in. `demo/widget-check.mjs` checks the widget in a real browser at a phone's and a
tablet's sizes: the conversation, the keyboard, contrast (the plug-in's theme and a blue one), reduced motion, the
outage, the health card, each of the plug-in's languages, the bug report. Both take what's the company's from the
plug-in's `demo/`: `demo.mjs` (the app, the customer and orders, an endpoint of its own tools, the theme's colours, what
the check types and draws: `demo/demo.mjs` here lists every export with the engine's own) and its own `shop.html` and
`order.html`, else this folder's.

## More

| Doc | What |
|---|---|
| `docs/switch-on.md` | switching the chat on: the company's steps and the board's, in order; the model key (a workspace of its own with a monthly limit); what it costs |
| `docs/api.md` | the widget's API on the app's host, the bug report, and the line to HQ's Care app |
| `docs/email.md` | the email service (Lettermint): the board's sign-up, the DNS records in Cloudflare, the sender, `EMAIL_SERVICE` |
| `docs/dpia-template.md` | the privacy assessment (DPIA) a company copies and completes before launch: what the engine collects and keeps, the health check's two layers and its limit, the bug report, processors, risks |
