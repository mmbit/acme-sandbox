# Metrics

Counting for a product app (`metrics.ts`): page loads and funnel steps tallied in memory, sent to HQ every few
minutes, with a daily summary of the app's orders. An app imports it by its path in the repo and keeps its own
`app/metrics.json` (the steps, funnel, dashboard and A/B tests: the coordinator's `metrics.ts` reads it).

```ts
createServer((req, res) => metrics.serve(req, () => handle(req, res))); // counts nothing from the board's preview door
metrics.setup({ file: new URL('../metrics.json', import.meta.url), label: campaigns.label, orders: () => [...] });
const clean = metrics.cleanUrl(req.url); // the address without ad click IDs (fbclid, gclid…), or null: redirect to it
const v = metrics.page(url, req.headers.referer); // a person's page load, with the app's label and a freshly flipped version
if (v) html = metrics.mark(html, v); // <html data-ab="name-first:B"> while a test runs: the page sends it with the order
metrics.count('order', { country, variant: metrics.variant(body.ab) });
// An app's own per-page counts: a load that isn't a person's ('agent-gptbot', 'agent-other', 'prefetch'), or the
// assistant that sent the visitor ('ai-chatgpt'), null for anyone else.
const by = fetchedBy(req.headers), sentBy = aiReferral(req.headers.referer, url);
```

## Counts, not people

Charter rule 7: nothing is stored on the visitor's device, and nothing is read from the request but what the app
needs, plus the referrer host: its class on every page load (`loadSource`, below), and the engine's name on the page
load itself when `searchReferrers` is on. A count is a number per day, step, page version, campaign,
country and "what" (the theme or pack), never a row per visitor. No IP, no browser details (the day's visitors, when
they're counted: below).

- `searchReferrers: true` opts into `search-<engine>` for unlabelled page loads. Only recognised HTTP(S) hosts become
  engine names. The full referrer stays in the request, never in a count, returned value or log. Off by default.
- `orderCampaigns: true` also lets `mark()` expose `data-campaign` for a same-visit checkout. Validate the returned
  source with `orderCampaign()`. Keep it only in memory or a link fragment in the browser, never in analytics storage
  or cached HTML. Enable it only once the app's privacy notice describes this use and stored sources expire on
  schedule.
- An order's source is someone's: the app clears it `SOURCE_DAYS` after the order, or at once when the buyer objects,
  and the next summary carries that to HQ. A source goes with page loads and the order summary only, never with
  another step's count, which HQ can't take back.
- A page load's source can point to a buyer too, on the app or a site that links to it, and isn't the app's to clear.
  An order marked `objected` (its buyer objected to its source counting) has HQ drop the source of every page load in
  that mode through the order's day, and HQ drops page sources `SOURCE_DAYS` old itself.

## People, not machines


Inside `serve()`, `page()` counts every load as the step `load`, with where it came from as its source, and counts only
a person's as `page` (and `visitor` and `visit`). A load that isn't a person's answers null (`fetchedBy`):

- `agent-<name>`: a crawler or fetcher by its robots token (`crawlerName`'s list: OpenAI's, Perplexity's, Anthropic's,
  Bing's, Google's, Apple's and Meta's five), or `agent-other` for any other user agent that says it's a bot (a name
  ending in bot, crawler or spider, or a `+https://` link to its page), an HTTP library or headless browser (curl,
  python-requests, Go-http-client…), or none at all.
- `prefetch`: a load ahead of a tap that may never come (`Sec-Purpose` or `Purpose` with prefetch or prerender, Meta's
  apps' `X-Purpose: preview`). A tap after one shows the page it fetched without a load of its own, so a person who
  came that way isn't in the page loads: the prefetches are the most such taps could be.

A person's load comes from `stall` (the app's own pages: a reload or a step inside it), `shop` (the shop's other pages,
on a shelf's host), `ai-<assistant>`, `search-<engine>`, `meta` (Facebook's and Instagram's sites and link hosts),
`other` (any other site) or `none` (no referrer) (`loadSource`). Only the class is kept, never the address, and it's a
page load's source like any other in HQ (dropped after `SOURCE_DAYS` and through an objected order's day). It doesn't
need `searchReferrers`, which puts the engine on the page load itself, where it travels on to the order.

## On the server

The platform gives the container `METRICS_URL`, `METRICS_PRODUCT`, `METRICS_MODE` (`live` for a public site, `preview`
otherwise), `METRICS_TOKEN` and `METRICS_TIME_ZONE` (`infra/products.py`). Without them (a run on your own machine)
it counts in memory and sends nothing.

A live product's preview door (the board's, behind its login) reaches the same container. Caddy marks those requests
with `X-Preview-Door` and strips the header from public ones, and a live app counts nothing they do, so the board's
and the team's visits never mix with real ones. Their orders are real orders, in the order summary. Caddy also marks
our own visits on the public hosts with `X-Own-Device: 1` (the board's devices, which HQ marks as it signs in, and the
server's own requests: a job's check), and a live app counts nothing of those either.

## Visitors and visits

With `METRICS_VISITORS=1` on a live product (company/infra.env's switch, `infra/products.py`), `page()` also counts
the steps `visitor` (the first page load today of an internet address and browser) and `visit` (one after 30 minutes
without), each with the page load's source, the one its visit landed with. They're built in: no app lists them in
`metrics.json`. An app with counts of its own asks `metrics.visit(req)` instead.

The method is Plausible's (`visitors.ts`). The address Caddy saw and the user agent go through an HMAC with a random
salt made at midnight on the company's clock. Only 22 characters of it (132 bits) are kept, with the time of the last
load, in memory and in `DATA_DIR/visitors.json` (never the volume's `backup/` folder, so no backup holds them), saved
every 15 s and on SIGTERM. At the next midnight the salt and the list are replaced, so no past day's salt is kept and no
one is followed from one day to the next. A household behind one address with one browser counts once, a phone moving
from Wi-Fi to mobile data twice. Nothing is read from or stored on the device, and a load that isn't a person's (a
crawler, a fetcher or a prefetch: above) is neither.

## Core Web Vitals in the lab

`lab.ts` loads a page on a throttled phone and holds its LCP and CLS to Google's "good" lines and its TBT to
Lighthouse's 600 ms "poor" line (`CHECKED`), for a product's tests to catch a slow change before it ships, and for a
look at the live pages.

```ts
test('…', { skip: lab.missing }, () => lab.checkPages(`http://localhost:${port}`, ['/en/', '/nl/']));
```

```sh
node --test src/vitals.test.ts   # from the app's folder: skips where Playwright or its Chromium isn't installed
node shared/metrics/lab.ts https://shop.example/nl/ …
```

The command loads each page three times and prints a Markdown table of the median LCP, CLS and TBT against the lines.
It exits 0 unless it can't run: a page that fails to load says why in its row.

The phone is Lighthouse's mobile default: a Moto G Power's screen, slow 4G and a 4× slower CPU, throttled the
DevTools way ("applied" throttling, through CDP), not Lighthouse's simulated way. The 4× is for a machine of a set
speed, so the slowdown follows how fast this one is just before each load (Lighthouse's `benchmarkIndex`): a busy
machine gets less. TBT stands in for INP, as in Lighthouse: a load has no real interaction. Each load is a first
visit, in a fresh context. A busy machine can slow one load, so a page is judged by each metric's best over up to five
loads: a busy machine only ever adds time, so the best is the nearest to what the page itself costs, and a page fails
only when a metric's best is over its line.
