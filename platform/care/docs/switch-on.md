# Switching the support chat on

The steps from "we want the chat" to "customers use it", in order, with who does each: the company's agents, or the
board. The engine itself is in `../README.md`; the email service in `email.md`; the privacy assessment the company
writes before launch starts from `dpia-template.md`; the contracts the apps and HQ build against are in `../README.md`
("The order endpoint each app adds") and `api.md`.

Talking to customers is public, so switching the chat on in an app is the board's call (an approval on the desk
phone), like any launch. Everything before that can be built and tried without it: locally, and on the preview, where the chat is behind the
board's login.

## 1. The plug-in (the company)

Copy the template's plug-in, `template/products/care/`, to `products/care/` and make it the company's
(`../README.md`, "The plug-in"):

- `care.ts`: at least `model` (one the ledger's price table knows), `company`, `sender` (an address on the company's
  own mail domain: `email.md`), `timeZone` (the same as `company/org.yaml`'s) and `busy.aim` (the working days a
  person's reply aims for: one the board really meets, since the board answers those emails). `instructions()` if the
  engine's generic helper doesn't fit the business (it talks about orders and parcels).
- `public/plugin.js`: the helper's name, its languages and words, and **the health-detail lists**
  (`health-<lang>.js`). The server won't start without them (or `health: false`, on purpose). The list is the only
  thing that keeps a health detail from the model (`dpia-template.md`, "The health-detail check"), so write it for the
  words this company's customers will really type, and test it phrase by phrase with `healthTerm()`.
- `kb/`: the knowledge base, one question per file (`template/products/care/kb/README.md`). It goes into the cached
  part of every model request, so keep it short.
- `demo/demo.mjs`: an invented customer and order in the company's words, so the harness and the widget check run on
  them.

Put the part of `sender` before the @ in `company/brand.yaml`'s `care.inbox`. The service's emails set no reply
address, so a customer's reply comes back to the sender. Only an inbox address turns that reply into a Care card.
Otherwise it lands in HQ Mail.

Try it locally, with nothing exposed: `node platform/care/demo/shop.mjs` runs the plug-in on a stand-in model, and
`node platform/care/demo/widget-check.mjs` checks the widget in a real browser. Both read `products/care/` by default.

## 2. Each app that gets the chat (the app's owner)

- **The order endpoint**: `POST /api/care/match`, `/orders` and `/ref`, checking `Authorization: Bearer $CARE_TOKEN` in
  constant time, answering the minimal `View` (`../README.md`, "The order endpoint each app adds"). Never the full
  address, never a personalisation that is health or other special-category data.
- **The widget**: `<script type="module" src="./__care/widget.js"></script>` and a Help link with `data-care` (or the
  plug-in's `names.opener`). The theme: the five `--care-*` properties on the element.
- **Telemetry for the bug report**: `<script type="module" src="./__care/telemetry.js"></script>` early in the page's
  head, so errors from before the chat opens are in the log; `track(name, data)` from the same URL on the app's key
  steps (only the shared keys survive: `api.md`, "The bug report"); `data-no-snapshot` on anything private the
  picture must leave out. Form fields are always masked.
- If the app's pages have a Content-Security-Policy, it must allow the widget's script and its same-origin requests.
- `care: true` in the app's `product.yaml`. It does nothing until the service itself is deployed (step 3).

## 3. The service on the server (the company)

- `products/care/product.yaml` (a name, `status: preview`, `platform: true` so HQ lists it under Platform, and
  `memory: 384m` if claims with photos are on: a photo's decode needs room). With it on main, `infra/products.py`
  builds `platform/care/Dockerfile` with the plug-in and runs it in its own container, with its own SQLite volume and
  a network only Caddy joins (`infra/products.md`, "The support chat").
- `company/infra.env`: `EMAIL_SERVICE=lettermint`. Without it HQ's own sender stays off, and the board's replies from
  HQ's Care app fail (live mode refuses to send). `CARE_COOKIES` only if the company wants its own cookie name (the
  last one must start with `__Host-`; without it the cookie is `__Host-care`).
- `company/brand.yaml`'s `care:` section for HQ's side: the sign-offs (one for replies the AI helped draft, one for a
  health case no AI touched), the reply time it counts by (the same as the plug-in's `busy.aim`), the caps Care ›
  Numbers measures against (`numbers.cap`: the service's month cap and the console's limit, below).
- **Who investigates a customer waiting on a person**: `company/org.yaml`'s `roles.care`, an agent with a seat, and
  `brand.yaml`'s `care.investigate.brief`, the company's part of that job's brief: where its own records are (orders,
  the emails it sends and their logs, the code and files of its products, its known problems, what it may offer). The
  method is the platform's (`platform/coordinator/src/care-tickets.ts`): the board then gets a reply worth sending, or
  a decision on the desk phone, instead of a templated draft. Without the role, cards get the care service's draft
  alone.

**A preview's chat is for the board and tester invites.** On a preview host `/__care/*` is behind the board's preview login, like the
product's pages, so merging the plug-in and an app's `care: true` doesn't open the chat to whoever finds the preview's
address: it's where the board tries the chat with test orders, and where the people on a tester invite use it as customers
do. Another outside reviewer's share never reaches it. Only `/api/care/<name>`, the order endpoint the service
calls, is outside the login there (the app checks `CARE_TOKEN` itself). The chat is public only on a public app's live
host (step 5). On a preview the model's tool calls are kept a week for the eval (`toollog.ts`), and the preview is an
app of its own in the ledger, with its own day cap. Until the model key is in, the chat shows the outage card, which
still takes an email to a person.

## 4. What the board does (each one a desk-phone card)

One card per thing, each with the steps written out and the recommendation first (the board-requests playbook):

1. **The email service** (`email.md`): a Lettermint account in the company's name, the sending domain added and
   verified with the DNS records in Cloudflare, a project with tracking off, and its token saved as
   `CARE_EMAIL_API_KEY`. The same key sends HQ's own email (the board's replies, codes). The chat must not go live
   before email works: sign-in codes, copies and every promise of a reply depend on it.
2. **The model key** (below): an Anthropic API key from a console workspace of its own, with a monthly spend limit,
   saved as `CARE_ANTHROPIC_API_KEY`. Until it's in, the service is "model down": the outage card, with a person a tap
   away.
3. **The legal pages and the privacy assessment**: the company's DPIA, completed from `dpia-template.md`, and the
   privacy page's paragraphs on the chat (what it collects, the processors, retention, the bug report's consent, the
   automatic decisions if the plug-in makes any). The board doesn't read the assessment to approve it; it approves the
   launch the assessment says can go ahead.
