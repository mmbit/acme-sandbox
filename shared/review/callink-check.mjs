#!/usr/bin/env node
// The Pencil on a call, on HQ held like an iPad mini (744 × 1133): a mark that settles goes to the book's call page
// for the call's agent (its note, heard as 'pencil:note'), never to the notebook as a scrap, and its ink doesn't lift
// away: it stays drawn on the screen until the line says the agent's turn on it is done ('call:had'), then it goes, so
// the board circles afresh. A second mark stays while the first goes. Hung up, any left goes too.
// A sad face drawn mouth first, its eyes dotted in after, and a word written by a line, all stay: nothing reads a line as
// a wipe. The strip shows while the ink does, red only, with its eraser and undo: the eraser takes a line the agent
// has, undo brings it back, and undo again takes the note back with its ink. A line followed by a pen's touch that
// draws nothing still goes to the agent and from the screen after its turn.
//   node shared/review/callink-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { playwright, errorsOf, until } from '../browser/browser.mjs';
import { serve } from '../../platform/hq/serve.mjs';
import { scriptForHq, fulfilPart } from './parts.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const shot = async name => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const reviewJs = scriptForHq('review/review.js', base);
const CALL = 5,
  PAGE = 7;

// ---- the book's store, played: the call's page, the notes the Pencil posts there, and any scrap (there should be none)
const notes = [],
  scraps = [];
const browser = await playwright().chromium.launch();
const context = await browser.newContext({
  viewport: { width: 744, height: 1133 },
  deviceScaleFactor: 2,
  hasTouch: true,
});
await context.addInitScript(() => {
  const a = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) {
    return a.call(this, { ...o, mode: 'open' });
  };
});
await context.route(`${base}/__review/**`, r => {
  const path = new URL(r.request().url()).pathname;
  if (fulfilPart(r, path, reviewJs)) return;
  return r.fulfill({ json: { show: false } });
});
await context.route(`${base}/api/book`, r =>
  r.fulfill({ json: { day: 'today', today: 'today', days: [], pages: [{ id: PAGE, kind: 'call', call: CALL }] } }),
);
await context.route(`${base}/api/book/note`, r => {
  notes.push(r.request().postDataJSON());
  return r.fulfill({ json: { note: { id: 40 + notes.length, n: notes.length, page: PAGE }, sheet: { id: 1 } } });
});
const wiped = [];
await context.route(`${base}/api/book/note/delete`, r => {
  wiped.push(r.request().postDataJSON().id);
  return r.fulfill({ json: {} });
});
await context.route(`${base}/api/notebooks/groups/scrap`, r => {
  scraps.push(r.request().postDataJSON());
  return r.fulfill({ json: { id: 99, page: 1 } });
});
const page = await context.newPage();
const errors = errorsOf(page);
const cdp = await context.newCDPSession(page);
await page.goto(`${base}/?intro=0&renderer=wire`);
await until(page, '#loading.gone');
await page.waitForFunction(
  () => document.querySelector('review-mode')?.shadowRoot.querySelectorAll('.strip .pot').length === 5,
  null,
  { timeout: 20_000 },
);
// (each note HQ's call would send to the line, and every ink that lifted off the page)
await page.evaluate(() => {
  window.__heard = [];
  document.addEventListener('pencil:note', e => window.__heard.push(e.detail));
  window.__lifted = 0;
  new MutationObserver(ms =>
    ms.forEach(m => m.addedNodes.forEach(n => n.localName === 'review-lift' && window.__lifted++)),
  ).observe(document.documentElement, { childList: true, subtree: true });
  document.dispatchEvent(
    new CustomEvent('call:on', { detail: { call: 5, agent: 'juno', name: 'Juno', color: '#7b5ea7' } }),
  );
});

const loop = (cx, cy, rx, ry, n = 40) =>
  Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos((i / n) * 6.1), cy + ry * Math.sin((i / n) * 6.1)]);
async function pen(points) {
  const at = ([x, y], type, buttons, force) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons,
      clickCount: 1,
      pointerType: 'pen',
      force,
    });
  await at(points[0], 'mousePressed', 1, 0.4);
  for (const p of points.slice(1)) await at(p, 'mouseMoved', 1, 0.5);
  await at(points.at(-1), 'mouseReleased', 0, 0);
}
// How much of the screen's ink layer is drawn in a box (CSS px): its opaque pixels
const inked = box =>
  page.evaluate(({ x, y, w, h }) => {
    const c = document.querySelector('review-mode').shadowRoot.querySelector('canvas.ink'),
      k = c.width / innerWidth,
      d = c.getContext('2d').getImageData(x * k, y * k, w * k, h * k).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
    return n;
  }, box);
const FIRST = { x: 120, y: 220, w: 280, h: 160 },
  SECOND = { x: 120, y: 620, w: 280, h: 160 };

// ---- a mark settles: its note goes to the call's page for the agent, nothing to the notebook, and its ink stays
await pen(loop(260, 300, 120, 60));
await page.waitForFunction(() => window.__heard.length === 1, null, { timeout: 20_000 });
await page.waitForTimeout(800); // (past where a lift would have flown)
assert.equal(notes.length, 1, "the mark went to the call's page");
assert.deepEqual(scraps, [], 'nothing went into the notebook by itself');
assert.equal(await page.evaluate(() => window.__lifted), 0, 'its ink never lifted off into the book');
assert.equal(await page.evaluate(() => window.__heard[0].call), CALL, "heard as the call's, for its agent");
assert.ok((await inked(FIRST)) > 200, 'the scribble stays drawn for the agent');
await shot('held');

