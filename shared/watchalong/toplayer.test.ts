// CHROMIUM_PATH=… node --test shared/watchalong/toplayer.test.ts  .
// The agent's picture is the page as it's drawn: a page records itself in Chromium with the real recorder, and the
// mirror's picture of it is compared with the page's own screenshot, pixel by pixel, whatever is on it. The page shows
// what's over everything as HQ does (a popover layer holding a card, as the call's small window and cards are; a modal
// dialog; a popover shown again on top; one whose attribute is taken off, one removed), and so does a preview of another origin in
// its frame. A top layer the replay can't show fails the picture. Skipped without Chromium, Playwright or the
// coordinator's node_modules.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { Mirrors } from './mirror.ts';
import { playwright } from '../browser/browser.mjs';
import type { RecordedEvent } from './store.ts';

const COORDINATOR = new URL('../../platform/coordinator/', import.meta.url);
const REPLAY = new URL('node_modules/@rrweb/replay/dist/', COORDINATOR);
const RECORD = new URL('node_modules/@rrweb/record/dist/record.js', COORDINATOR);
const skip =
  !process.env.CHROMIUM_PATH || !existsSync(REPLAY) ? "needs CHROMIUM_PATH and the coordinator's npm ci" : false;
const WIDTH = 400,
  HEIGHT = 300;

// The recording page: a plain page, then what goes over it. No text: the two Chromium processes needn't draw a
// font alike.
const PAGE = `<!doctype html><body style="margin:0;background:#f4efe6">
<div style="position:absolute;left:20px;top:20px;width:360px;height:120px;background:#3a6ea5"></div>
<div id="layer" popover="manual" style="position:fixed;inset:0 auto auto 0;width:0;height:0;margin:0;padding:0;border:0;
  background:none;overflow:visible"><div style="position:fixed;right:16px;bottom:16px;width:150px;height:90px;
  background:#e8574f;border-radius:12px"></div></div>
<dialog id="dialog" style="width:120px;height:80px;padding:0;border:0;background:#2e9e5b"></dialog>
<div id="over" popover="manual" style="inset:auto auto 30px 30px;margin:0;width:100px;height:60px;padding:0;border:0;
  background:#f2c14e"></div>
<div id="kept" popover="manual" style="position:absolute;left:250px;top:170px;margin:0;width:60px;height:40px;
  padding:0;border:0;background:#8a4fbf"></div>
<div id="gone" popover="manual" style="inset:20px 20px auto auto;margin:0;width:50px;height:50px;padding:0;border:0;
  background:#1f2a44"></div>
<script type="module">
import { watch } from '/watchalong.js';
const watching = watch({ url: '/events?page', typed: 'shown' });
const frames = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
document.querySelector('#over').showPopover();
document.querySelector('#dialog').showModal();
document.querySelector('#layer').showPopover();
await frames();
// (the layer asked for again: it comes back on top, as HQ's call layer does)
document.querySelector('#over').hidePopover();
document.querySelector('#over').showPopover();
// (a popover's attribute taken off while it's open: it leaves the top layer, drawn where the page puts it; and one
// removed while open, which no event says)
document.querySelector('#kept').showPopover();
document.querySelector('#gone').showPopover();
await frames();
document.querySelector('#kept').removeAttribute('popover');
await frames();
document.querySelector('#gone').remove();
await new Promise(done => setTimeout(done, 300));
await watching.stop();
window.done = true;
</script>`;

// A preview in HQ's viewer: a page of another origin in a frame, recording as the framing page asks, with a popover of
// its own (a preview's menu or error)
const FRAMING = `<!doctype html><body style="margin:0;background:#f4efe6">
<iframe src="{{FRAME}}" style="position:absolute;left:20px;top:20px;width:300px;height:220px;border:0"></iframe>
<script type="module">
import { watch } from '/watchalong.js';
const watching = watch({ url: '/events?framing', typed: 'shown' });
await new Promise(done => addEventListener('message', e => e.data === 'shown' && done()));
await new Promise(done => setTimeout(done, 300));
await watching.stop();
window.done = true;
</script>`;
const FRAMED = `<!doctype html><body style="margin:0;background:#3a6ea5">
<div id="menu" popover="manual" style="inset:auto 20px 20px auto;margin:0;width:120px;height:70px;padding:0;border:0;
  background:#e8574f"></div>
<script type="module">
import { answerFrames } from '/watchalong.js';
const hear = answerFrames('{{FRAMER}}');
addEventListener('message', e => {
  if (e.data?.watchalong !== 'start') return;
  setTimeout(() => {
    document.querySelector('#menu').showPopover();
    requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage('shown', '*')));
  }, 200);
});
</script>`;

const FILES: Record<string, URL> = {
  '/watchalong.js': new URL('watchalong.js', import.meta.url),
  '/strokes.js': new URL('strokes.js', import.meta.url),
  '/toplayer.js': new URL('toplayer.js', import.meta.url),
  '/vendor/rrweb-record.js': RECORD,
};
const recorded: Record<string, RecordedEvent[]> = { page: [], framing: [] };
let server: Server | undefined;
const mirrors = new Mirrors(REPLAY, () => Promise.resolve(null));
after(async () => {
  await mirrors.closeAll();
  server?.close();
});

