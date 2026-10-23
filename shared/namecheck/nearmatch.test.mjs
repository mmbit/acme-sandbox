// node --test shared/namecheck/nearmatch.test.mjs   (a local server plays the App Store and Google Play; no network)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import * as nearmatch from './nearmatch.mjs';

// The App Store's apps per term and storefront, Google Play's search pages per term, and each status per term.
let appStore = {};
let googlePlay = {};
let refused = {};
// Terms whose next search is refused once, then answered.
let refusedOnce = new Set();
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, base);
  const term = url.searchParams.get('term') ?? url.searchParams.get('q');
  requests.push(term);
  const status = refusedOnce.delete(term) ? 503 : (refused[term] ?? 200);
  if (url.pathname === '/search') {
    const results = appStore[`${term}/${url.searchParams.get('country')}`] ?? [];
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ results }));
  } else {
    response.writeHead(status, { 'Content-Type': 'text/html' });
    response.end(googlePlay[term] ?? playPage([]));
  }
});
server.listen(0);
await once(server, 'listening');
after(() => server.close());
const base = `http://localhost:${server.address().port}`;

const noWait = async () => {};
const unpaced = { turn: noWait, retryPause: noWait };
const appleApp = (trackId, trackName, sellerName) => ({ trackId, trackName, sellerName, trackViewUrl: `/${trackId}` });

// A search page shaped like Google Play's: each app a link around its title and seller, or "No results for".
function playPage(apps) {
  const cards = apps.map(
    ([id, title, seller]) =>
      `<div><a class="Si6A0c" href="/store/apps/details?id=${id}" jslog="1"><img alt="x" />` +
      `<div><span>${title}</span></div><div><span>${seller}</span></div></a></div>`,
  );
  return `<html><body>${cards.join('') || '<div>No results for</div><span>term</span>'}</body></html>`;
}

function reset() {
  appStore = {};
  googlePlay = {};
  refused = {};
  refusedOnce = new Set();
  requests.length = 0;
}

test('neighbours include a dropped letter, a doubled consonant and a replaced first letter', () => {
  assert.ok(nearmatch.neighboursOf('molbi').includes('mobbi'));
  assert.ok(nearmatch.neighboursOf('bofla').includes('bofa'));
  assert.ok(nearmatch.neighboursOf('tomli').includes('fomli'));
  const neighbours = nearmatch.neighboursOf('molbi');
  assert.equal(new Set(neighbours).size, neighbours.length);
  assert.ok(!neighbours.includes('molbi'));
  assert.ok(neighbours.every(neighbour => nearmatch.withinOneEdit(neighbour, 'molbi')));
});

test('one letter swapped, added, dropped or transposed is within one edit, two edits are not', () => {
  for (const near of ['molbi', 'mobbi', 'molbio', 'mobi', 'mobli']) assert.ok(nearmatch.withinOneEdit(near, 'molbi'));
  for (const far of ['mobile', 'bolma', 'mol', 'olmbi']) assert.ok(!nearmatch.withinOneEdit(far, 'molbi'));
});

test('an app a letter away is a hit, with its seller, link and every storefront it showed in', async () => {
  reset();
  appStore = {
    'mobbi/de': [appleApp(1, 'Mobbi AI', 'Vega Group'), appleApp(2, 'Mobile Legends', 'Moonton')],
    'mobbi/us': [appleApp(1, 'Mobbi AI', 'Vega Group')],
    'mobi/nl': [appleApp(3, 'Fotos', 'Molby Studio')],
  };
  const terms = ['molbi', 'mobbi', 'mobi'];
  const searches = nearmatch.appStoreSearches(terms, `${base}/search`, ['us', 'nl', 'de']);
  const found = await nearmatch.nearMatches('molbi', searches, unpaced);
  assert.deepEqual(found.failures, []);
  assert.deepEqual(
    found.hits.map(({ app, seller, url, word, storefronts }) => ({ app, seller, url, word, storefronts })),
    [
      { app: 'Mobbi AI', seller: 'Vega Group', url: '/1', word: 'mobbi', storefronts: ['us', 'de'] },
      { app: 'Fotos', seller: 'Molby Studio', url: '/3', word: 'molby', storefronts: ['nl'] },
    ],
  );
});

