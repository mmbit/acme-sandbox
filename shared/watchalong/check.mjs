// The watch-along end to end in Chromium: a page records itself and a page of another origin in its frame (as HQ and a
// preview in its viewer), someone taps, types and moves on in the frame, and rrweb's replayer draws the moment back.
// It checks what the recording holds and keeps out (typed values in the frame, a password, a hidden part, the address's
// query) and that the frame's page is in the replay.
// The frame's page loads the recorder as review mode's script does (framed.js), only once asked; the desk's canvas is in the replay as
// its pictures, and a private one never.
// A pen stroke circles the shop's button in the frame (ink.js's pen): its ink is in the recording as data, sampled, with
// what's under it named, and drawn over the replay in the frame's place.
//   node shared/watchalong/check.mjs [--shots dir]   (needs platform/coordinator's node_modules: npm ci there)
// Exit 1 on any failure.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { playwright, openPage } from '../browser/browser.mjs';

const REPO = new URL('../..', import.meta.url).pathname;
const MODULES = `${REPO}/platform/coordinator/node_modules`;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : `${tmpdir()}/watchalong-check`;
const RECORDER = {
  '/watchalong.js': `${REPO}/shared/watchalong/watchalong.js`,
  '/canvas.js': `${REPO}/shared/watchalong/canvas.js`,
  '/encoder.js': `${REPO}/shared/watchalong/encoder.js`,
  '/strokes.js': `${REPO}/shared/watchalong/strokes.js`,
  '/ink.js': `${REPO}/shared/review/ink.js`,
};
RECORDER['/vendor/rrweb-record.js'] = `${MODULES}/@rrweb/record/dist/record.js`;

// What no recording holds: a password, a hidden field, a hidden part, a frame's one-time code, an email link's address,
// the page's title and a later one; a private part's text and typing, its elements' own words and its pictures (by
// their address: a picture tag's goes with its attributes as well as by the block, so only the private canvases' frames
// below prove they stay out; a style's background goes by withoutPictures), there from the start or added later
const KEPT_OUT = [
  'Titled Jane',
  'Retitled Jane',
  'JANE-PHOTO',
  'LATE-PHOTO',
  'BACKDROP-PHOTO',
  'LATE-BACKDROP',
  'DIFF-BACKDROP',
  'UPPER-BACKDROP',
  '4321',
  'HIDDEN-TOKEN',
  'NEVER-RECORDED',
  'one-time-123',
  'hello@shop.test',
  'Private Street',
  'Dear customer',
  'Private Lane',
  'jane.doe',
  'Jane at home',
  'Data Jane',
  'Changed Jane',
  '31611111111',
  'Late Jane',
  'data-jane',
  'M1.25 2.75',
];
// rrweb's incremental source for a canvas's frames
const CANVAS = 9;
const batches = [];
const desk = await serve('127.0.0.1', (path, body) => {
  if (path === '/events') return batches.push(JSON.parse(body)) && ['{}', 'application/json'];
  // (workers as HQ's policy allows them, its own origin's only: a blob's was refused, and no canvas reached a call.
  if (path === '/') return [deskPage(shop.origin), 'text/html', { 'content-security-policy': "worker-src 'self'" }];
  if (path === '/replay') return [replayPage(), 'text/html'];
  if (path === '/replay.js') return [readFileSync(`${MODULES}/@rrweb/replay/dist/replay.js`), 'text/javascript'];
  if (path === '/replay.css') return [readFileSync(`${MODULES}/@rrweb/replay/dist/style.css`), 'text/css'];
  return recorderFile(path.replace('/shared/watchalong', ''));
});
const shop = await serve('localhost', path => {
  if (path === '/__review/review.js') return [reviewMode(desk.origin), 'text/javascript'];
  if (path === '/shop.html') return [shopPage('Mugs', '<a href="/basket.html">Basket</a>'), 'text/html'];
  if (path === '/basket.html') return [shopPage('Your basket', '<p>One mug</p>'), 'text/html'];
  return recorderFile(path.replace('/__review', ''));
});

