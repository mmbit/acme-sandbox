// node --test shared/metrics/metrics.test.ts   (a local server plays HQ's /api/metrics/push)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Order } from './metrics.ts';

// HQ's answer, or what it answers to a given push
let answer: number | ((body: any) => number) = 200,
  ordersDue = false;
const got: { headers: Record<string, unknown>; body: any }[] = [];
const hq = createServer(async (q, s) => {
  let b = '';
  for await (const c of q) b += c;
  const body = JSON.parse(b),
    status = typeof answer === 'function' ? answer(body) : answer;
  got.push({ headers: q.headers, body });
  s.writeHead(status, { 'content-type': 'application/json' }).end(
    JSON.stringify(status === 200 ? { ok: true, ...(ordersDue ? { ordersDue } : {}) } : { error: 'nope' }),
  );
});
await new Promise<void>(r => hq.listen(0, r));
after(() => hq.close());
Object.assign(process.env, {
  METRICS_URL: `http://localhost:${(hq.address() as any).port}`,
  METRICS_PRODUCT: 'shop',
  METRICS_MODE: 'live',
  METRICS_TOKEN: 'a'.repeat(64),
  METRICS_TIME_ZONE: 'Europe/Amsterdam',
});
const { metrics, push, summarize, day, crawlerName, aiReferral, fetchedBy, loadSource, SOURCE_DAYS } =
  await import('./metrics.ts');

const today = day();
const ledger: Order[] = [
  {
    created: new Date().toISOString(),
    paid: true,
    refunded: false,
    total: 39.95,
    net: 33.02,
    country: 'NL',
    campaign: 'meta-reel-a',
    variant: 'name-first:B',
    what: 'plant-1',
  },
  {
    created: Date.now(),
    paid: true,
    refunded: true,
    total: 39.95,
    net: 33.02,
    country: 'NL',
    campaign: 'meta-reel-a',
    variant: 'name-first:B',
    what: 'plant-1',
  },
  {
    created: Date.now(),
    paid: false,
    refunded: false,
    total: 39.95,
    net: 33.02,
    country: 'NL',
    campaign: 'meta-reel-a',
    variant: 'name-first:B',
    what: 'plant-1',
  },
  { created: Date.now() - 90 * 864e5, paid: true, refunded: false, total: 39.95, net: 33.02, country: 'DE' },
];
const LABELS = new Set(['meta-reel-a']);
metrics.setup({
  file: {
    steps: [{ id: 'page' }, { id: 'order' }, { id: 'paid' }],
    tests: [{ id: 'name-first', variants: ['A', 'B'], start: '2020-01-01', end: null }],
  },
  label: v => (typeof v === 'string' && LABELS.has(v) ? v : null),
  orders: () => ledger,
});

test('ad click IDs leave the address before the page is served; labels and everything else stay', () => {
  assert.equal(
    metrics.cleanUrl('/?c=meta-reel-a&fbclid=IwAR123&gclid=x&utm_source=meta&ttclid=y&msclkid=z'),
    '/?c=meta-reel-a&utm_source=meta',
  );
  assert.equal(metrics.cleanUrl('/help.html?wbraid=1'), '/help.html');
  assert.equal(metrics.cleanUrl('/?c=meta-reel-a'), null);
  // never another host's address: a Location of //evil.com/ would leave the shop
  assert.equal(metrics.cleanUrl('/.//evil.com/x.html?fbclid=1'), '/evil.com/x.html');
  assert.equal(metrics.cleanUrl('//a.com//evil.com/?gclid=1'), '/evil.com/');
  assert.equal(metrics.cleanUrl('/\\evil.com/?gclid=1'), '/');
});

