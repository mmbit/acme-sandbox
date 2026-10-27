// The status report's two sections on the live products' page loads (infra/report.sh), run by the coordinator
// container's node from stdin: HQ's counts (shared/metrics: the stalls) per day on the company's clock (the one each
// deploy publishes, clock.ts), the last seven of its days. Only HQ's counts, checked words already, so nothing a product
// prints reaches the report. platform/coordinator's src/visitors-report.test.ts runs it on a throwaway hq.db.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DAYS = 7;
const data = process.env.DATA_DIR ?? '/data';
const db = new DatabaseSync(data + '/hq.db', { timeout: 5000, readOnly: true });
const timeZone = readFileSync(data + '/time-zone', 'utf8');

// Six calendar days before today in the company's zone, counted on the date: a span of 6 × 24 hours drops a day around a
// clock change
const today = new Intl.DateTimeFormat('sv-SE', { timeZone }).format(Date.now());
const first = new Date(`${today}T00:00Z`);
first.setUTCDate(first.getUTCDate() - (DAYS - 1));
const from = first.toISOString().slice(0, 10);

visitors();
loadSources();

// Page loads, visitors and visits per day and source (the ad label or search engine the visit landed with)
function visitors() {
  console.log(
    `\n== live products: page loads, visitors and visits, last ${DAYS} days from ${from} (HQ's counts; per day on the company's clock and the source each visit landed with)`,
  );
  const rows = db
    .prepare(
      `select product, day, campaign, sum(iif(step = 'page', n, 0)) loads, sum(iif(step = 'visitor', n, 0)) visitors,
      sum(iif(step = 'visit', n, 0)) visits, max(step != 'page') seen from metric_counts where mode = 'live' and step in ('page', 'visitor', 'visit')
      and day >= ? group by product, day, campaign order by day desc, product, campaign`,
    )
    .all(from);
  // a product's days before its first visitor or visit were not counted (the switch was off): a dash, not 0
  const since = {};
  for (const r of rows) if (r.seen && !(since[r.product] <= r.day)) since[r.product] = r.day;
  const counted = r => r.product in since && r.day >= since[r.product];
  if (!rows.length) return console.log('No page loads in these days.');
  console.log('| product | day | source | page loads | visitors | visits |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows.slice(0, 100)) {
    const cells = [r.product, r.day, r.campaign || '(none)', r.loads, counted(r) ? r.visitors : '-'];
    console.log('| ' + [...cells, counted(r) ? r.visits : '-'].join(' | ') + ' |');
  }
  if (rows.length > 100)
    console.log('(' + (rows.length - 100) + ' more rows, past the 100 the report shows: the oldest days)');
  console.log(
    'A visitor is one internet address and browser in a day, a visit their page loads with under 30 minutes between, and a person back on another day counts again; -: not counted (METRICS_VISITORS in company/infra.env was off).',
  );
}

// Every load of those pages by where it came from, a column per source seen: a person's by the kind of page that sent
// them, or the crawler, fetcher or prefetch that made it, which the page loads above leave out (shared/metrics
// loadSource and fetchedBy)
function loadSources() {
  console.log(
    `\n== live products: every page load by where it came from, last ${DAYS} days from ${from} (HQ's counts; prefetch and agent-<name> aren't in the page loads above)`,
  );
  const rows = db
    .prepare(
      `select product, day, campaign source, sum(n) n from metric_counts where mode = 'live' and step = 'load'
      and day >= ? group by product, day, campaign`,
    )
    .all(from);
  // a person's sources first, then the prefetches, then the crawlers and fetchers; (not kept): a source HQ no longer keeps
  const kind = s => (s.startsWith('agent-') ? 2 : s === 'prefetch' ? 1 : 0);
  const sources = [...new Set(rows.map(r => r.source || '(not kept)'))].sort(
    (a, b) => kind(a) - kind(b) || a.localeCompare(b),
  );
  const days = new Map();
  for (const r of rows) {
    const key = r.day + ' ' + r.product;
    if (!days.has(key)) days.set(key, { day: r.day, product: r.product, n: {} });
    days.get(key).n[r.source || '(not kept)'] = r.n;
  }
  const lines = [...days.values()].sort((a, b) => b.day.localeCompare(a.day) || a.product.localeCompare(b.product));
  if (!lines.length) return console.log('No loads counted by source in these days.');
  console.log('| product | day | ' + sources.join(' | ') + ' |');
  console.log('|---|---|' + sources.map(() => '---|').join(''));
  for (const l of lines) console.log('| ' + [l.product, l.day, ...sources.map(s => l.n[s] ?? 0)].join(' | ') + ' |');
  console.log(
    'none: no referrer; stall: its own pages; shop: other pages of the shop; a social network by name (meta: Facebook or Instagram); other: any other site.',
  );
}
