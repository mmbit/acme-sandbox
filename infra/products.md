# Products and deploys: what `infra/products.py` does with a manifest

The platform deploys products from their manifest: nobody writes deploy scripts per product. On every deploy,
`infra/products.py` turns each `products/<slug>/product.yaml` that has an `app/Dockerfile` into a container and a Caddy
site with automatic HTTPS, and writes `infra/generated/products.yaml` (extra Compose services) and
`infra/generated/products.caddy` (the sites). `<zone>` below is the domain of HQ's host (`infra/host`). A host named
for the server's IP (`<ip-with-dashes>.sslip.io`, a company without a domain) has no zone: no product is served, and the
deploy says so in one line, until `infra/host` is `hq.<domain>`.

## The manifest

```yaml
name: Example                   # HQ's Apps lists it; the comment's opening line above it is its description there
domain: null                    # its own domain, outside <zone>, once the board has bought it
status: preview                 # preview | test | live (live needs the board's approval record)
project: example                # required for a public product: HQ puts its repair jobs in this open project
needs:
  database: sqlite              # none | sqlite
  secrets: [printapi, stripe]   # the gated tools the app may call, by name
  keys:                         # optional: the product's own keys, made on the server (below)
    EXAMPLE_SIGNING_KEY: { kind: p256, ring: EXAMPLE_PUBLIC_KEYS }
    EXAMPLE_SEALING_KEY: { kind: random-32 }
partner_env: test               # test | live, for the partners' environments
memory: 256m                    # optional: 256m (the default) up to 512m
care: true                      # optional: the support chat on its hosts (below)
engine: care                    # optional: a care deployment, the platform's engine with this folder as plug-in (below)
chat: true                      # optional, with engine: care: the deployment that serves the shops' chat
callsAtOnce: 2                  # optional, with engine: care: the voice line's cap on its calls at once (2 by default)
platform: true                  # optional: a piece of the platform, listed apart in HQ's Apps, never a site of its own
script_floor: report-only       # optional: only reports the script rule
watch:                          # optional: HQ's watch on the live app (the coordinator's watch.ts)
  checkout: api/ready           #   a path under its address that answers 2xx itself when a checkout could start, making no order
```

- A slug is lower-case letters, digits and dashes; a folder starting with `_` is skipped (a template), and HQ's own
  labels (`hq`, `www`, `mail`, `preview`, `cycles`, HQ's host name) are reserved, and so is any slug starting `try-`:
  `try-<n>.preview.<zone>` is a try's version's staging preview, behind the board's preview login, which the coordinator
  serves from the version's own files (HQ's screens in dev mode, a deck) and removes with its branch. One site, the
  catch-all, takes every host no other site names, its certificate fetched on the first visit once the coordinator says
  it's a version that's there (the Caddyfile's `on_demand_tls`). Never a `*.preview.<zone>` site: Caddy gets no
  certificate of its own for a host a wildcard site covers.
- `domain:` must be a plain host outside `<zone>` that no other manifest names; anything else is ignored.
  Point its DNS record at the server before setting `domain:` on a public product, or before the product's first
  `site:` or `live:` Approve. Its shelf and old address send page loads there from the next deploy.
- An unknown `status` is served as a preview; a `memory:` out of range gets 256m. The deploy log says why.

## What every product gets

- A container (256 MB unless `memory:` asks for more, half a CPU, its own `/data` volume for SQLite) on a Docker
  network of its own that only Caddy joins: no coordinator, no worker, no other product.
- A product's `/data/backup/` goes in the nightly off-site backup: put consistent copies there (SQLite's backup or
  `VACUUM INTO`, written under another name and renamed), never live database files. The rest of its volume isn't
  backed up. A `.part` file and its SQLite `-journal`, `-wal` and `-shm` sidecars are left out as a copy still being written. Every product's together add at most the
  company's `BACKUP_PRODUCTS_MB` (`company/infra.env`, in MB compressed) to a night's archive, and none go without it.
  One that would pass it, or whose copies can't be read, is left out whole that night, and the board hears. The archive
  holds it as `products/<slug>/`, and the restore drill checks each `.db` in it.
