#!/usr/bin/env node
// The Pencil on a call, on HQ held like an iPad mini (744 × 1133): a mark that settles goes to the book's call page
// for the call's agent (its note, heard as 'pencil:note'), never to the notebook as a scrap, and its ink doesn't lift
// away: it stays drawn on the screen until the line says the agent's turn on it is done ('call:had'), then it goes, so
// the board circles afresh. A second mark stays while the first goes. Hung up, any left goes too (the board, call 161).
//   node shared/review/callink-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { playwright, errorsOf, until } from '../browser/browser.mjs';
import { serve, ROOT } from '../../platform/hq/serve.mjs';
import { fulfilPart } from './parts.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const shot = async name => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const reviewJs = (await readFile(`${ROOT}/shared/review/review.js`, 'utf8')).replace('{{HQ_ORIGIN}}', base);
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
  if (path === '/__review/mine') return r.fulfill({ json: { notes: 0 } });
  return r.fulfill({ json: { show: false } });
});
await context.route(`${base}/api/book`, r =>
  r.fulfill({ json: { day: 'today', today: 'today', days: [], pages: [{ id: PAGE, kind: 'call', call: CALL }] } }),
);
await context.route(`${base}/api/book/note`, r => {
  notes.push(r.request().postDataJSON());
  return r.fulfill({ json: { note: { id: 40 + notes.length, n: notes.length, page: PAGE }, sheet: { id: 1 } } });
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
    new CustomEvent('call:on', { detail: { call: 5, agent: 'juno', name: 'Juno', color: '#7b5ea7', walk: false } }),
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
assert.deepEqual(errors, []);
console.log(
  "callink-check: a call's scribble stays for its agent, nothing goes into the notebook, and it goes after the agent's turn",
);
await browser.close();
server.close();
