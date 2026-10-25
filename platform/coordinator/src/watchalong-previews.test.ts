// node --test src/watchalong-previews.test.ts   (the harness's server, a stand-in for Caddy at the preview hosts; the
// pictures need Chromium: CHROMIUM_PATH)
// The watch-along's mirror loads a preview's pictures, fonts and stylesheets when its recording was there, and nothing
// else.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { harness } from './harness.ts';

const HQ = 'hq.company.test',
  HELLO = 'hello.preview.company.test',
  OTHER = 'other.preview.company.test';

// A stand-in for Caddy at every preview host: it asks the coordinator's check as Caddy's forward_auth does, and serves
// the preview's files when it lets the request through. reached: what came to it.
const WIDE_TTF = // (made with fontTools' FontBuilder: one glyph, W, a box 2 em wide)
  'AAEAAAAKAIAAAwAgT1MvMkU3RtUAAAEoAAAAYGNtYXAADACqAAABkAAAADRnbHlmJos9+AAAAcwAAAAYaGVhZDTsB9oAAACsAAAANmhoZWEK8gcLAAAA5AAAACRobXR4CcQAAAAAAYgAAAAIbG9jYQAMAAAAAAHEAAAABm1heHAABAAGAAABCAAAACBuYW1lRz1wbgAAAeQAAABXcG9zdAA+AAAAAAI8AAAAJgABAAAAAQAAq6CTUl8PPPUAAwPoAAAAAOcC4h8AAAAA5wLiHwAAAAAH0AK8AAAAAwACAAAAAAAAAAEAAAMg/zgAAAfQAAAAAAfQAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAQAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwTiAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAAFcAVwMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAAB9AAAB9AAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAAAV///AAAAV////6oAAQAAAAAAAAAAAAwAAAABAAAAAAfQArwAAwAAMREhEQfQArz9RAAAAAQANgABAAAAAAABAAQAAAABAAAAAAACAAcABAADAAEECQABAAgACwADAAEECQACAA4AE1dpZGVSZWd1bGFyAFcAaQBkAGUAUgBlAGcAdQBsAGEAcgAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAOgAA';
const RED = { r: 230, g: 20, b: 20 },
  BLUE = { r: 20, g: 40, b: 230 };
const square = (background: typeof RED) =>
  sharp({ create: { width: 10, height: 10, channels: 3, background } })
    .png()
    .toBuffer();
const FILES: Record<string, Buffer> = {
  '/red.png': await square(RED),
  '/blue.png': await square(BLUE),
  '/wide.ttf': Buffer.from(WIDE_TTF, 'base64'),
  '/look.css': Buffer.from('.box { width: 100px; height: 100px; background: url(blue.png) }'),
  '/app.js': Buffer.from('document.body.remove()'),
  '/page.html': Buffer.from('<p>a page</p>'),
};
const reached: { host: string; path: string; method: string; cookie: string; checked: number }[] = [];
let base = '';
const caddy = createServer(async (req, res) => {
  const host = String(req.headers.host),
    path = String(req.url),
    method = String(req.method),
    cookie = req.headers.cookie ?? '';
  const asked = await fetch(`${base}/api/preview/check`, {
    headers: { cookie, 'x-forwarded-host': host, 'x-forwarded-uri': path, 'x-forwarded-method': method },
    redirect: 'manual',
  });
  reached.push({ host, path, method, cookie, checked: asked.status });
  const file = asked.status === 200 ? FILES[path] : undefined;
  res.writeHead(file ? 200 : asked.status === 200 ? 404 : 403).end(file);
}).listen(0);
await new Promise(resolve => caddy.once('listening', resolve));
after(() => caddy.close());

const h = await harness('watchalong-previews', {
  env: { PUBLIC_HOST: HQ, PREVIEWS_VIA: `http://127.0.0.1:${(caddy.address() as AddressInfo).port}` },
});
base = h.base;
const { ORIGIN } = await import('./config.ts');
const watchalong = await import('./watchalong.ts');
const { mirrored } = await import('./previewfiles.ts');
after(() => watchalong.closeMirrors());
const noChromium =
  process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH) ? false : 'no Chromium here (CHROMIUM_PATH)';