test("a page load counts only our own ad labels, and splits evenly between the running test's versions", () => {
  const seen = { A: 0, B: 0 } as Record<string, number>;
  for (let i = 0; i < 400; i++) {
    const v = metrics.page(new URL(`http://x/?c=${i % 2 ? 'meta-reel-a' : 'sanne-de-vries'}`));
    seen[v!.variant!.split(':')[1]]++;
    assert.equal(v!.campaign, i % 2 ? 'meta-reel-a' : null);
  }
  assert.ok(seen.A > 140 && seen.B > 140, JSON.stringify(seen));
  const rows = metrics.snapshot().filter(r => r.step === 'page');
  assert.equal(
    rows.reduce((n, r) => n + r.n, 0),
    400,
  );
  assert.ok(
    rows.every(r => r.day === today && ['', 'meta-reel-a'].includes(r.campaign) && r.country === '' && r.what === ''),
  );
  assert.match(
    metrics.mark('<!doctype html><html lang="en">', { variant: 'name-first:B' }),
    /<html data-ab="name-first:B" lang="en">/,
  );
  assert.equal(metrics.mark('<html lang="en">', { variant: null }), '<html lang="en">');
});

test('a version sent back with the order counts only if it belongs to the running test', () => {
  assert.equal(metrics.variant('name-first:B'), 'name-first:B');
  for (const v of ['name-first:C', 'other:A', 'name-first:b', 'name-first:A"><script>', 42, null])
    assert.equal(metrics.variant(v), null, String(v));
});

test("a step the app's file doesn't name, or an odd value, is never sent", () => {
  metrics.count('order', { country: 'NL', campaign: 'meta-reel-a', variant: 'name-first:A', what: 'Plant <1>' });
  metrics.count('typo-step', { country: 'NL' });
  metrics.count('order', { country: 'nl; drop', campaign: 'Sanne de Vries' });
  const orders = metrics.snapshot().filter(r => r.step === 'order');
  // a source rides only on page loads: a step's count is someone's action, and HQ can't take it back
  assert.deepEqual(orders.map(r => [r.country, r.campaign, r.variant, r.what]).sort(), [
    ['', '', '', ''],
    ['NL', '', 'name-first:A', ''],
  ]);
  assert.ok(!metrics.snapshot().some(r => r.step === 'typo-step'));
});

test('the order summary groups per day: paid, refunded and kept, euros only for kept orders, 60 days back', () => {
  const s = summarize([
    { created: Date.now(), paid: true, refunded: false, total: 39.95, net: 33.02, country: 'NL', what: 'plant-2' },
    {
      created: new Date().toISOString(),
      paid: true,
      refunded: false,
      total: 39.95,
      net: 33.57,
      country: 'NL',
      what: 'plant-2',
    },
    { created: Date.now(), paid: true, refunded: true, total: 39.95, net: 33.02, country: 'NL', what: 'plant-2' },
    { created: Date.now(), paid: false, refunded: false, total: 39.95, net: 33.02, country: 'NL', what: 'plant-2' },
    {
      created: Date.now() - 61 * 864e5,
      paid: true,
      refunded: false,
      total: 39.95,
      net: 33.02,
      country: 'NL',
      what: 'plant-2',
    },
    {
      created: Date.now(),
      paid: false,
      refunded: false,
      total: 39.95,
      net: 33.02,
      country: 'NL',
      what: 'plant-2',
      variant: 'gone-test:B',
    },
  ]);
  assert.equal(s.to, today);
  assert.deepEqual(s.rows, [
    {
      day: today,
      variant: '',
      campaign: '',
      country: 'NL',
      what: 'plant-2',
      orders: 5,
      paid: 3,
      refunded: 1,
      kept: 2,
      eur: 79.9,
      net: 66.59,
      netUnknown: 0,
    },
  ]); // a test no longer in the file: no version
});