const { chromium } = playwright();
const browser = await chromium.launch();
try {
  // A guest: typing hidden everywhere, the frame too
  const guest = await walkThrough('hidden');
  for (const secret of ['board words', 'Secret Name', ...KEPT_OUT])
    assert.ok(!guest.text.includes(secret), `a guest's ${secret} stays out of the recording`);
  // The board: its own typing kept, in the frame too, but never a password
  const board = await walkThrough('shown');
  for (const typed of ['board words', 'Secret Name'])
    assert.ok(board.text.includes(typed), `the board's ${typed} is kept`);
  for (const secret of KEPT_OUT)
    assert.ok(!board.text.includes(secret), `the board's ${secret} stays out of the recording`);
  for (const { events, text } of [guest, board]) {
    const custom = tag => events.filter(e => e.type === 5 && e.data.tag === tag).map(e => e.data.payload);
    const taps = custom('tap').map(tap => `${tap.role}: ${tap.label}`);
    for (const tap of ['button: Open the shop', 'button: Add to basket', 'a: Basket'])
      assert.ok(taps.includes(tap), taps.join(' | '));
    assert.ok(taps.includes('button: '), `a tap on a control holding a private part has no label: ${taps.join(' | ')}`);
    const pages = custom('page').map(page => new URL(page.address).pathname);
    for (const path of ['/', '/shop.html', '/basket.html']) assert.ok(pages.includes(path), pages.join(' | '));
    assert.ok(text.includes('"mailto:"'), 'an email link keeps its kind');
    assert.ok(
      events.some(e => e.type === 4 && e.data.href === `${desk.origin}/`),
      'the address without its query',
    );
    assert.ok(!text.includes('?code'), 'no query string anywhere');
    // the private parts' canvases: the picture block and the sampler keep their frames out
    const pictured = new Set(events.filter(e => e.type === 3 && e.data.source === CANVAS).map(e => e.data.id));
    assert.equal(pictured.size, 1, "the desk's canvas is pictured, and its private ones never");
    inkRecorded(custom('ink'));
  }
  mkdirSync(SHOTS, { recursive: true });
  for (const [who, run] of Object.entries({ guest, board })) {
    writeFileSync(`${SHOTS}/${who}.png`, await replayed(run));
    console.log(`ok: ${who}, ${run.events.length} events, ${(Buffer.byteLength(run.text) / 1024).toFixed(0)} KB`);
  }
  console.log(`the moment after "Add to basket", replayed: ${SHOTS}/guest.png and board.png`);
} finally {
  await browser.close();
  desk.server.close();
  shop.server.close();
}

// One walk through the desk and the shop in its frame: the events recorded, as text too, and when the shop's button
// was tapped
async function walkThrough(typed) {
  batches.length = 0;
  const { page, context, errors } = await openPage(browser, { viewport: { width: 800, height: 700 } });
  await page.goto(`${desk.origin}/?code=one-time-123&typed=${typed}`);
  await page.waitForFunction(() => window.watching);
  const frame = await shopFrame(page, 'Mugs');
  await page.getByText('Open the shop').click();
  await page.getByRole('button', { name: 'Ship to' }).click();
  await page.getByLabel('Your note').fill('board words');
  await page.getByPlaceholder('PIN').fill('4321');
  await page.getByLabel('Reply').fill('Dear customer');
  await frame.getByLabel('Name on the mug').fill('Secret Name');
  await frame.getByText('Add to basket').click();
  const tappedAt = Date.now();
  await page.waitForTimeout(300);
  const drawnAt = await circle(page, frame);
  await frame.getByRole('link', { name: 'Basket' }).click();
  await shopFrame(page, 'Your basket');
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.watching.stop());
  assert.deepEqual(errors, []);
  await context.close();
  const events = batches.flatMap(batch => batch.events);
  return { events, text: JSON.stringify(events), tappedAt, drawnAt };
}