- Its environment: `PRODUCT`, `STATUS`, `PARTNER_ENV`, `SHOP` (`open` or `closed`), `PORT=8080`, `DATA_DIR=/data`,
  `HQ_ORIGIN` (HQ's own origin, which apps can allow in their preview framing policy),
  the counting token for HQ's Numbers (`METRICS_*`, live for a public site, preview otherwise), and for each tool in
  `needs.secrets` its keys for the `partner_env` under the stack's names (a partner's `<TOOL>_TEST_<NAME>` key from the
  desk phone becomes `<TOOL>_<NAME>`). `stripe` never gives the Stripe key: it gives a payments token for HQ's
  payments tool, for this slug and mode. `anthropiceval` gives the jobs' test model key (`ANTHROPICEVAL_TEST_API_KEY`,
  under its small spend limit) as `ANTHROPICEVAL_API_KEY`, on test partners only: it has no live name, so a live
  container gets none. Keys reach the container single-quoted in an env file,
  so Compose takes them literally; one with a quote or a line break is skipped. A Print API or model key saved on the
  desk phone redeploys within a minute, like an approval. And the shop's dated offers, `SHOP_OFFERS`:
  when the front's manifest names a JSON list in its own folder (`offers:`), every other
  product gets it as one compact line, so a product sold in the shop charges an offer's price on the days the shop's
  pages show it. A file that isn't a JSON list inside the front's folder is left out, and the deploy log says so.
- Its own keys, when `needs.keys` names them. Nobody types or sees them: the
  deploy makes each key the first time a container needs it, keeps it in the coordinator's data volume
  (`product-keys/<slug>/<mode>/`, root's alone, in the nightly backup, kept when the company starts over) and puts it
  in the container's env file. Each mode has its own: a public product's preview door never holds the live key, so a
  test order can't sign anything the live app accepts. A key's name starts with the slug's (`EXAMPLE_` for `example`,
  dashes as `_`), so it never shadows a name the platform sets. The kinds:
  - `random-32`: 32 random bytes in base64, for sealing data (`Buffer.from(value, 'base64')`). It never changes:
    what it sealed would be lost.
  - `p256`: an ECDSA P-256 private key, PKCS8 DER in base64 on one line (an env file holds no line break):
    `createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' })`. Its `ring` names a second
    variable, a JSON list of the public JWKs of the keys it replaced (`[]` at first), so what an old key signed still
    verifies. To rotate it, raise its `generation:` (1 by default) in the manifest: the next deploy makes a new key and
    adds the old one's public half to the ring. Rotating needs a ring.

  A key is never deleted or replaced otherwise. A lower generation or another kind keeps the key there is, and the
  deploy log says so. The log names a key that was made or rotated, never its value. A broken entry is left out, and
  the log says why. Without HQ's data (a run on your own machine) the deploy makes none.
- A preview at `<slug>.preview.<zone>`, behind the board's preview login (HQ checks the board's preview key; product
  code never sees it or the board's HQ session), with the board's review mode (`/__review/*`). The preview door stays
  when the product is public, in front of a test-mode container of its own then (below), and marks its requests
  (`X-Preview-Door`). Every product host also tells the product which requests are our own visits, which its counts
  skip (`X-Own-Device: 1`, Caddy's own: a board device HQ marked, or a request from the server itself; the Caddyfile's
  `own_device`). <!-- --> An agent job checks a product's preview with a pass, run as
  `hq preview <slug> -- <command>`: the command gets the address in
  `HQ_PREVIEW_URL` and the cookie in `HQ_PREVIEW_COOKIE`, through its environment alone. For Playwright, split the
  cookie at the first `=` and call `context.addCookies([{ name, value, url: process.env.HQ_PREVIEW_URL, httpOnly: true,
  secure: true, sameSite: 'Lax' }])`.
  It's view-only on that host (no review mode, chat, hand-off, other host or HQ), ends with the job's run or after an
  hour, and the job's log in HQ says who had one for which host; product code never sees it either. On any product,
  `hq preview <slug> --player <name> -- <command>` makes the same pass the run's own test player of that name: the
  product gets an `X-Viewer` of its own (never the board's or a tester's, the same on every pass this run with that
  name, another for another name or run). On a product with plans `HQ_PREVIEW_VOUCHER` is its tester's voucher too,
  one plan once in test mode, up to €50, never a shop basket; elsewhere there is none. In test mode a product asks
  `GET /api/pay/viewer?id=<its X-Viewer>` (its payments token) whether a viewer is the company's own, the board or a
  running job's test player, so it may open what only the company tries there (a test purchase while its sales are
  closed); the answer is `{company}`, never who it is.