test("a source and an objection's day go with an order for less than SOURCE_DAYS, even on the summary's first day when it has 25 hours", () => {
  // 23 December 2026, 23:30 in Amsterdam: the summary starts on 25 October, the day the clocks went back
  const now = Date.parse('2026-12-23T22:30:00Z'),
    at = (iso: string) => ({
      created: iso,
      paid: true,
      refunded: false,
      total: 4.99,
      net: null,
      campaign: 'gads-clock',
    });
  const s = summarize([at('2026-10-24T22:10:00Z'), at('2026-10-24T22:40:00Z')], now);
  assert.equal(s.from, '2026-10-25');
  assert.equal(s.made, now);
  assert.equal(SOURCE_DAYS, 60);
  // 00:10 on 25 October is 60 days and 20 minutes before: counted, without its source
  assert.deepEqual(
    s.rows.map(r => [r.day, r.campaign, r.orders, r.eur]),
    [
      ['2026-10-25', '', 1, 4.99],
      ['2026-10-25', 'gads-clock', 1, 4.99],
    ],
  );
  // The last day with an objected order younger than that: HQ drops page loads' sources through it
  const objected = (iso: string) => ({ ...at(iso), objected: true });
  assert.equal(s.objected, null);
  assert.equal(summarize([objected('2026-10-24T22:10:00Z')], now).objected, null);
  const marked = summarize(
    [objected('2026-10-24T22:40:00Z'), objected('2026-11-02T09:00:00Z'), at('2026-12-01T10:00:00Z')],
    now,
  );
  assert.equal(marked.objected, '2026-11-02');
});

test("a kept order whose net the app doesn't know is counted as unknown, never as 0 or its total", () => {
  const s = summarize([
    { created: Date.now(), paid: true, refunded: false, total: 4.99, net: 3.8, what: 'keeps' },
    { created: Date.now(), paid: true, refunded: false, total: 4.99, net: null, what: 'keeps' },
    { created: Date.now(), paid: true, refunded: true, total: 4.99, net: null, what: 'keeps' },
  ]);
  assert.deepEqual(
    s.rows.map(r => [r.kept, r.eur, r.net, r.netUnknown]),
    [[2, 9.98, 3.8, 1]],
  );
});

// (x-own-device)
test("a live product counts nothing that came through the preview door, from our own visits or from HQ's watch, even after an await", async () => {
  const before = JSON.stringify(metrics.snapshot());
  // The mark the kit expects for this token. watch.test.ts holds the coordinator's own mark against the kit.
  const watchMark = createHmac('sha256', 'a'.repeat(64)).update('hq-watch').digest('hex');
  for (const uncounted of [
    { headers: { 'x-preview-door': '1' } },
    { headers: { 'x-own-device': '1' } },
    { headers: { 'x-hq-watch': watchMark } },
  ])
    await metrics.serve(uncounted, async () => {
      metrics.page(new URL('http://x/?c=meta-reel-a'));
      await new Promise(r => setTimeout(r, 5));
      metrics.count('order', { country: 'NL' });
    });
  assert.equal(JSON.stringify(metrics.snapshot()), before);
  metrics.serve({ headers: {} }, () => metrics.count('paid', { country: 'BE' })); // a public request counts
  assert.ok(metrics.snapshot().some(r => r.step === 'paid' && r.country === 'BE'));
  const otherMark = createHmac('sha256', 'b'.repeat(64)).update('hq-watch').digest('hex'); // as long as the real one
  for (const forged of ['1', watchMark.slice(1), `${watchMark}é`, otherMark])
    // a visitor's x-hq-watch counts too
    metrics.serve({ headers: { 'x-hq-watch': forged } }, () => metrics.count('paid', { country: 'LU' }));
  assert.equal(metrics.snapshot().find(r => r.step === 'paid' && r.country === 'LU')?.n, 4);
  // the same verdict for an app's own counts
  assert.equal(metrics.counts({ headers: { 'x-preview-door': '1' } }), false);
  assert.equal(metrics.counts({ headers: { 'x-own-device': '1' } }), false);
  // Caddy's word on a visitor's request: the mark left empty
  assert.equal(metrics.counts({ headers: { 'x-own-device': '' } }), true);
  assert.equal(metrics.counts({ headers: { 'x-hq-watch': watchMark } }), false);
  assert.equal(metrics.counts({ headers: { 'x-hq-watch': otherMark } }), true);
  assert.equal(metrics.counts({ headers: {} }), true);
});