4. **The launch**: an approval for the chat on that app, once it has been tried on the preview with test orders.

Keys reach the service's container as soon as the board saves them: the server's sync redeploys it when a `CARE_*` key
changes. They go to the care container alone, never to a product or an agent job.

## 5. Preview, then public

- On a preview host the service answers as `<slug>@preview`, behind the board's login, with the app's preview token:
  its only customers are the board and the people on a tester invite, with test orders.
- Once the app is public (`infra/products.md`, "Going public"), its live host gets `/__care/*` too, as `<slug>`, with
  its live token, and **that is when customers can use the chat**: so the chat's approval and the legal pages come
  before an app with `care: true` goes public, or `care: true` waits until they're in. The preview door then has a
  test-mode container of its own with the preview token, so the board's lookups from the preview find its test orders
- The legal pages change the day the chat goes live on an app.

## The model key

The service calls the model provider with its own pay-per-use key, never a seat's subscription: on an API key the
provider is the company's processor for the chats; on a seat it isn't (`dpia-template.md`, "Processors").

- **A workspace of its own, with a monthly limit.** The board makes the key in the provider console's own workspace for
  the chat (Anthropic: Console › Workspaces › a new one, say "Care"; its Limits › a monthly spend limit), and makes the
  key in that workspace. The console's limit is the hard stop; the service's own caps stop it just short of that
  (`CARE_CAP_MONTH`, €19 by default, under a €20 console limit). Set `numbers.cap` in brand.yaml to the two numbers so
  Care › Numbers shows the month against them.
- **Why its own workspace**: the desk phone can tell a key's kind from its shape (an API key, not a seat's token or an
  admin key), but never whether a key is capped. The cap rests entirely on the workspace the board made it in. A key
  from the default workspace has the whole account's limit.
- **An eval key apart.** If the company runs the chat's eval in agent jobs, that key (`ANTHROPICEVAL_TEST_API_KEY`) is
  a second key in a second capped workspace: it reaches every job, so it must never be the chat's. The desk phone
  refuses the same value for both.
- **The organisation.** The provider account is created as an organisation in the company's legal name and address
  (that decides the contract party and the processor terms), with nothing switched on that lets the provider use the
  data for training, and no feedback ever sent on a customer conversation.
- Over a cap, the chat shows the outage card without blaming the AI service, and "Email a person" stays on it (in the ⋯
  menu, with `chatFirst`).

## What it costs

- **The model**: a few cents a conversation (the instructions and the knowledge base are cached; a conversation is a
  handful of answers of one or two calls each). The service's caps by default: €19 a month for every app together, €2
  an app a day, and one person's for the company's day: €0.50 and 60 calls a conversation, and before any check €0.15 a
  session and €0.60 an address. All of them can be set
  in the environment (`CARE_CAP_*`, `../README.md`). Drafts for the board and summaries are a cent or so each. Care ›
  Numbers shows the spend.
- **Email**: Lettermint's free plan covers building and testing (300 a month, one domain); a shop needs its smallest
  paid plan before launch, with overages off so the bill can't grow (`email.md`).
- **The server**: one more small container on the existing server.
- **The board's time**, the real cost: every email to a person is read, edited and sent by the board in HQ's Care
  app.