- Who is looking, on the preview: every request there carries `X-Viewer`, an opaque id for the board, for one tester
  on a share or for an agent job's test player (above), the same on every visit and different for every product. It's never an email, and Caddy takes a
  client's own copy off every request, so a product can keep what a viewer holds (a plan, a save) against it. Off the
  preview there is none.
- Plans: a product sold by the month or up front names its plans in its manifest (`plans:`, inline or a file in its
  folder), and HQ's payments tool sells them, reads back what a payer holds and stops a monthly one in one call
  (`platform/coordinator/src/payments.ts`'s header has the endpoints, `plans.ts` the file's shape). The board's tester
  invite opens on its preview then, and each tester's voucher pays one plan, with no card and nothing recurring.

- A link for another device, such as a phone that scans a page's QR code: `linkForAnotherDevice(link)` from the kit
  `/shared/handoff/handoff.js`. On the preview, a phone without the board's key or a tester's session can't get in. So
  there, the page gets a one-time link (`/__preview/handoff`, checked by the coordinator) that gives the phone the
  page's own access on that host for an hour. Elsewhere the link stays as it is. No product opens a path on its preview
  for this.
- The browser's kits, the sound kit at `/shared/demo/foley.js`, the word check at `/shared/wordcheck/wordcheck.js`,
  the hand-off above, the button that asks once more (`askAgain`, `/shared/ask/ask.js`) and a page's end of the link with
  HQ's notebook (`/shared/notebook/notebook.js`), on all its hosts (behind the login on the preview), served by Caddy from the
  server's checkout, and on the cycles host too. Each is at its path in the repo, so an app imports it by its relative
  path (`'../../../../shared/demo/foley.js'` from `app/public/`): the same import works in Node from the repo and in the
  browser. No app keeps a copy, and a kit change is live in every app at the next deploy. A run from the repo has no
  Caddy: the app's own server serves those paths from the repo.
- Whatever else the company serves the same way, on all its hosts and the cycles host: `SERVED_FROM_REPO` in
  `company/infra.env`, comma-separated paths in the repo. A `*` stands for part of one name (`/<folder>/*.css`: every
  `.css` file directly in that folder), so an entry starts with `/` and never ends with `*`; anything else, no deploy.
  None by default.

## The image


A product's image is built from its own `app/` folder, with three more named build contexts beside it: `kits`, the
company's own kits (`KITS_DIR`, the same setting the coordinator reads, by default the repo's `kits/`), `shared`, the
foundation's filtered tree exported before product builds by `python3 infra/products.py --build-shared`, and
`product`, the product's own folder (`products/<slug>`, the app's parent), for code it keeps beside
its app. The build gets `APP`, the app's folder in the repo
(`products/<slug>/app`). The app's Dockerfile lays the image out as in the repo, so an app imports a kit, or a folder
beside it, by its path in the repo and the same import works in a run from the repo and in the container:

```dockerfile
ARG APP
WORKDIR /repo/$APP
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=kits . /repo/kits
COPY --from=shared . /repo/shared
COPY --from=product engine /repo/products/<slug>/engine
COPY src ./src
COPY public ./public
```

Each product copies all of the `shared` build context that `infra/products.py` configures, so a shared module's new
imports come with it, and development files are excluded before the final image.

The shared context filter lives in `infra/products.py` (`build_shared`). Its Python export needs no Docker builder.

For code beside the app, copy the needed folder from the `product` context to its relative path beside `WORKDIR`.

Every deploy builds every image again, so a fix to a kit reaches every product that imports it. No app keeps a copy of a
kit (`kits/README.md`).

## Going public

Going public is the board's call (an approval on the desk phone). Without the board's approval record for the product,
it stays a preview on test partners whatever its manifest says, and the deploy log says why.

| The manifest | The board's record | What the product is |
|---|---|---|
| anything | none | a preview on test partners |
| `status: live` | `site:<slug>` or `live:<slug>` | a public site **with ordering closed**: `SHOP=closed`, `PARTNER_ENV=none`, no payments token and no partner keys, so every payment and partner call fails. The app must show that ordering opens soon, without those calls |
| `status: live`, `partner_env: live`, `stripe` in `needs.secrets` | `live:<slug>` | public and taking orders |

- A public product is on its shelf at `<shop host>/<slug>/` (the shop host, below), or at its own `domain` when it has
  one, where its shelf sends page loads (below, "One origin, every shelf"), with no preview login and no review mode.