test("a push carries the counts and the order summary with the product's key; a failed one goes again with the same batch id", async () => {
  answer = 503;
  assert.equal(await push(), false);
  const first = got.at(-1)!;
  assert.equal(first.headers.authorization, `Bearer ${'a'.repeat(64)}`);
  assert.equal(first.headers['x-product'], 'shop');
  assert.equal(first.headers['x-mode'], 'live');
  assert.match(first.body.batch, /^[a-f0-9]{32}$/);
  assert.equal(
    first.body.counts.filter((r: any) => r.step === 'page').reduce((n: number, r: any) => n + r.n, 0),
    400,
  );
  assert.equal(first.body.orders.rows.length, 1); // the 90-day-old order is left out
  assert.deepEqual(Object.keys(first.body.orders.rows[0]).sort(), [
    'campaign',
    'country',
    'day',
    'eur',
    'kept',
    'net',
    'netUnknown',
    'orders',
    'paid',
    'refunded',
    'variant',
    'what',
  ]);

  metrics.page(new URL('http://x/')); // counted meanwhile: waits for the next batch
  for (const order of ledger) order.campaign = null; // the buyers objected meanwhile
  answer = 200;
  assert.equal(await push(), true);
  const again = got.at(-1)!.body;
  assert.deepEqual([again.batch, again.counts], [first.body.batch, first.body.counts]);
  // its summary made again: the source left the app before the retry, so it never reaches HQ
  assert.equal(first.body.orders.rows[0].campaign, 'meta-reel-a');
  assert.deepEqual(again.orders.rows, [{ ...first.body.orders.rows[0], campaign: '' }]);
  assert.ok(again.orders.made >= first.body.orders.made);
  assert.equal(await push(), true);
  const next = got.at(-1)!.body;
  assert.notEqual(next.batch, first.body.batch);
  assert.deepEqual(
    next.counts.map((r: any) => [r.step, r.n]),
    [['page', 1]],
  );
  assert.equal(next.orders, undefined); // the order summary goes hourly
  // unless HQ asks for one (it has started since, and dropped every source)
  ordersDue = true;
  metrics.page(new URL('http://x/'));
  assert.equal(await push(), true);
  ordersDue = false;
  metrics.page(new URL('http://x/'));
  assert.equal(await push(), true);
  assert.equal(got.at(-1)!.body.orders.rows.length, 1);
});

test('a retry keeps its refund and first day through a ledger read failure without reviving an expired source', async () => {
  const sender = await import(new URL('./metrics.ts?retry-read-failure', import.meta.url).href);
  const firstTime = Date.parse('2026-12-31T22:58:00Z');
  const retryTime = Date.parse('2027-01-01T09:03:00Z');
  let readable = true;
  sender.metrics.setup({
    file: { steps: [{ id: 'page' }] },
    orders: () => {
      if (!readable) throw new Error('Temporary ledger read failure');
      return [
        { created: '2026-11-02T09:00:00Z', paid: true, refunded: true, total: 4.99, net: null, campaign: 'gads-clock' },
      ];
    },
  });
  sender.metrics.page(new URL('http://x/'));
  answer = 503;
  assert.equal(await sender.push(firstTime), false);
  const first = got.at(-1)!.body;
  assert.equal(first.orders.from, '2026-11-02');
  assert.equal(first.orders.rows[0].campaign, 'gads-clock');
  const sent = got.length;
  readable = false;
  answer = 200;
  assert.equal(await sender.push(Date.parse('2026-12-31T23:03:00Z')), false);
  assert.equal(got.length, sent, 'a failed ledger read must send neither a stale summary nor a counts-only batch');
  readable = true;
  assert.equal(await sender.push(retryTime), true);
  const again = got.at(-1)!.body;
  assert.deepEqual([again.batch, again.counts], [first.batch, first.counts]);
  assert.equal(again.orders.from, first.orders.from);
  assert.equal(again.orders.to, '2027-01-01');
  assert.equal(again.orders.made, retryTime);
  assert.deepEqual(
    again.orders.rows.map((row: any) => [row.day, row.campaign, row.refunded, row.kept, row.eur]),
    [['2026-11-02', '', 1, 0, 0]],
  );
});

