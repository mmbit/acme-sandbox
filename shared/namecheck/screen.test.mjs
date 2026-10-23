// node --test shared/namecheck/screen.test.mjs   (a local server plays the App Store, IANA and a registry; no network)
// (formatted)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as screen from './screen.mjs';

// What the registry answers per domain, and the App Store's status and apps (byCountry: a storefront's own list;
// cutShort: a 200 whose body breaks off).
let registry = {};
let appStore = { status: 200, apps: [] };
const server = createServer((request, response) => {
  const url = new URL(request.url, base);
  const reply = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const services = [
    [['app', 'studio'], [`${base}/rdap/`]],
    [['com'], [base]],
  ];
  if (url.pathname === '/dns.json') reply(200, { services });
  else if (url.pathname === '/search' && appStore.cutShort) {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1000 });
    // Closed once the headers and part of the body are out, so fetch resolves and the body read fails.
    response.write('{"results": [{"trackId": 1, ', () => response.destroy());
  } else if (url.pathname === '/search') {
    const results = appStore.byCountry?.[url.searchParams.get('country')] ?? appStore.apps;
    reply(appStore.status, { results });
  } else {
    const domain = url.pathname.split('/').pop();
    reply(registry[domain] ?? 404, { objectClassName: 'domain', ldhName: domain });
  }
});
server.listen(0);
await once(server, 'listening');
after(() => server.close());
const base = `http://localhost:${server.address().port}`;

test('a domain is registered on 200, unregistered on 404, and unclear on anything else', async () => {
  registry = { 'velmo.com': 200, 'velmo.studio': 503 };
  const registries = await screen.rdapRegistries(`${base}/dns.json`);
  const domains = ['velmo.app', 'velmo.studio', 'velmoapps.com', 'velmo.com', 'velmo.nl'];
  const statuses = await Promise.all(domains.map(domain => screen.domainStatus(domain, registries)));
  assert.deepEqual(
    statuses.map(domain => domain.status),
    ['unregistered', 'unclear', 'unregistered', 'registered', 'unclear'],
  );
});

test('App Store hits are the apps with the name in their title or seller, each once across countries', async () => {
  const app = (trackId, trackName, sellerName) => ({ trackId, trackName, sellerName, trackViewUrl: `/${trackId}` });
  const apps = [app(1, 'Velmo Timer', 'Foo BV'), app(2, 'Lists', 'Vel-mo Studio'), app(3, 'Todo', 'X')];
  appStore = { status: 200, apps };
  const found = await screen.appStoreHits('velmo', `${base}/search`, ['us', 'nl', 'de']);
  assert.deepEqual(
    found.hits.map(hit => hit.app),
    ['Velmo Timer', 'Lists'],
  );
  assert.equal(found.others, 1);
});

test('an app is a hit if any storefront has the name, and still counts once', async () => {
  const app = (trackId, trackName, sellerName) => ({ trackId, trackName, sellerName, trackViewUrl: `/${trackId}` });
  const localised = app(7, 'Focus Timer', 'Example BV');
  appStore = {
    status: 200,
    byCountry: { us: [app(7, 'Velmo Timer', 'Example BV')], nl: [localised, app(8, 'Todo', 'X')], de: [localised] },
  };
  const found = await screen.appStoreHits('velmo', `${base}/search`, ['us', 'nl', 'de']);
  assert.deepEqual(
    found.hits.map(hit => hit.app),
    ['Velmo Timer'],
  );
  assert.equal(found.others, 1);
});

test('a refused App Store search is an error, never zero hits', async () => {
  appStore = { status: 403, apps: [] };
  const found = await screen.appStoreHits('velmo', `${base}/search`, ['us']);
  assert.equal(typeof found.error, 'string');
  assert.equal(found.hits, undefined);
});

test('an App Store body that breaks off is an error, never an exception or zero hits', async () => {
  appStore = { cutShort: true };
  const found = await screen.appStoreHits('velmo', `${base}/search`, ['us']);
  assert.equal(typeof found.error, 'string');
  assert.equal(found.hits, undefined);
});

test('a name is screened without spaces, hyphens and accents, and keeps its own spelling beside the query', () => {
  assert.deepEqual(screen.querySlug('Vélmo'), { name: 'Vélmo', slug: 'velmo' });
  assert.deepEqual(screen.querySlug('Even lamp'), { name: 'Even lamp', slug: 'evenlamp' });
  assert.deepEqual(screen.querySlug('Vel-mo'), { name: 'Vel-mo', slug: 'velmo' });
});

test('a letter with no a–z spelling, or nothing left to search, is refused rather than dropped', () => {
  for (const [name, unsupported] of [
    ['Ølstad', 'Ø'],
    ['Straße', 'ß'],
    ['東京', '東 京'],
  ]) {
    const query = screen.querySlug(name);
    assert.equal(query.slug, undefined);
    assert.match(query.error, new RegExp(`no a–z spelling for ${unsupported},`));
  }
  assert.equal(screen.querySlug('---').slug, undefined);
  assert.match(screen.querySlug('---').error, /no letters or digits/);
});

test('the screen refuses an unsupported name before its first request, and exits nonzero', async () => {
  const script = new URL('./screen.mjs', import.meta.url).pathname;
  // Had it started, Velmo's report would be on stdout, or a failed request would exit 1.
  const run = promisify(execFile)(process.execPath, [script, 'Velmo', 'Ølstad', '東京']);
  const failure = await run.then(
    () => assert.fail('the screen ran'),
    err => err,
  );
  assert.equal(failure.code, 2);
  assert.equal(failure.stdout, '');
  assert.match(failure.stderr, /"Ølstad": no a–z spelling for Ø,/);
  assert.match(failure.stderr, /"東京": no a–z spelling for 東 京,/);
});
