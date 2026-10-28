// node --test src/ink/bookfetch.test.ts   (a local server stands in for the web; no DATA_DIR)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { MAX_BYTES, fetchPicture } from './bookfetch.ts';

const RED = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#ff0000' } })
  .png()
  .toBuffer();
// prettier-ignore
const SITE: Record<string, [string, Buffer | string, Record<string, string>?]> = {
  '/red.png': ['image/png', RED],
  '/red': ['application/octet-stream', RED],
  '/page.html': ['text/html', '<p>Not a picture</p>'],
  '/drawing.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  '/fake.png': ['image/png', 'not a picture at all'],
  '/huge.png': ['image/png', '', { 'content-length': String(MAX_BYTES + 1) }],
};
// the web's stand-in: its pictures and pages, and a redirect to wherever ?to= says
const web = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x'),
    to = url.searchParams.get('to');
  if (to) return res.writeHead(302, { location: to }).end();
  const [type, body, headers] = SITE[url.pathname] ?? ['text/plain', 'not found'];
  if (headers) return res.writeHead(200, { 'content-type': type, ...headers }).end();
  res.writeHead(SITE[url.pathname] ? 200 : 404, { 'content-type': type }).end(body);
});
// HQ's route as server.ts serves it, reachable: the addresses it may connect to (the default: the open web only)
const route = (reachable?: (address: string) => boolean) =>
  http.createServer((req, res) => {
    const address = new URL(req.url ?? '/', 'http://x').searchParams.get('url') ?? '';
    return reachable ? fetchPicture(res, address, reachable) : fetchPicture(res, address);
  });
const listening = async (server: http.Server) => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const site = await listening(web),
  // (the stand-in's own address counts as the open web here, and no other inside one)
  standIn = route(a => a === '127.0.0.1'),
  guarded = route();
const hq = { standIn: await listening(standIn), guarded: await listening(guarded) };
after(() => [web, standIn, guarded].forEach(s => s.close()));
const fetched = (via: string, url: string) => fetch(`${via}/?url=${encodeURIComponent(url)}`);
const why = async (r: Response) => {
  const { error, page } = (await r.json()) as { error: string; page?: true };
  return [r.status, error, page === true] as const;
};

test('a picture on the web comes as its bytes, through redirects, whatever binary type the site calls it', async () => {
  for (const url of [`${site}/red.png`, `${site}/red`, `${site}/?to=${encodeURIComponent('/red.png')}`]) {
    const r = await fetched(hq.standIn, url);
    assert.equal(r.status, 200, url);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), RED);
  }
});

test('a page, an SVG, bytes that only claim to be a picture and one too large are refused, saying why', async () => {
  // (only the page is marked one: the rest are pictures that didn't come)
  for (const [path, status, isPage] of [
    ['/page.html', 415, true],
    ['/drawing.svg', 415, false],
    ['/fake.png', 415, false],
    ['/huge.png', 413, false],
    ['/gone.png', 502, false],
  ] as const) {
    const [code, error, page] = await why(await fetched(hq.standIn, `${site}${path}`));
    assert.equal(code, status, path);
    assert.ok(error.length > 10, `${path}: ${error}`);
    assert.equal(page, isPage, `${path}: a page?`);
  }
});

test('nothing inside a network is fetched: this machine, private and link-local addresses, IPv6 ways into them', async () => {
  const port = new URL(site).port;
  for (const url of [
    `${site}/red.png`,
    `http://localhost:${port}/red.png`,
    `http://[::1]:${port}/red.png`,
    `http://[::ffff:127.0.0.1]:${port}/red.png`,
    'http://10.0.0.8/red.png',
    'http://192.168.1.1/red.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00::1]/red.png',
  ])
    assert.equal((await fetched(hq.guarded, url)).status, 403, url);
  // (a redirect from the open web to inside is checked again)
  const inside = `http://127.0.0.2:${port}/red.png`;
  assert.equal((await fetched(hq.standIn, `${site}/?to=${encodeURIComponent(inside)}`)).status, 403);
});

test('only http and https addresses, without a login in them', async () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/a.png',
    'not an address',
    `http://me:pw@${site.slice(7)}/red.png`,
  ])
    assert.equal((await fetched(hq.standIn, url)).status, 400, url);
});