test('counts HQ refuses after an outage leave the summary waiting with its refund and first day', async t => {
  t.mock.method(console, 'error', () => {});
  const sender = await import(new URL('./metrics.ts?refused-counts', import.meta.url).href);
  sender.metrics.setup({
    file: { steps: [{ id: 'page' }] },
    orders: () => [
      { created: '2026-11-02T09:00:00Z', paid: true, refunded: true, total: 4.99, net: null, campaign: 'gads-clock' },
    ],
  });
  sender.metrics.page(new URL('http://x/'));
  answer = 503;
  assert.equal(await sender.push(Date.parse('2026-12-31T22:58:00Z')), false);
  const waiting = got.at(-1)!.body;
  assert.equal(waiting.orders.from, '2026-11-02');
  // 3 January: HQ takes counts from 1 January on, so it refuses the batch for its 31 December count
  answer = (body: any) => (body.counts.some((c: any) => c.day < '2027-01-01') ? 400 : 200);
  assert.equal(await sender.push(Date.parse('2027-01-03T09:00:00Z')), false);
  assert.equal(await sender.push(Date.parse('2027-01-03T09:05:00Z')), true);
  const accepted = got.at(-1)!.body;
  assert.deepEqual(accepted.counts, []);
  // 2 November is past a new summary's first day (5 November) but still in the one that waited
  assert.equal(accepted.orders.from, '2026-11-02');
  assert.deepEqual(
    accepted.orders.rows.map((row: any) => [row.day, row.refunded, row.kept]),
    [['2026-11-02', 1, 0]],
  );
  // A summary HQ refuses on its own is dropped: the next push is a new batch
  sender.metrics.page(new URL('http://x/'));
  answer = (body: any) => (body.orders ? 400 : 200);
  assert.equal(await sender.push(Date.parse('2027-01-03T10:10:00Z')), false);
  assert.equal(await sender.push(Date.parse('2027-01-03T10:15:00Z')), false);
  const refused = got.at(-1)!.body;
  assert.deepEqual(refused.counts, []);
  answer = 200;
  assert.equal(await sender.push(Date.parse('2027-01-03T10:20:00Z')), true);
  assert.notEqual(got.at(-1)!.body.batch, refused.batch);
});

test('a push HQ refuses (bad data, a wrong key) is dropped rather than sent forever', async () => {
  metrics.count('paid', { country: 'DE' });
  answer = 400;
  assert.equal(await push(), false);
  const refused = got.at(-1)!.body.batch;
  answer = 200;
  metrics.count('paid', { country: 'BE' });
  await push();
  assert.notEqual(got.at(-1)!.body.batch, refused);
  assert.deepEqual(
    got.at(-1)!.body.counts.map((r: any) => r.country),
    ['BE'],
  );
});

test('HQ out of reach for a deploy goes to stdout; still silent ten minutes on, to stderr once each ten minutes', async t => {
  const out = t.mock.method(console, 'log', () => {}),
    err = t.mock.method(console, 'error', () => {});
  metrics.count('paid', { country: 'NL' });
  answer = 502;
  const start = Date.now(),
    at = (minutes: number) => start + minutes * 60_000;
  for (const minutes of [0, 5, 10, 15, 20]) assert.equal(await push(at(minutes)), false);
  assert.equal(out.mock.callCount(), 3);
  assert.equal(err.mock.callCount(), 2);
  assert.match(err.mock.calls[0].arguments[0], /push failed \(502 nope\) for 10 minutes/);
  answer = 200;
  assert.equal(await push(at(25)), true);
  answer = 502;
  metrics.count('paid', { country: 'NL' });
  assert.equal(await push(at(26)), false); // a new silence starts quiet again
  assert.equal(err.mock.callCount(), 2);
  // HQ's own error scan reads none of the stdout lines as a warning, and both stderr ones
  const scan = (calls: any[]) =>
    execFileSync('python3', [new URL('../../infra/log_errors.py', import.meta.url).pathname, '--counts'], {
      input: calls.map(call => `${call.arguments[0]}\n`).join(''),
      encoding: 'utf8',
    }).trim();
  assert.equal(scan(out.mock.calls), 'none');
  assert.equal(scan(err.mock.calls), '2 warning/error lines (text withheld)');
  answer = 200;
  await push();
});