// A loop drawn around the shop's button with the mouse, through review mode's kind of veil over the frame's page, slowly
// enough for its moves to be sampled. Returns when it ended, and the loop's top left on the screen.
async function circle(page, frame) {
  const shop = page.frames().find(f => f.url().includes('/shop.html'));
  await shop.evaluate(() => window.drawOn());
  const button = await frame.getByText('Add to basket').boundingBox();
  const [cx, cy, rx, ry] = [
    button.x + button.width / 2,
    button.y + button.height / 2,
    button.width * 0.62,
    button.height * 0.9,
  ];
  await page.mouse.move(cx + rx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    const a = (i / 40) * 2 * Math.PI;
    await page.mouse.move(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(100);
  return { at: Date.now(), x: cx + rx, y: cy };
}

// The frame's stroke as the recording has it: begun, its moves sampled (fewer than drawn, each only its new points, all
// of them adding up to the stroke), ended whole with the button under it named, and then the frame's dry ink shown,
// all on the frame's own document (not the desk's)
function inkRecorded(inks) {
  const [start, ...rest] = inks;
  const moves = rest.filter(ink => ink.phase === 'move'),
    end = rest.find(ink => ink.phase === 'end');
  assert.equal(start?.phase, 'start', JSON.stringify(inks).slice(0, 300));
  assert.ok(end, 'the stroke ended');
  assert.ok(moves.length >= 3 && moves.length < 40, `its moves sampled: ${moves.length}`);
  const pieced = [...start.stroke.points, ...moves.flatMap(move => move.points)];
  assert.deepEqual(pieced, end.stroke.points.slice(0, pieced.length), 'the moves carry only the new points');
  assert.ok(end.stroke.points.length - pieced.length < 15, 'what the moves left out is the last tenth of a second');
  assert.deepEqual(end.under[0], { role: 'button', label: 'Add to basket' }, JSON.stringify(end.under));
  assert.ok(start.id > 1 && end.id === start.id, "on the frame's document, as the desk's recording numbers it");
  assert.ok(
    inks.some(ink => ink.phase === 'shown' && ink.strokes.length === 1),
    "the frame's dry ink shown after it ended",
  );
}

// rrweb's replayer at the moment just after the shop's button was tapped, with the shop's page in its frame: a picture
async function replayed({ events, tappedAt, drawnAt }) {
  const { page, context, errors } = await openPage(browser, { viewport: { width: 800, height: 700 } });
  await page.goto(`${desk.origin}/replay`);
  await page.evaluate(({ events, at }) => window.show(events, at), {
    events,
    at: tappedAt - events[0].timestamp + 100,
  });
  // the stroke, drawn over the replay at the moment after it ended: its red where the mouse began it
  const red = await page.evaluate(({ events, at, x, y }) => window.inked(events, at, x, y), {
    events,
    at: drawnAt.at,
    ...drawnAt,
  });
  assert.ok(red, "the stroke is drawn over the replay, in the frame's place");
  await page.frameLocator('iframe').first().frameLocator('iframe').first().getByText('Add to basket').waitFor();
  // the desk's canvas, drawn from its pictures: red, as the page drew it
  await page.waitForFunction(() => {
    const canvas = document.querySelector('iframe').contentDocument.querySelector('#drawn');
    const [r, g, b] = canvas.getContext('2d').getImageData(100, 50, 1, 1).data;
    return r > 200 && g < 80 && b < 80;
  });
  const picture = await page.screenshot();
  assert.deepEqual(errors, []);
  await context.close();
  return picture;
}

// The shop's frame, once its page with this title has loaded
async function shopFrame(page, title) {
  await page.waitForFunction(t => document.querySelector('iframe')?.dataset.loaded === t, title);
  return page.frameLocator('iframe');
}

function deskPage(shopOrigin) {
  return `<!doctype html><title>Desk: Titled Jane</title>
<style>body{font:16px sans-serif;margin:0}header{background:#234;color:#fff;padding:12px}iframe{width:100%;height:420px;border:0}</style>
<header><button>Open the shop</button> <input aria-label="Your note"> <input type="password" placeholder="PIN"></header>
<div data-watchalong-hide>NEVER-RECORDED: the call's own bubble</div>
<p data-private style="--pic: URL('${picture('UPPER-BACKDROP')}')">Ship to: Private Street 1 <input aria-label="Reply"> <a href="mailto:jane.doe@example.com">write</a>
<img alt="Jane at home" src="${picture('JANE-PHOTO')}"> <i id="backdrop" style="display:inline-block;width:20px;height:20px;background:url('${picture('BACKDROP-PHOTO')}') #eee"></i> <canvas width="60" height="20"></canvas> <span id="later" data-name="Data Jane">her phone</span></p>
<button>Ship to <span data-private>Private Lane</span></button> <a href="mailto:hello@shop.test">Mail us</a>
<input type="hidden" value="HIDDEN-TOKEN">
<canvas id="drawn" width="200" height="100"></canvas> <svg width="20" height="20"><path data-private d="M1.25 2.75L9 9"/></svg>
<span data-private data-email="data-jane@example.com"><canvas id="theirs" width="50" height="50"></canvas></span>
<iframe src="${shopOrigin}/shop.html?code=one-time-123" onload="this.dataset.loaded = 'loading'"></iframe>
<script type="module">
import { watch } from '/shared/watchalong/watchalong.js';
addEventListener('message', event => event.data?.loaded && (document.querySelector('iframe').dataset.loaded = event.data.loaded));
const sketch = document.querySelector('canvas').getContext('2d');
sketch.fillText('Jane', 5, 15);
for (const [id, colour] of [['drawn', '#e02020'], ['theirs', '#20e020']]) {
  const g = document.getElementById(id).getContext('2d');
  g.fillStyle = colour;
  g.fillRect(0, 0, 200, 100);
}
const typed = new URLSearchParams(location.search).get('typed');
window.watching = watch({ url: '/events', typed, canvasFps: 2 });
setTimeout(() => {
  document.querySelector('#later').title = 'Changed Jane';
  document.querySelector('#later').setAttribute('style', "background-image:url('${picture('LATE-BACKDROP')}')");
  document.querySelector('#backdrop').style.backgroundImage = "url('${picture('DIFF-BACKDROP')}')";
  document.title = 'Desk: Retitled Jane';
  document.body.insertAdjacentHTML('beforeend', '<p data-private><a href="tel:+31611111111" title="Late Jane">call</a> <img src="${picture('LATE-PHOTO')}"></p>');
}, 300);
</script>`;
}

// A small picture whose address carries these words
function picture(words) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><desc>${words}</desc></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function shopPage(title, more) {
  return `<!doctype html><title>${title}</title>
<style>body{font:18px sans-serif;background:#fde;margin:20px}</style>
<h1>${title}</h1><label>Name on the mug <input></label> <button>Add to basket</button> ${more}
<script src="/__review/review.js" defer></script>
<script type="module">
import { pen, shown } from '/__review/ink.js';
addEventListener('message', event => event.data?.watchalong === 'start' && parent.postMessage({ loaded: document.title }, '*'));
// review mode's kind of veil: the page under a surface the pen draws on, its ink kept out of the recording as pixels
window.drawOn = () => {
  document.body.insertAdjacentHTML('beforeend', '<div id="veil" style="position:fixed;inset:0;z-index:9"><canvas data-watchalong-hide style="position:absolute;inset:0;width:100%;height:100%"></canvas><canvas id="dry" data-watchalong-hide style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"></canvas></div>');
  const veil = document.getElementById('veil');
  pen(veil, veil.querySelector('canvas'), { halo: true, ink: () => ({ color: '#ff0000', size: 6 }), end: stroke => {
    shown(document.getElementById('dry'), [stroke], { halo: true });
    veil.style.pointerEvents = 'none';
  } });
};
</script>`;
}

function replayPage() {
  return `<!doctype html><link rel="stylesheet" href="/replay.css"><body style="margin:0">
<script>window.process = { env: { NODE_ENV: 'production' } };</script>
<script type="module">
import { Replayer } from '/replay.js';
import { inkAt, paint, placer } from '/shared/watchalong/strokes.js';
import * as ink from '/shared/watchalong/ink.js';
// (canvas pictures replay only with UNSAFE_replayCanvas, rrweb's own as ours)
let replayer = null;
window.show = (events, at) =>
  (replayer = new Replayer(events, { root: document.body, mouseTail: false, UNSAFE_replayCanvas: true })).pause(at);
// The ink at a time drawn on a canvas over the replay (the page's clock): whether it's red at x, y
window.inked = (events, time, x, y) => {
  const canvas = document.createElement('canvas');
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  canvas.style.cssText = 'position:absolute;left:0;top:0;z-index:5';
  document.body.append(canvas);
  paint(ink, canvas.getContext('2d'), inkAt(events, time), placer(replayer));
  const [r, g, b] = canvas.getContext('2d').getImageData(Math.round(x) - 1, Math.round(y), 1, 1).data;
  return r > 200 && g < 80 && b < 80;
};
</script>`;
}

// Review mode as the coordinator serves it to the board, with the watch-along's answer after it, HQ's origin filled in: the desk's
function reviewMode(deskOrigin) {
  return ['review/review.js', 'watchalong/framed.js']
    .map(file => readFileSync(`${REPO}/shared/${file}`, 'utf8').replace('{{HQ_ORIGIN}}', deskOrigin))
    .join('');
}

function recorderFile(path) {
  return RECORDER[path] ? [readFileSync(RECORDER[path]), 'text/javascript'] : null;
}

// A server on its own origin, answering by path: [body, type, headers?] or null for a 404
async function serve(host, answer) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const answered = answer(new URL(req.url, 'http://x').pathname, body);
    res.writeHead(answered ? 200 : 404, { 'content-type': answered?.[1] ?? 'text/plain', ...answered?.[2] });
    res.end(answered?.[0] ?? 'not found');
  });
  await new Promise(resolve => server.listen(0, host, resolve));
  return { server, origin: `http://${host}:${server.address().port}` };
}