// A walk-through on HQ's page, a preview of hello in its frame (its page moment), and what that preview showed: a
// picture, a box drawn by its stylesheet, a line in its font with a button after it, which was tapped. And what the mirror
// must not load: the preview's script and page, a preview the recording wasn't on, another site.
let id = 0;
const node = (tagName: string, attributes: Record<string, string> = {}, childNodes: object[] = []) => ({
  type: 2,
  tagName,
  attributes,
  childNodes,
  id: ++id,
});
const at = (path: string, host = HELLO) => `https://${host}${path}`;
// (more: more pictures, after the rest)
const page = (more: string[] = []) => {
  const t = Date.now();
  const box = (src: string) => node('img', { src, style: 'width: 10px; height: 10px' });
  const head = node('head', {}, [
    node('style', { _cssText: `@font-face { font-family: Wide; src: url(${at('/wide.ttf')}) }` }),
    node('link', { rel: 'stylesheet', href: at('/look.css') }),
  ]);
  const line = node('div', { style: 'height: 60px; line-height: 60px; font-size: 40px; white-space: nowrap' }, [
    node('span', { style: 'font-family: Wide' }, [{ type: 3, textContent: 'WW', id: ++id }]),
    node('button', {
      style: 'display: inline-block; vertical-align: top; width: 60px; height: 60px; border: 0; background: #0a0',
      'aria-label': 'Add',
    }),
  ]);
  const body = node('body', { style: 'margin: 0' }, [
    node('div', { style: 'display: flex' }, [
      node('img', { src: at('/red.png'), style: 'display: block; width: 100px; height: 100px' }),
      node('div', { class: 'box' }),
    ]),
    line,
    node('div', {}, [
      box(at('/app.js')),
      box(at('/page.html')),
      box(at('/red.png', OTHER)),
      box('https://example.com/red.png'),
      ...more.map(box),
    ]),
  ]);
  const doc = {
    type: 0,
    childNodes: [{ type: 1, name: 'html', publicId: '', systemId: '', id: ++id }, node('html', {}, [head, body])],
    id: ++id,
  };
  return [
    { type: 4, data: { href: `${ORIGIN}/`, width: 400, height: 300 }, timestamp: t },
    { type: 2, data: { node: doc, initialOffset: { left: 0, top: 0 } }, timestamp: t + 1 },
    { type: 5, data: { tag: 'page', payload: { address: at('/') } }, timestamp: t + 2 },
    // (the button after "WW" in the preview's font: 160 px in, 60 px wide)
    {
      type: 5,
      data: { tag: 'tap', payload: { x: 190, y: 130, pointer: 'mouse', role: 'button', label: 'Add' } },
      timestamp: t + 3,
    },
  ];
};

// The screen tool's picture at the tap, and the pass the stand-in saw, from a live call walked through that page
const walked = async (more: string[] = []) => {
  const ctx = await h.liveCall('wren');
  const started = await fetch(`${base}/api/watchalong/start`, {
    method: 'POST',
    headers: { cookie: h.boardCookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ call: ctx.call, key: ctx.key }),
  });
  const { events } = (await started.json()) as { events: string };
  const posted = await fetch(`${base}${events}`, {
    method: 'POST',
    headers: { origin: ORIGIN },
    body: JSON.stringify({ events: page(more) }),
  });
  assert.equal(posted.status, 200);
  const screen = (body: Record<string, unknown>) =>
    h.voice('screen', { purpose: 'call', ref: String(ctx.call), ...body });
  const listed: string[] = (await screen({ since: '#1' })).body.lines;
  const tap = listed.find(line => line.includes('tapped "Add"'))?.match(/^#(\d+)/)?.[1];
  assert.ok(tap, listed.join('\n'));
  const shot = (await screen({ at: `#${tap}` })).body;
  return { ctx, picture: Buffer.from(shot.picture.data, 'base64') };
};
// The colour of the picture at a place on the recorded screen (400 px wide)
const colourAt = async (picture: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(picture).raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / 400,
    i = (Math.round(y * scale) * info.width + Math.round(x * scale)) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
};
const near = (seen: typeof RED, meant: typeof RED) =>
  Math.abs(seen.r - meant.r) + Math.abs(seen.g - meant.g) + Math.abs(seen.b - meant.b) < 60;

test(
  "a preview's pictures, stylesheets and fonts show in the mirror's picture, so the ring is on the tapped button",
  { skip: noChromium },
  async () => {
    const { picture } = await walked();
    const colour = (x: number, y: number) => colourAt(picture, x, y);
    assert.ok(near(await colour(50, 50), RED), 'the picture');
    assert.ok(near(await colour(150, 50), BLUE), "the stylesheet's picture");
    assert.ok(near(await colour(190, 130), { r: 0, g: 170, b: 0 }), 'the button, laid out after the line in its font');
  },
);