test('search referrers keep only the engine and never override an app label', () => {
  const file = { steps: [{ id: 'page' }, { id: 'order' }] };
  const label = (value: unknown) => (value === 'gads-clock' ? value : null);
  metrics.setup({ file, label });
  assert.equal(metrics.page(new URL('http://x/'), 'https://www.google.nl/search?q=private')?.campaign, null);
  assert.equal(metrics.orderCampaign('gads-clock'), null);
  metrics.setup({ file, label, searchReferrers: true, orderCampaigns: true });
  for (const [referrer, engine] of [
    ['https://www.google.nl/search?q=private', 'google'],
    ['https://google.co.uk/search?q=private', 'google'],
    ['https://www.bing.com/search?q=private', 'bing'],
    ['https://duckduckgo.com/?q=private', 'duckduckgo'],
    ['https://www.ecosia.org/search?q=private', 'ecosia'],
    ['https://uk.search.yahoo.com/search?p=private', 'yahoo'],
    ['https://search.brave.com/search?q=private', 'brave'],
    ['https://www.startpage.com/do/search?q=private', 'startpage'],
    ['https://www.qwant.com/?q=private', 'qwant'],
  ]) {
    assert.equal(metrics.page(new URL('http://x/'), referrer)?.campaign, `search-${engine}`);
    assert.equal(metrics.page(new URL('http://x/?c=unknown'), referrer)?.campaign, `search-${engine}`);
  }
  assert.equal(
    metrics.page(new URL('http://x/?c=gads-clock'), 'https://google.com/search?q=private')?.campaign,
    'gads-clock',
  );
  for (const referrer of [
    undefined,
    'broken',
    'https://example.test/search?q=private',
    'https://google.com.evil.test/',
    'https://notgoogle.nl/',
    'https://google.invalid/',
    'https://google.com@evil.test/',
    'ftp://google.com/',
  ]) {
    assert.equal(metrics.page(new URL('http://x/'), referrer)?.campaign, null);
  }
  assert.equal(metrics.orderCampaign('search-google'), 'search-google');
  assert.equal(metrics.orderCampaign('gads-clock'), 'gads-clock');
  assert.equal(metrics.orderCampaign('search-unknown'), null);
  assert.equal(metrics.orderCampaign('https://google.com/?q=private'), null);
  assert.equal(
    metrics.mark('<html lang="en">', { variant: null, campaign: 'search-google' }),
    '<html data-campaign="search-google" lang="en">',
  );
  assert.ok(!JSON.stringify(metrics.snapshot()).includes('private'));
  const summary = summarize([
    { created: Date.now(), paid: true, refunded: false, total: 4.99, net: null, campaign: 'search-google' },
  ]);
  assert.equal(summary.rows[0].campaign, 'search-google');
  metrics.setup({ file, label });
  assert.equal(metrics.orderCampaign('search-google'), null);
  assert.equal(metrics.mark('<html>', { variant: null, campaign: 'search-google' }), '<html>');
});