test("Google Play's search page gives each app's title, seller and link", async () => {
  reset();
  googlePlay = { fomli: playPage([['com.relentless.focusguard', 'Fomli: Blocker &amp; Focus', 'Relentless']]) };
  const searches = nearmatch.googlePlaySearches(['tomli', 'fomli'], `${base}/play`, ['gb']);
  const found = await nearmatch.nearMatches('tomli', searches, unpaced);
  assert.deepEqual(found.failures, []);
  assert.deepEqual(
    found.hits.map(({ app, seller, url }) => ({ app, seller, url })),
    [
      {
        app: 'Fomli: Blocker & Focus',
        seller: 'Relentless',
        url: `${base}/store/apps/details?id=com.relentless.focusguard`,
      },
    ],
  );
});

test('a Google Play page with no apps and no "No results for" is unclear, never nothing found', async () => {
  reset();
  googlePlay = { tomli: '<html><body>Something else entirely</body></html>' };
  const found = await nearmatch.searchGooglePlay('tomli', `${base}/play`, 'gb');
  assert.equal(found.apps, undefined);
  assert.equal(typeof found.error, 'string');
});

test('a search refused twice is unanswered, and three in a row stop that store; the report says unclear', async () => {
  reset();
  refused = { mobbi: 429, mobi: 429, moli: 429 };
  const terms = ['molbi', 'mobbi', 'mobi', 'moli', 'molb'];
  const searches = nearmatch.googlePlaySearches(terms, `${base}/play`, ['us']);
  const found = await nearmatch.nearMatches('molbi', searches, unpaced);
  assert.deepEqual(requests, ['molbi', 'mobbi', 'mobbi', 'mobi', 'mobi', 'moli', 'moli']);
  assert.equal(found.failures.length, 3);
  assert.equal(found.notRun, 1);

  const lines = [];
  const log = console.log;
  console.log = line => lines.push(line);
  try {
    nearmatch.printNearMatches('molbi', 'molbi', terms, { 'Google Play': found });
  } finally {
    console.log = log;
  }
  assert.match(lines[1], /Google Play: unclear/);
});

test('one search without an answer is passed over, and the searches after it still run', async () => {
  reset();
  refused = { mobi: 503 };
  googlePlay = { mobbi: playPage([['com.mobbi.italy', 'MOBBI', 'Mobbi Sharing']]) };
  const searches = nearmatch.googlePlaySearches(['molbi', 'mobi', 'mobbi'], `${base}/play`, ['us']);
  const found = await nearmatch.nearMatches('molbi', searches, unpaced);
  assert.deepEqual(requests, ['molbi', 'mobi', 'mobi', 'mobbi']);
  assert.equal(found.failures.length, 1);
  assert.equal(found.notRun, 0);
  assert.deepEqual(
    found.hits.map(hit => hit.app),
    ['MOBBI'],
  );
});

test('a search that fails once is tried again, and the store carries on', async () => {
  reset();
  refusedOnce = new Set(['mobbi']);
  appStore = { 'mobbi/de': [appleApp(1, 'Mobbi AI', 'Vega Group')] };
  const searches = nearmatch.appStoreSearches(['molbi', 'mobbi', 'mobi'], `${base}/search`, ['de']);
  const found = await nearmatch.nearMatches('molbi', searches, unpaced);
  assert.deepEqual(requests, ['molbi', 'mobbi', 'mobbi', 'mobi']);
  assert.deepEqual(found.failures, []);
  assert.deepEqual(
    found.hits.map(hit => hit.app),
    ['Mobbi AI'],
  );
});

test('a retry takes a pacer turn after its pause, so the search after it keeps the spacing', async () => {
  reset();
  refusedOnce = new Set(['molbi']);
  const times = [];
  const timed = searches =>
    searches.map(search => () => {
      times.push(Date.now());
      return search();
    });
  const searches = timed(nearmatch.appStoreSearches(['molbi', 'mobbi'], `${base}/search`, ['de']));
  // The real check's 3 and 10 seconds, scaled down: without the retry's turn, the retry and the next search land
  // together, at [0, 250, 250].
  const pace = { turn: nearmatch.pacer(100), retryPause: () => new Promise(resolve => setTimeout(resolve, 250)) };
  await nearmatch.nearMatches('molbi', searches, pace);
  assert.deepEqual(requests, ['molbi', 'molbi', 'mobbi']);
  const gaps = times.slice(1).map((time, i) => time - times[i]);
  assert.ok(gaps[0] >= 240, `retry after ${gaps[0]} ms`);
  assert.ok(gaps[1] >= 90, `next search ${gaps[1]} ms after the retry`);
});