test(
  "the mirror's pass opens only the pictures, fonts and stylesheets of a preview its recording was on",
  { skip: noChromium },
  async () => {
    reached.length = 0;
    await walked();
    // (each tab loads them: the live screen's, and the moment's)
    const asked = [...new Set(reached.map(r => `${r.method} ${r.host}${r.path} ${r.checked}`))].sort();
    assert.deepEqual(asked, [
      `GET ${HELLO}/blue.png 200`,
      `GET ${HELLO}/look.css 200`,
      `GET ${HELLO}/red.png 200`,
      `GET ${HELLO}/wide.ttf 200`,
    ]);
    // the pass itself, held up to Caddy's check: no page, script, other method, other host or the chat's route
    const pass = reached[0].cookie;
    assert.match(pass, /^pp=[\w-]{43}$/);
    const check = async (uri: string, { host = HELLO, method = 'GET', query = '' } = {}) =>
      (
        await fetch(`${base}/api/preview/check${query}`, {
          headers: { cookie: pass, 'x-forwarded-host': host, 'x-forwarded-uri': uri, 'x-forwarded-method': method },
          redirect: 'manual',
        })
      ).status;
    assert.equal(await check('/red.png?v=2'), 200);
    for (const [uri, options] of [
      ['/', {}],
      ['/app.js', {}],
      ['/shop/', {}],
      ['/red.png', { method: 'POST' }],
      ['/red.png', { host: OTHER }],
      ['/__care/chat.css', { query: '?board=1' }],
    ] as const)
      assert.notEqual(await check(uri, options), 200, `${uri} ${JSON.stringify(options)}`);
  },
);

test(
  "a guest's walk-through shows only the previews its share reaches, whatever its recording names",
  { skip: noChromium },
  async () => {
    reached.length = 0;
    // (the share reaches hello alone, as callline.ts startWatching hands over its hosts; the page says it was on other)
    const callout = 990_001;
    const { events } = watchalong.startOnCallout(callout, [`https://${HELLO}`]);
    const recorded = page();
    const t = recorded.at(-1)!.timestamp;
    recorded.push({ type: 5, data: { tag: 'page', payload: { address: at('/', OTHER) } }, timestamp: t + 1 });
    const posted = await fetch(`${base}${events}`, {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: JSON.stringify({ events: recorded }),
    });
    assert.equal(posted.status, 200);
    const shot = (await h.voice('screen', { purpose: 'callout', ref: String(callout), at: 'now' })).body;
    assert.ok(near(await colourAt(Buffer.from(shot.picture.data, 'base64'), 50, 50), RED), "hello's picture");
    assert.deepEqual([...new Set(reached.map(r => r.host))], [HELLO], 'nothing asked of other');
  },
);

const MIRRORED_MS = 5000;

test('a recorded address with a // path or a port never leaves the preview host', async () => {
  const heard: string[] = [];
  const elsewhere = createServer((req, res) => {
    heard.push(`${req.url} ${req.headers.cookie ?? ''}`);
    res.writeHead(200, { 'content-type': 'image/png' }).end(FILES['/red.png']);
  }).listen(0);
  await new Promise(resolve => elsewhere.once('listening', resolve));
  try {
    const port = (elsewhere.address() as AddressInfo).port;
    reached.length = 0;
    // (the // path is asked of hello itself, which has no such file)
    assert.equal(await mirrored(new URL(at(`//127.0.0.1:${port}/red.png`)), MIRRORED_MS), null);
    assert.deepEqual(
      reached.map(r => `${r.host}${r.path}`),
      [`${HELLO}//127.0.0.1:${port}/red.png`],
    );
    reached.length = 0;
    assert.equal(await mirrored(new URL(`https://${HELLO}:${port}/red.png`), MIRRORED_MS), null);
    assert.deepEqual(reached, [], 'a port is never asked');
    assert.deepEqual(heard, [], 'nothing reached the listener, no pass either');
    assert.deepEqual(await mirrored(new URL(at('/red.png')), MIRRORED_MS), {
      type: 'image/png',
      body: FILES['/red.png'],
    });
  } finally {
    elsewhere.close();
  }
});