test('crawlers and fetchers are named by their robots token, any other bot or HTTP library is other, a browser null', () => {
  for (const [ua, name] of [
    [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot',
      'oai-searchbot',
    ],
    [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
      'chatgpt-user',
    ],
    [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot',
      'gptbot',
    ],
    [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
      'perplexitybot',
    ],
    [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
      'perplexity-user',
    ],
    ['Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)', 'claude-searchbot'],
    ['Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)', 'claude-user'],
    [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      'claudebot',
    ],
    ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'bingbot'],
    [
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'googlebot',
    ],
    ['Googlebot-Image/1.0', 'googlebot'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
      'applebot',
    ],
    ['mozilla/5.0 (compatible; GPTBOT/2.0)', 'gptbot'],
    ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'facebookexternalhit'],
    ['meta-externalads/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'meta-externalads'],
    ['meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'meta-externalagent'],
    [
      'meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
      'meta-externalfetcher',
    ],
    ['meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'meta-webindexer'],
    // any other bot that says so, by its name or its info link, and the HTTP libraries
    ['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'other'],
    ['Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)', 'other'],
    [
      'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
      'other',
    ],
    ['DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)', 'other'],
    ['Screaming Frog SEO Spider/21.0', 'other'],
    ['AdsBot-Google (+http://www.google.com/adsbot.html)', 'other'],
    ['Mozilla/5.0 (compatible; Barkrowler/0.9; +https://babbar.tech/crawler)', 'other'],
    ['curl/8.5.0', 'other'],
    ['python-requests/2.32.3', 'other'],
    ['Go-http-client/2.0', 'other'],
    ['node', 'other'],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36',
      'other',
    ],
    // every browser sends a user agent
    [undefined, 'other'],
    ['', 'other'],
    [42, 'other'],
  ] as const)
    assert.equal(crawlerName(ua), name, String(ua));
  for (const ua of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    // Facebook's and Instagram's in-app browsers: a person tapping an ad
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.38.109;FBBV/1;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/18.0;FBLC/nl_NL;FBOP/5;FBRV/0]',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0 Android (34/14; 480dpi; 1080x2340; samsung; SM-S918B; dm3q; qcom; nl_NL; 600000000)',
    'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  ])
    assert.equal(crawlerName(ua), null, String(ua));
  // a name that only looks like a known one is never the known one
  assert.equal(crawlerName('Mozilla/5.0 (compatible; NotGPTBot/1.0)'), 'other');
  assert.equal(crawlerName('Mozilla/5.0 (compatible; GPTBotty/1.0)'), null);
});

test("a visit an AI assistant sent is ai-<assistant>, from the referrer or ChatGPT's utm_source", () => {
  const page = new URL('https://shop.test/nl/cadeaus/nieuw-huis/');
  for (const [referrer, url, source] of [
    ['https://chatgpt.com/', page, 'ai-chatgpt'],
    ['https://www.perplexity.ai/search/private-question', page, 'ai-perplexity'],
    ['https://copilot.microsoft.com/chats/abc', page, 'ai-copilot'],
    ['https://gemini.google.com/app/abc', page, 'ai-gemini'],
    ['https://claude.ai/chat/abc', page, 'ai-claude'],
    [undefined, 'https://shop.test/nl/cadeaus/nieuw-huis/?utm_source=chatgpt.com', 'ai-chatgpt'],
    [undefined, '/nl/?utm_source=chatgpt.com', 'ai-chatgpt'],
    ['https://www.google.nl/', '/nl/?utm_source=ChatGPT.com', 'ai-chatgpt'],
  ] as const)
    assert.equal(aiReferral(referrer, url), source, `${referrer} ${url}`);
  for (const [referrer, url] of [
    [undefined, page],
    ['https://www.google.nl/search?q=private', page],
    ['https://chatgpt.com.evil.test/', page],
    ['https://notchatgpt.com/', page],
    ['https://chatgpt.com@evil.test/', page],
    ['https://user:pw@chatgpt.com/', page],
    ['ftp://chatgpt.com/', page],
    ['broken', '/?utm_source=meta'],
    [undefined, '/?utm_campaign=chatgpt.com'],
  ] as const)
    assert.equal(aiReferral(referrer, url), null, `${referrer} ${url}`);
});

// (the tests below, the fetchers' names in the crawler test)
const BROWSER =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test("a crawler's, a fetcher's or a prefetch's load counts only by where it came from, a person's as a page load too", () => {
  const counted = () => JSON.stringify(metrics.snapshot().filter(r => r.step !== 'load'));
  const loads = (source: string) => metrics.snapshot().find(r => r.step === 'load' && r.campaign === source)?.n ?? 0;
  const people = counted();
  for (const [headers, source] of [
    [
      { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
      'agent-facebookexternalhit',
    ],
    [{ 'user-agent': 'curl/8.5.0' }, 'agent-other'],
    [{}, 'agent-other'],
    // Meta's apps loading an ad's page ahead of a tap, and a browser's prefetch and prerender
    [{ 'user-agent': BROWSER, 'x-purpose': 'preview', 'x-fb-http-engine': 'Liger' }, 'prefetch'],
    [{ 'user-agent': BROWSER, 'sec-purpose': 'prefetch;prerender' }, 'prefetch'],
    [{ 'user-agent': BROWSER, purpose: 'prefetch' }, 'prefetch'],
  ] as const) {
    const before = loads(source);
    assert.equal(
      metrics.serve({ headers }, () => metrics.page(new URL('http://x/?c=meta-reel-a'))),
      null,
    );
    assert.equal(fetchedBy(headers), source);
    assert.equal(loads(source), before + 1, source);
  }
  assert.equal(counted(), people);
  const from = (referer: string) => ({
    'user-agent': BROWSER,
    host: 'shop.test',
    'x-forwarded-prefix': '/plant',
    referer,
  });
  const before = loads('meta');
  const v = metrics.serve({ headers: from('https://lm.facebook.com/l.php?u=x') }, () =>
    metrics.page(new URL('http://x/')),
  );
  assert.ok(v);
  assert.equal(loads('meta'), before + 1);
  assert.notEqual(counted(), people);
  assert.equal(fetchedBy({ 'user-agent': BROWSER, 'sec-purpose': 'other' }), null);
});

test("a person's load comes from the app's own pages, the shop's, an assistant, a search engine, Meta, another site or none", () => {
  const url = new URL('https://shop.test/plant/');
  const onShelf = { host: 'shop.test', 'x-forwarded-prefix': '/plant' };
  for (const [headers, source] of [
    [{ ...onShelf, referer: 'https://shop.test/plant/?c=meta-reel-a' }, 'stall'],
    [{ ...onShelf, referer: 'https://www.shop.test/plant' }, 'stall'],
    [{ ...onShelf, referer: 'https://shop.test/nl/cadeaus/' }, 'shop'],
    [{ ...onShelf, referer: 'https://shop.test/plants/' }, 'shop'],
    [{ host: 'plant.test:8080', referer: 'http://plant.test/next' }, 'stall'],
    [{ ...onShelf, referer: 'https://chatgpt.com/' }, 'ai-chatgpt'],
    [{ ...onShelf, referer: 'https://www.google.nl/' }, 'search-google'],
    [{ ...onShelf, referer: 'https://duckduckgo.com/' }, 'search-duckduckgo'],
    [{ ...onShelf, referer: 'https://l.facebook.com/l.php?u=x' }, 'meta'],
    [{ ...onShelf, referer: 'https://lm.facebook.com/' }, 'meta'],
    [{ ...onShelf, referer: 'https://www.instagram.com/' }, 'meta'],
    [{ ...onShelf, referer: 'https://l.instagram.com/' }, 'meta'],
    [{ ...onShelf, referer: 'https://notfacebook.com/' }, 'other'],
    [{ ...onShelf, referer: 'https://facebook.com.evil.test/' }, 'other'],
    [{ ...onShelf, referer: 'android-app://com.google.android.gm/' }, 'other'],
    [{ ...onShelf, referer: 'https://user:pw@shop.test/plant/' }, 'other'],
    [onShelf, 'none'],
  ] as const)
    assert.equal(loadSource(headers, url), source, JSON.stringify(headers));
  // ChatGPT's app often sends no referrer, but its link says where it's from
  assert.equal(loadSource(onShelf, 'https://shop.test/plant/?utm_source=chatgpt.com'), 'ai-chatgpt');
  // an app at the host's root beside the shelves says which paths are its own: another shelf's page is the shop
  const front = { host: 'shop.test' },
    frontPage = (path: string) => !path.startsWith('/plant/');
  assert.equal(loadSource({ ...front, referer: 'https://shop.test/nl/' }, url, frontPage), 'stall');
  assert.equal(loadSource({ ...front, referer: 'https://shop.test/plant/' }, url, frontPage), 'shop');
});