async function serve() {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url!, 'http://x'),
      path = url.pathname;
    if (path === '/events')
      recorded[url.search.slice(1)].push(...(JSON.parse(body) as { events: RecordedEvent[] }).events);
    const port = (server!.address() as { port: number }).port;
    const pages: Record<string, string> = {
      '/': PAGE,
      '/framing': FRAMING.replace('{{FRAME}}', `http://localhost:${port}/framed`),
      '/framed': FRAMED.replace('{{FRAMER}}', `http://127.0.0.1:${port}`),
    };
    const [type, text] =
      pages[path] !== undefined
        ? ['text/html', pages[path]]
        : path === '/events'
          ? ['application/json', '{}']
          : FILES[path]
            ? ['text/javascript', readFileSync(FILES[path])]
            : ['text/plain', ''];
    res.writeHead(text === '' ? 404 : 200, { 'content-type': type });
    res.end(text);
  });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server!.address() as { port: number }).port}/`;
}

// (sharp, from the coordinator's node_modules: what this test uses of it)
type Image = { raw(): Image; resize(w: number, h: number): Image; toBuffer(): Promise<Buffer> };
type Sharp = (input: Buffer) => Image;
// The share of pixels of two pictures of the same size that differ plainly (past antialiasing)
async function apart(a: Buffer, b: Buffer) {
  const sharp = createRequire(COORDINATOR)('sharp') as Sharp;
  const [x, y] = await Promise.all([a, b].map(p => sharp(p).resize(WIDTH, HEIGHT).raw().toBuffer()));
  let off = 0;
  for (let i = 0; i < x.length; i += 3) if (Math.max(...[0, 1, 2].map(c => Math.abs(x[i + c] - y[i + c]))) > 48) off++;
  return off / (x.length / 3);
}

let origin: Promise<string> | undefined;
// A page recorded in Chromium to its end: its own screenshot then, and its events
async function recording(path: string, events: RecordedEvent[]) {
  origin ??= serve();
  const { chromium } = playwright();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    await page.goto(new URL(path, await origin).href);
    await page.waitForFunction(() => (window as unknown as { done?: boolean }).done, null, { timeout: 15_000 });
    return { drawn: await page.screenshot(), events };
  } finally {
    await browser.close();
  }
}
const picture = async (id: number, events: RecordedEvent[]) => {
  await mirrors.open(id, events, () => false);
  return (await mirrors.now(id, { long: WIDTH, png: true }))!.bytes;
};
// (a `top` moment's ids, toplayer.js topOf: that file reads the browser's CSS as it loads)
const topOf = (e: RecordedEvent) =>
  e.type === 5 && e.data.tag === 'top' ? (e.data.payload as { id: number[] }).id : null;
const withoutTops = (events: RecordedEvent[]) => events.filter(e => !topOf(e));
let page: ReturnType<typeof recording> | undefined;
const pageRecording = () => (page ??= recording('/', recorded.page));

test("the mirror's picture is the page as drawn, what's over everything included", { skip }, async () => {
  const { drawn, events } = await pageRecording();
  const off = await apart(drawn, await picture(1, events));
  assert.ok(off < 0.01, `the mirror's picture is the page's (${(off * 100).toFixed(1)}% of it differs)`);
  // (the same recording without its top-layer moments: the check sees what a replay leaves out)
  const missing = await apart(drawn, await picture(2, withoutTops(events)));
  assert.ok(missing > 0.05, `without them the layer is missing (${(missing * 100).toFixed(1)}% differs)`);
});

test("a preview's popover in its frame is in the mirror's picture", { skip }, async () => {
  const { drawn, events } = await recording('/framing', recorded.framing);
  assert.ok(
    events.some(e => (topOf(e)?.length ?? 0) > 1),
    "the frame's top layer came up with the framing page's events",
  );
  const off = await apart(drawn, await picture(3, events));
  assert.ok(off < 0.01, `the mirror's picture is the page's (${(off * 100).toFixed(1)}% of it differs)`);
  const missing = await apart(drawn, await picture(4, withoutTops(events)));
  assert.ok(missing > 0.05, `without them the preview's popover is missing (${(missing * 100).toFixed(1)}% differs)`);
});

test("a top layer the replay can't show fails the picture", { skip }, async () => {
  const { events } = await pageRecording();
  const last = events.at(-1)!,
    [doc] = topOf(events.findLast(e => topOf(e))!)!;
  const unknown = { type: 5, timestamp: last.timestamp, data: { tag: 'top', payload: { id: [doc, 99_999] } } };
  await mirrors.open(5, [...events, unknown as RecordedEvent], () => false);
  await assert.rejects(mirrors.now(5, { long: WIDTH, png: true }), /top layer's element 99999 isn't in/);
});