// ---- a second mark while the agent's turn on the first goes on; the turn ends: the first goes, the second stays
await pen(loop(260, 700, 120, 60));
await page.waitForFunction(() => window.__heard.length === 2, null, { timeout: 20_000 });
await page.evaluate(id => document.dispatchEvent(new CustomEvent('call:had', { detail: { note: id } })), 41);
await page.waitForTimeout(100);
assert.equal(await inked(FIRST), 0, "the first scribble went with the agent's turn");
assert.ok((await inked(SECOND)) > 200, 'the second, not had yet, stays');
await shot('one-had');

// ---- hung up: what's left goes too
await page.evaluate(
  () => new Promise(done => document.dispatchEvent(new CustomEvent('call:off', { detail: { done } }))),
);
await page.waitForTimeout(100);
assert.equal(await inked(SECOND), 0, 'nothing left drawn after the call');
assert.deepEqual(scraps, []);

// ---- the next call: a sad face, its mouth first, then its eyes dotted in, goes to the agent whole and stays drawn
await page.evaluate(() =>
  document.dispatchEvent(
    new CustomEvent('call:on', { detail: { call: 5, agent: 'juno', name: 'Juno', color: '#7b5ea7' } }),
  ),
);
const frown = Array.from({ length: 31 }, (_, i) => [230 + (280 * i) / 30, 520 - Math.sin((Math.PI * i) / 30) * 84]),
  dot = (x, y) => Array.from({ length: 24 }, (_, i) => [x + (i % 2 ? 9 : -9) + Math.sin(i) * 2, y - 9 + (18 * i) / 23]),
  MOUTH = { x: 220, y: 492, w: 300, h: 40 },
  EYES = [
    { x: 290, y: 450, w: 40, h: 40 },
    { x: 410, y: 450, w: 40, h: 40 },
  ];
for (const line of [frown, dot(310, 470), dot(430, 470)]) await pen(line);
await page.waitForFunction(() => window.__heard.length === 3, null, { timeout: 20_000 });
assert.equal(notes.at(-1).anchor.ink.length, 3, 'the face went to the agent as one note, its three lines');
assert.ok((await inked(MOUTH)) > 200, 'its mouth stays drawn');
for (const eye of EYES) assert.ok((await inked(eye)) > 100, 'and each eye');
await shot('sad-face');

// ---- a line, and a word written on the line by one stroke of the pen: both stay, and go as one note
const WORD = { x: 120, y: 840, w: 330, h: 70 };
await pen([
  [120, 900],
  [450, 900],
]);
await pen(Array.from({ length: 90 }, (_, i) => [130 + i * 3.4, 890 - Math.abs(Math.sin(i / 3)) * 44]));
await page.waitForFunction(() => window.__heard.length === 4, null, { timeout: 20_000 });
assert.equal(notes.at(-1).anchor.ink.length, 2, 'the word went with its line');
assert.ok((await inked(WORD)) > 400, 'the word stays drawn');

// ---- the strip while the ink is on the page: red only, the eraser and undo
const ui = s => page.locator('review-mode').locator(s);
assert.ok(await ui('.bar .strip').isVisible(), 'the strip shows with the ink');
assert.equal(await ui('.strip .pot:visible').count(), 1, 'one ink on a call: red');
await ui('.strip .eraser').click();
await pen(Array.from({ length: 12 }, (_, i) => [350 + i * 3.6, 425 + i * 2.4]));
await page.waitForTimeout(200);
assert.ok((await inked(MOUTH)) < 50, 'the eraser took the mouth, which the agent has');
for (const eye of EYES) assert.ok((await inked(eye)) > 100, 'and left the eyes');
assert.equal(notes.length, 4, 'an eraser makes no note');
await shot('erased');
await ui('.strip .undo').click();
await page.waitForTimeout(200);
assert.ok((await inked(MOUTH)) > 200, 'undo brings the mouth back');
await ui('.strip .undo').click();
await page.waitForFunction(() => window.__heard.length === 4);
await page.waitForTimeout(200);
assert.deepEqual(wiped, [44], 'undo again takes the last note back');
assert.ok((await inked(WORD)) < 50, 'with its ink');
assert.ok((await inked(MOUTH)) > 200, 'the face stays');

// ---- a line, then the pen down again drawing nothing (a tap, a try that didn't take): the line still goes to the
// agent, and goes from the screen after its turn
const LINE = { x: 190, y: 680, w: 320, h: 40 };
await ui('.strip .pot:visible').click(); // (the eraser put down)
await pen([
  [200, 700],
  [500, 700],
]);
await pen([
  [560, 760],
  [560, 760],
]);
await page.waitForFunction(() => window.__heard.length === 5, null, { timeout: 8000 });
assert.equal(notes.at(-1).anchor.ink.length, 1, 'the line went to the agent');
await page.evaluate(id => document.dispatchEvent(new CustomEvent('call:had', { detail: { note: id } })), 45);
await page.waitForTimeout(100);
assert.equal(await inked(LINE), 0, "the line went with the agent's turn");
await page.evaluate(
  () => new Promise(done => document.dispatchEvent(new CustomEvent('call:off', { detail: { done } }))),
);
await page.waitForTimeout(100);
assert.ok(!(await ui('.bar .strip').isVisible()), 'no ink, no strip');
assert.deepEqual(scraps, []);
assert.deepEqual(errors, []);
console.log(
  "callink-check: a call's scribble stays for its agent, nothing goes into the notebook, and it goes after the agent's " +
    'turn; a face and a word stay whole; the strip erases and undoes; a tap after a line keeps nothing open',
);
await browser.close();
server.close();