- Live is all of it or none: `status: live` and `partner_env: live` together, the launch record, and payment through
  HQ. `partner_env: live` alone stays a preview; a live product without `stripe` would have a checkout that "pays"
  nothing, so it isn't allowed to take orders.
- Payment providers usually check a company's website before approving its account, so a product that will take money
  can go public first with ordering closed (`site:<slug>`), then launch once the board has the payment keys.
- Once public, HQ watches it (below, "HQ's watch").
- The company's front door, the product `front`, is served at one host only once public: its own `domain` when it has
  one that can be served, else `www.<zone>`. The zone's other hosts for it redirect there permanently, path and query
  kept: the bare `<zone>`, `front.<zone>`, and `www.<zone>` when the front has a domain of its own. These hosts serve
  nothing else, so a front with a domain of its own is never public under the zone's name
 . The bare domain needs one A
  record (DNS only, the server's address); its MX and TXT records are Email Routing's and stay.

## A public product's preview door


Once a product is public (taking orders or closed), its preview door has a container of its own, `preview-<slug>`. So
the board can place a whole test order there with Stripe's test card while the public site takes real orders or none.
The chat's service has none: it's always a preview.

- The same image, memory and hardening as `product-<slug>`, a network of its own that only Caddy joins, its own data
  volume (`preview-<slug>-data`, test orders only, never backed up, not even its `backup/`) and its own env file
  (`<slug>@preview.env`, a name no slug can take).
- `STATUS=preview`, `PARTNER_ENV=test`, `SHOP=open`: a test payments token, the test partner keys, preview counting, and
  with `care: true` a `CARE_TOKEN` for `<slug>:preview`, the token the chat's service uses for `<slug>@preview`.
- `<slug>.preview.<zone>` (its order endpoint included) and the product's shelf on the front's preview door go to it, and
  the front's preview door's own pages to `preview-front`. The public hosts stay on `product-<slug>`. So no public
  container ever holds a test-mode token.
- Its env file goes with the container: when the product is a preview again, or gone. A preview has its one container
  behind its door.

## HQ's watch

The coordinator's `watch.ts` watches every public product from the moment it's public, and runs the daily error scan
(`triage.ts`) and money check (`money.ts`). While none is public, it checks only the email plan (`mailplan.ts`, below):
mail goes out before launch too.
The watch and its alerts run in the coordinator on the app server. So an outage of the whole server, or of the
coordinator, raises no alert: nothing is left to see it.

**Up and able to sell, every 5 minutes.** The watch asks for the product's page at each of its public addresses: its
shelf, or its own `domain` alone when it has one, since its shelf then sends visitors there and would answer the watch's
fetch itself. For a product that takes orders (the last row of the table above), it also asks for its
`watch.checkout` path at each address and asks Stripe whether live payments go through. A site that takes no orders is
checked on its pages alone. A failure at its public address counts, and the jobs say which address fails.
Each request to an app's addresses gets 15 seconds, counted only while the coordinator is free to read the answer.
Time it spends busy on other work isn't the product's.

A product that takes orders but closed its ordering on purpose for now is checked on its pages alone too. It said so in
the last 10 minutes by asking HQ's `POST /api/pay/expire/open` with its live payments token, and asks again within them
for as long as it stays closed. An outage of its checkout still open then ends with a line saying the ordering is closed
on purpose, never that it works again. Once it stops asking, its checkout counts again with no other change.

- Two failures in a row are an outage: a job for the product's `owner`. A page that fails says visitors
  can't open it; a checkout check or Stripe that refuses says nobody can buy it. The two are counted apart, each with
  its own job and alarm: a page that fails leaves the checkout unchecked, so an outage of the checkout stays open until
  the checkout is seen to work. An outage has one job at work at a time: open, or done with its pull request in review.
  One that ends with no fix in review brings a new one only if the outage still fails 30 minutes later, time for a
  merged fix to deploy, and an outage gets 3 jobs at most: the last brings it to the board if it can't be fixed. A job
  for the other outage, if one is at work, is named in it.
- The CEO gets one alarm per outage (the coordinator's `alarms.ts`: an urgent job, and a line in `hq summary` while it
  lasts): at once when ad spend was recorded for the product with `hq spend` in the last 3 days, otherwise after an
  hour. It says in plain words what fails (the page, the checkout or the payments) and what that keeps from people, the
  days ad spend was recorded and who runs the ads: the agent who recorded the spend, or unknown when they're no longer
  on the team. Whether the ads pause, and whether the board hears, is the CEO's call. The check's path and answer go to
  the owner's job only: the CEO and HQ's feed hear what fails in plain words.
- An outage ends once 3 checks in a row see it work. A good check between failures leaves it open, with its jobs, its
  30 minutes and its alarm. Then its alarm ends, and the CEO gets a short job with a line: the page opening again ends
  the page's outage, and the line says whether the product can sell (yes, no, or unchecked). A product that stops
  taking orders ends its checkout's outage with a line saying so.
- Stripe that doesn't answer is no result: the watch neither counts a failure nor a recovery, and says so once in the
  feed. A checkout check that fails meanwhile is no result either, as the checkout may fail because Stripe does. An
  outage of the page still ends when the page opens again, and the line says the checkout went unchecked.
- A product that takes orders without a valid `watch.checkout` is no result either, and a fault of the watch's own: a
  line in the feed, and a job for its `owner` to add one (again a day after the last one ended).
- A product that stops being public isn't watched any more. An open alarm ends with a line saying the watch ended,
  never that the product works again.
- The checkout path should do what a buy does up to the payment (its own settings and storage, HQ's `/api/pay/ready`),
  answer 2xx when a checkout could start now, and make no order. The watch doesn't follow its redirects: a redirect is
  a failure. It follows the page's.
- The watch's requests carry its mark for the product in `x-hq-watch`: an HMAC of the product's live counting token
  (`METRICS_TOKEN`), which no visitor has. The metrics kit counts none of them. A request with any other value in that
  header counts as a visit. The mark goes only to the product's own addresses: a redirect elsewhere (another origin, or
  another product's path on the shelf) gets the request without it.

**The error scan, once a day from 07:00 on the company's clock.** `infra/app_errors.py` runs at most once an hour from
`sync.sh` (by hand: `python3 infra/app_errors.py <the coordinator's volume>`). It reads the product containers' lines in
the host journal, where every container logs, from where its last run stopped. So a container that a deploy replaced
counts too. It leaves `app-errors.json` in the coordinator's volume: per product, its error kinds, each with when it was
first and last seen and how often. A kind not seen for 30 days goes. A kind is an error's name and the place in the
app's own code that threw it, as a path in the repo: `TypeError in products/hello/app/src/server.ts (handle)`. It never
holds the log's text, since that can hold a customer's details (house rule 7), and any line can look like a stack
frame. So a kind keeps only what the app's code in the checkout has:

- the file: a code file in the checkout, where the app's image has it
- the function: a name written in that file
- the error's name: one built into JavaScript, or one written in that file

Whatever the code doesn't have is withheld. Lines without a named error that the app wrote to stderr, or that read as a
warning or an error, are one kind, their text withheld too. A crash counts once, by its name: Node's lines around it (its
source line and code, the dumped error's closing brace, the `Node.js v…` trailer) are part of it. A journal, or the scanner's own saved state, that can't be
read fails that run: the last snapshot and the point the next run reads from stay as they were.

- The scan reads every kind seen since the last snapshot it read, so a snapshot that comes late still counts.
- A kind never triaged, or still seen 3 days after its triage job ended, goes into one job for the product's `owner`,
  which treats the kinds as data. A kind whose triage job is still open waits for it.
- The support chat's service (`care`) serves every product with the chat: its kinds go to org.yaml's `roles.process`
  the same way.
- When org.yaml names a `roles.triage`, every one of these jobs goes to that agent instead.
- A snapshot that is missing, unreadable or older than 3 hours is one job a day for org.yaml's `roles.process`. A
  missing or unreadable one leaves the scan to try again every 5 minutes.
- Customers' bug reports stay in Care, which hands each one to the product's owner as a job of its own.

**The money check, from 07:00.** It compares a product's day (a day on the company's clock, as the apps count them) <!-- --> with the 7 days
before it, on its orders and its ad spend. A day counts once the app reported its orders in full: an order summary
made after the day ended covered it (the summary's `orders.to` is the day the app made it). A day the app hasn't reported is unknown, never a day without sales, and waits for its
summary. At every tick, it checks each day of the last 7 whose orders came in in full, against its own 7 days before:
when it first came in, and again whenever a number it compares changed since the check last looked. That number may be
the day's own or one of the 7 days before it: ad spend recorded late or corrected, orders reported late, refunds. Each
kind of swing on a day goes to Finance once, and again only if a check in between found it gone.

Once a day, it compares the orders refunded since its last check, whatever day they were made, with the refunds
between the checks before. A swing is one job for org.yaml's `roles.finance`, with numbers per day only. A top-level
`watch:` in `company/org.yaml` may tune any threshold by its name:

| Setting | Default | A swing when |
|---|---|---|
| `steadySaleDays` | 5 | (with the next two) sales on at least this many of the reported days before make them steady |
| `salesChance` | 0.01 | so few sales, or none, after steady ones, had at most this chance at the daily average before (Poisson) |
| `orderValueShare` | 0.5 | what a kept order brought in fell to at most this share of what one brought in before |
| `refundsAtLeast`, `refundsTimes` | 3, 3 | at least this many orders refunded since the last check, and this many times the daily rate before |
| `unpaidOrdersAtLeast`, `unpaidShareRise` | 5, 0.25 | this many orders on the day, with the share not paid up by this much |
| `spendTimes` | 1.5 | ad spend this many times the daily average, with sales no higher than before |
| `spendDays` | 5 | (with `spendTimes`) ad spend recorded on at least this many of the days before. A day without a record is unknown, never 0 |
| `firstSpendEuros` | 15 | ad spend of at least this many euros on a day after none (no record, or records of 0, on the 7 days before), with sales no higher than on the reported days before. With no reported day before, the sales go uncompared |

The apps push their orders' last 60 days, so a refund on an older order doesn't show.

**The email plan's check, once a day from 07:00**. An email plan with a fixed
monthly quota refuses mail past it: codes, receipts and the board's replies would never arrive. So the watch adds up the
emails the email service took in the calendar month so far, on the company's clock:

- HQ's own: every email that goes through `mailout.ts` (the board's replies from Care and its business mail, order and
  basket emails, guests' codes). It counts each recipient, copies included, once the service took the email, per day in
  `mailout_days`. Never an address or a subject.
- The support chat's: the `emails` in each app's day counts, live and preview (`care_numbers`). Today so far counts
  once, and the finished day replaces it.

When they reach `watch.emailsPerMonth` in `company/org.yaml`, org.yaml's `roles.process` gets one job with
the month's count, HQ's part and the chat's, and the limit: the plan should move up before mail is refused. One job a
calendar month at most. The check runs whether or not a product is public. Without `emailsPerMonth`, it checks nothing.
Set it below the plan's quota, with room for the days before the check sees the count (the chat's day comes in once
it's over).

## One address for the shop

One shop at `www.<zone>`, or at the front's own domain once the front is public there (above): the shop's host. The
hosting part:

- **Shelves.** Every public product other than `front` is at `<shop host>/<slug>/`, from its own container as before.
  Caddy takes `/<slug>` off the path, so the app sees the paths it always did, and tells it its prefix in
  `X-Forwarded-Prefix` (`/<slug>`; Caddy's own, a client's copy never gets through). An app builds the links back to
  itself from that header (Stripe's return page, emails) and writes every other address relative (`./api/...`).
  `/<slug>` without the slash redirects to `/<slug>/`. A product's slug takes that path on the shop's host, so the front's own
  pages never use a product's slug as a path.
- **The old address** `<slug>.<zone>` sends page loads to the shelf with a `301` (same path and query): a GET or HEAD
  that the browser marks as a navigation (`Sec-Fetch-Mode: navigate`), or one outside `/api/` and `/__care/` from a
  client that marks nothing. Everything else keeps working there until it ends: an open chat, a checkout's POST, a
  page's fetch from before. A product with its own `domain` has its old address send them straight there. That domain
  stays a site of its own, without the redirect.
- **The front's preview door** `front.preview.<zone>` has every product as a shelf (not the chat's service, and not
  `platform: true` pieces), behind the board's login, so the board walks the whole shop before it's public. A product
  with its own domain stays a shelf there too: the door holds only the board's test data, from preview containers.
  Review mode works on every shelf there: a shelf's `/<slug>/__review/*` goes to the coordinator, which files the note under
  that product with the page's path on it (`feedback.ts`). `shared/review/review.js` posts next to where it was loaded
  from, so an app loads it by a relative address too.
- **What the front lists.** Each of the front's containers gets `SHELVES`, the slugs of the shelves on its host,
  comma-separated: on the shop's host the public products', on its preview door every product's. The front lists only those, so
  a product shows in the public shop once the board's record puts its shelf on the shop's host, never before. The
  shop's host's container also gets `SHELVES_CLOSED`, those of its shelves that take no orders (a public site with
  ordering closed, below), so it never offers to sell what that shelf won't take.
- **The look switch.** Every request to a product carries `X-Look` from Caddy: `next` on every preview door, and on
  the public hosts once the board has approved the product's launch (`live:<slug>`); `today` before that. A public
  product stages its next look behind it and shows it when `X-Look` is `next`. The Approve card says "the site as its
  preview shows it". The front's shop look waits on `live:front`, the shop's one Approve.
- **The security floor**, on every public host and on the front's preview door (not on other previews):
  `Content-Security-Policy: script-src 'self'; object-src 'none'; base-uri 'self'` (scripts only from the host's own
  files: no inline script or `on...=` attribute, no eval, no other site's script; inline styles are fine),
  `X-Content-Type-Options: nosniff`, and every SVG answer gets `Content-Security-Policy: sandbox`, so an SVG opened as
  a page runs nothing. An app may add its own stricter policy: both apply. A product whose pages still run an inline
  script says `script_floor: report-only` in its manifest: on its own pages (on every host and shelf they're served
  from) the script rule then comes on its own as `Content-Security-Policy-Report-Only: script-src 'self'`, and the
  rest stays enforced (`Content-Security-Policy: object-src 'none'; base-uri 'self'`). Without the key
  (or with any other value, which the deploy log names) the rule is enforced. It's a stopgap: the product moves its
  scripts into files before its launch and drops the key.
- **A PDF in HQ's viewer saves.** On every preview host, a PDF that loads as a frame's page (`Sec-Fetch-Dest: iframe`)
  gets `Content-Disposition: attachment` (an app's own name kept, `inline` turned `attachment`): Chrome shows no PDF in
  the viewer's sandboxed frame, only a blocked page, and the frame allows downloads. A page needs no `download` on its
  PDF links. A PDF in a tab, or on a public host, is as the app sent it.
- **One origin, every shelf.** The floor keeps injected and outside script away, but every shelf's own script runs on
  the shop's origin and can reach the shop's chat with the customer's cookie. So: no third-party script in any app,
  and **an app never serves a customer's upload back as HTML** (or any type a browser runs): uploads go back as the
  image or PDF they were checked to be, with their own type and nosniff. No app does otherwise today. The shelves also
  share the chat's one `__Host-` cookie (`Path=/`), and so one chat session: the shop's, which Caddy names in
  `X-Care-Shop` (below). Every other
  cookie of the shop's host reaches every shelf too (Caddy strips only `pv` and the chat's): an app sets none, or scopes
  its own with `Path=/<slug>/` and a name no other app uses. No app sets one today.
  The floor's rules cover scripts and cookies, not the rest of what a browser keeps per origin: `localStorage` and
  `sessionStorage`, IndexedDB, Cache Storage and service workers are shared by every shelf too, whatever their path.
  One script-running mistake in any app on the shop's host reads what another app keeps on the buyer's device there.
  It can also rewrite that app's offline release, whose service worker reads the cache first. The injected code then
  stays in that app on that device. **A product that keeps private data on the device has a domain of its own**
  (`domain:`). Its shelf sends page loads to that domain with a `301`, keeping the path and query so the shop's links
  still work. A worker the shelf installed before may answer page loads from its cache, so they never reach the `301`.
  But the browser asks for the worker's script again after such a load, and the shelf answers any worker script with
  one that retires it, whatever scope the app gave its worker: it takes over, unregisters and sends the shelf's open
  pages to the same path on the domain. A new registration on the shelf ends the same way. It deletes nothing the app
  kept on the shop's shared origin. The platform provides no way to migrate or clear that data after the move. A
  product that keeps data on the device gets its domain before its first `site:` or `live:` Approve. Other requests
  keep working on the shelf until they end, as at the old address: an open chat, a checkout's POST or a page's fetch
  from before. Its old address sends page loads straight to its domain.
- **Before a product's first `site:` or `live:` Approve** its app works on a shelf: every address of its own relative
  (`./app.js`, `./api/...`), no inline script (or `script_floor: report-only` until there is none). A root-relative
  `/app.js` on a shelf is the front's 404. Today's previews still have both. Review mode is only at the shelf's top
  (`/<slug>/__review/`): a top-level page loads `./__review/review.js`, a page deeper down builds it from
  `X-Forwarded-Prefix` (`<prefix>/__review/review.js`, or `/__review/review.js` without one) or climbs with `../`.
- The chat's service reaches a public app at `https://<shop host>/<slug>/` (or its own domain) and resolves
  `./api/care/<name>` against it (`platform/care/src/apps.ts`).
- Payments takes a shelf as a return address on the product's own path only (`knowledge/notes/platform/payments.md`);
  an order email's `{site}` is then the shelf's top, `https://<shop host>/<slug>` (`ordermail.ts`).

## The support chat (`care`) and the care deployments

- **A care deployment** is a product whose manifest says `engine: care` (`infra/care_engines.py` reads them; run, it
  prints their slugs, and the server's sync makes their phone tokens from that list). It isn't built from an `app/`
  folder: it's the platform's engine, `platform/care/Dockerfile` from the repo's root, with its own folder as the plug-in
  (the `PLUGIN` build argument, `products/<slug>/`), deployed when the platform has the engine. Each has its own
  container, data volume and network, the model's and the email service's keys from the desk phone
  (`CARE_ANTHROPIC_API_KEY`, `CARE_EMAIL_API_KEY`, which reach the deployments alone), the credit (`CARE_CREDIT_*`)
  and a phone token of its own. The server's sync redeploys them when one of those keys changes. One that isn't the
  chat's takes its calls' shop from its own slug (`CARE_PHONE_SHOP`): it has no shops' apps to take one from.
- **The service** is the deployment with `chat: true` (at most one: with more, no deploy; without one, no product gets
  the chat). It gets the line to HQ (`CARE_HQ_URL`, `CARE_HQ_TOKEN`), which no other deployment does: HQ's Care app
  has one queue of cases, drafts and redrafts, numbered by the deployment that files them, so one deployment owns it.
  It also gets `CARE_APPS`, `CARE_TOKENS` and `CARE_NAMES` (every opted-in app's address, token and name), `CARE_SHOPS` (each
  shop's apps, below) and its cookie's name (`CARE_COOKIE`: the last of `company/infra.env`'s
  `CARE_COOKIES`, always `__Host-`, or no deploy). Another deployment answers phone lines only.
- **The phone**: Caddy's inside port, `http://:8081` (Docker's network only, never published), passes each
  deployment's `/<slug>/phone/*` to its port 8081 as `/phone/*` and answers anything else 404. The voice line gets
  `CARE_ENGINES` (JSON: each slug's `url`, `http://caddy:8081/<slug>`, `calls`, its `callsAtOnce`, a whole number
  from 1, 2 when it names none, else no deploy, and `token`, the name of the variable its token is in, which
  `care_engines.py` makes) and each deployment's token in that variable, which that deployment gets as
  `CARE_PHONE_TOKEN`. Compose fills them in from the sync's environment (one file per deployment,
  `/etc/<server>/care-phone-<slug>-token`), so no other container and no file in the repo holds one. Without a
  deployment there's neither.
- **An app with `care: true`** gets `CARE_TOKEN` (an HMAC for its slug and mode: live once it's public, preview
  otherwise, its preview container's included) and `/__care/*` on its hosts, proxied to the service, with Caddy setting `X-Care-App` (`<slug>`, or
  `<slug>@preview` on the preview host; every site strips a client's copy). On the preview host the chat is behind the
  board's login like the product; on a public app's live host it's open to customers. `/api/care/<name>` (exactly that
  spelling) goes to the app outside the login on both: it's the order endpoint the service calls, and the app checks
  `CARE_TOKEN` itself. The service's cookie and the board's preview key never reach a product.
- **One session per shop**. Caddy also sets `X-Care-Shop` (a client's copy
  never gets through): `front` on the shop host's shelves, `front@preview` on the front's preview door's, and the app itself on
  any other host (a shop of one). `CARE_SHOPS` lists each shop's apps with the chat, so a checked customer's orders
  come from all of them; the shop's name in `CARE_NAMES` is the front's. With `care: true` the front has the chat on
  its own pages too (the shop's host as `front`, its door as `front@preview`). It has no orders, but it gets a
  token and its `/api/care/*` like an app (in `CARE_APPS` at the shop's root), for what the helper does in the shop's
  own basket.
- The steps in order, the company's and the board's: `platform/care/docs/switch-on.md`.

## Tests

`infra/test_products.py` (the manifests, approvals, tokens, keys and networks, also in Compose's own rendering with
`DOCKER_COMPOSE`) and `infra/test_caddy.sh` (the generated sites in a real Caddy: forged headers, cookies, the login,
the chat's stream).
