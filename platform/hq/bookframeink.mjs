// On a call, the Pencil on the artifact in HQ's viewer: a mark that settles goes to HQ, which puts it on the call's page
// for the call's agent with the words the call heard while it was drawn ('/api/book/note'), and nothing goes into the
// notebook by itself; no post-it opens, the ink is red and stays drawn until the agent's turn on it is done
// ('call:had'), and hung up, any left goes. Off a call the artifact's pin flow is as it was: the post-it opens (the
// board, call 161.)
import assert from 'node:assert/strict';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { DESKTOP, chromiumPen, until } from './bookkit.mjs';

const ARTIFACT = 'https://shop.preview.test';
const CALL = { call: 5, agent: 'juno', name: 'Juno', color: '#7b5ea7' };
const loop = (cx, cy, rx, ry, n = 40) =>
  Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos((i / n) * 6.1), cy + ry * Math.sin((i / n) * 6.1)]);
// The artifact's ink layer in a box (CSS px): how many pixels are drawn, and how many of them red
const inked = (frame, box) =>
  frame.evaluate(({ x, y, w, h }) => {
    const c = document.querySelector('review-mode').shadowRoot.querySelector('canvas.ink'),
      k = c.width / innerWidth,
      d = c.getContext('2d').getImageData(x * k, y * k, w * k, h * k).data;
    let n = 0,
      red = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i + 3] > 200) {
        n++;
        if (d[i] > 180 && d[i + 1] < 110 && d[i + 2] < 110) red++;
      }
    return { n, red };
  }, box);
const FIRST = { x: 60, y: 60, w: 400, h: 200 },
  SECOND = { x: 60, y: 300, w: 400, h: 200 };

// c: book-check's { browser, hqIn, base, posts, noErrorsIn, reviewJs, shot }
export async function frameInkStory(c) {
  const context = await c.hqIn(c.browser, DESKTOP, { deviceScaleFactor: 1, hasTouch: false });
  try {
    const s = await opened(c, context);
    await heldForAgent(c, s);
    await hadAndHungUp(c, s);
    await offCall(c, s);
    c.noErrorsIn(s.errors);
  } finally {
    await context.close();
  }
}
// HQ on a call, the artifact open in its viewer: what the story draws and reads with
async function opened(c, context) {
  await context.route(`${ARTIFACT}/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, c.reviewJs)) return;
    if (path.startsWith('/__review/')) return r.fulfill({ json: { show: false } });
    return r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Shop</title><body style="margin:0;height:1600px">
          <h1 style="margin:120px 0 0 120px">Your basket</h1><p style="margin:260px 0 0 120px">Pay now</p>
          <script src="/__review/review.js"></script>`,
    });
  });
  await context.route(`${c.base}/api/preview/link`, r => r.fulfill({ json: { url: r.request().postDataJSON().url } }));
  const scraps = [];
  context.on('request', q => q.url().includes('/groups/scrap') && scraps.push(q.url()));
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#loading.gone');
  await page.waitForSelector('review-mode .fab', { state: 'attached' });
  const tell = (name, detail) =>
    page.evaluate(([name, detail]) => document.dispatchEvent(new CustomEvent(name, { detail })), [name, detail]);
  // (each note HQ's call would send to the line)
  await page.evaluate(() => {
    window.__heard = [];
    document.addEventListener('pencil:note', e => e.detail.call && window.__heard.push(e.detail));
  });
  await tell('call:on', CALL);
  await page.evaluate(url => import('/shell/desk.js').then(m => m.openLink(url)), `${ARTIFACT}/basket`);
  await page.waitForFunction(() => document.querySelector('#viewer iframe')?.src.includes('/basket'));
  const frame = await (await page.$('#viewer iframe')).contentFrame();
  await frame.waitForSelector('review-mode .fab', { state: 'attached' });
  await page.waitForTimeout(1500); // (its hello answered: desk.js ASK_MS)
  // (Chromium's own Pencil, its points in the artifact's px: the veil it draws on holds the pen as a real one does)
  const box = await page.locator('#viewer iframe').boundingBox(),
    cdp = chromiumPen(await context.newCDPSession(page));
  return {
    page,
    frame,
    scraps,
    errors,
    tell,
    draw: points => cdp.stroke(points.map(([x, y]) => [box.x + x, box.y + y])),
    sheetShown: () =>
      frame.evaluate(() => !document.querySelector('review-mode').shadowRoot.querySelector('.sheet').hidden),
    callNotes: () =>
      c.posts.filter(p => p.path === '/api/book/note' && p.body.anchor?.url.startsWith(ARTIFACT)).map(p => p.body),
  };
}
// A mark on the artifact, said as it's drawn: the call's page has it, with the words; the notebook nothing
async function heldForAgent(c, { page, frame, scraps, tell, draw, sheetShown, callNotes }) {
  const from = c.posts.length;
  await draw(loop(220, 140, 140, 60));
  await tell('call:heard', { text: 'this heading is too loud' });
  await page.waitForTimeout(300);
  assert.equal(await sheetShown(), false, 'on a call no post-it opens');
  await until(() => callNotes().length === 1, "the artifact's mark on the call's page");
  const [sent] = callNotes();
  assert.equal(sent.words, 'this heading is too loud', 'with what the call heard while it was drawn');
  assert.equal(sent.said, 'spoken');
  assert.ok(sent.snip?.startsWith('data:image/'), 'and its snip of the artifact');
  const made = c.posts.slice(from).find(p => p.path === '/api/book/page/new')?.body;
  assert.equal(made?.call, CALL.call, "...on this call's page");
  assert.deepEqual(scraps, [], 'nothing went into the notebook by itself');
  const held = await inked(frame, FIRST);
  assert.ok(held.n > 200, 'its ink stays drawn for the agent');
  assert.ok(held.red > 200, '...in red');
  await c.shot('frame-call-held', page);
}
// A second mark; the agent's turn on the first ends: the first goes, the second stays. Hung up, what's left goes
async function hadAndHungUp(c, { page, frame, scraps, tell, draw, callNotes }) {
  await draw(loop(220, 400, 140, 60));
  await until(() => callNotes().length === 2, 'the second mark in');
  const [one, two] = await page.evaluate(() => window.__heard.map(n => n.id));
  assert.ok(two, 'both heard as call notes');
  await tell('call:had', { note: one });
  await page.waitForTimeout(300);
  assert.equal((await inked(frame, FIRST)).n, 0, "the first scribble went with the agent's turn");
  assert.ok((await inked(frame, SECOND)).n > 200, 'the second, not had yet, stays');
  await c.shot('frame-call-one-had', page);
  await page.evaluate(
    () => new Promise(done => document.dispatchEvent(new CustomEvent('call:off', { detail: { done } }))),
  );
  await page.waitForTimeout(300);
  assert.equal((await inked(frame, SECOND)).n, 0, 'nothing left drawn after the call');
  assert.deepEqual(scraps, []);
}
// Off a call: the artifact's pin flow, its post-it open for Save, nothing on a call's page
async function offCall(c, { page, draw, sheetShown, callNotes }) {
  await draw(loop(220, 140, 140, 60));
  await until(sheetShown, 'the post-it open off a call');
  await page.waitForTimeout(2000); // (past a call's settle)
  assert.equal(callNotes().length, 2, 'off a call the mark waits for its Save');
  await c.shot('frame-off-call', page);
}
