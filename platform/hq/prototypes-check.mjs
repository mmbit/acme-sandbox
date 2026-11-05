#!/usr/bin/env node
// A call's prototypes on both iPads, on the real coordinator (the coordinator's callprototypes.ts): the call's agent
// saves one, its card slides in on the board's iPad (HQ) and its guest's (the guest room), each opens it full screen and
// taps through it, each one's pen on it lands on the call's page as their mark, and v2 sits beside v1 in the
// call's page's clip. Screenshots of each step on an iPad in landscape and in portrait, and a desktop.
//   node platform/hq/prototypes-check.mjs [--shots dir]
// The coordinator takes its pictures in its own Chromium: CHROMIUM_PATH names one where `chromium` isn't on PATH.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launched } from '../../shared/browser/browser.mjs';
import { coordinator } from './book/guestserver.mjs';
import { fulfilResponse } from './book/originroute.mjs';

const arg = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const shots = arg('--shots');
if (shots) mkdirSync(shots, { recursive: true });
const LANDSCAPE = { width: 1180, height: 820 },
  PORTRAIT = { width: 820, height: 1180 },
  DESKTOP = { width: 1440, height: 900 };
const PAGE = (word, colour) => `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<title>Flip card</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#f6efe4;
font:600 28px system-ui}button{font:inherit;padding:28px 48px;border-radius:24px;border:0;background:${colour};color:#fff}
</style></head><body><button onclick="this.textContent='Flipped!'">${word}</button></body></html>`;

const state = await coordinator();
const { h, origin } = state;
const { onPublish } = await import('../coordinator/src/events.ts');
const browser = await launched();
assert.ok(browser, 'no Chromium for Playwright');
const opened = [];
const said = r => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const shot = async (name, page) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));

// A pen stroke (a loop) at x, y in the frame on the page, as an Apple Pencil draws it
async function penLoop(page, frame, x, y) {
  const box = await page.locator(frame).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const pen = (type, px, py) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x: box.x + px,
      y: box.y + py,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      pointerType: 'pen',
      force: 0.5,
    });
  await pen('mousePressed', x, y);
  for (let i = 1; i <= 24; i++) await pen('mouseMoved', x + 160 * Math.cos(i / 4), y + 90 * Math.sin(i / 4));
  await pen('mouseReleased', x + 160, y);
}
// A scrap with its snip on the call's page by who (board, or a guest:<id>), once it's there
async function scrapBy(page, by) {
  const find = async () =>
    (said(await h.board(`/api/notebooks/pages/groups?page=${page}`)).groups ?? []).find(
      gr => by(gr.by) && gr.pictures?.length,
    );
  let scrap;
  for (let i = 0; i < 40 && !(scrap = await find()); i++) await new Promise(r => setTimeout(r, 250));
  return scrap;
}

// A device: HQ's origin and the preview hosts answered by the coordinator, nothing else reached
async function device(viewport, cookie) {
  const context = await browser.newContext({ viewport, hasTouch: true, ignoreHTTPSErrors: true });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && !url.hostname.endsWith('.preview.company.test')) return route.abort('blockedbyclient');
    if (url.pathname === '/api/events') return route.fulfill({ status: 204 });
    const response = await route.fetch({
      url: h.base + url.pathname + url.search,
      headers: { ...route.request().headers(), host: url.host },
      maxRedirects: 0,
    });
    return fulfilResponse(route, response);
  });
  const [name, value] = cookie.split('=');
  await context.addCookies([{ name, value, url: origin }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  opened.push({ context, errors });
  return page;
}

// The prototype open in HQ's viewer whole: the book that lay open at the call's page folded away, nothing over it
// across its width
const whole = page =>
  page.waitForFunction(() => {
    const r = document.querySelector('#viewer iframe').getBoundingClientRect();
    return [0.25, 0.5, 0.75].every(at =>
      document.elementFromPoint(r.x + r.width * at, r.y + r.height / 2)?.matches('#viewer iframe'),
    );
  });
// HQ on a device, once its screens are wired: it asks for its feed (/api/events) after them, so an event played in
// before would find no card listening
async function openHq(page) {
  const listening = page.waitForRequest(r => new URL(r.url()).pathname === '/api/events', { timeout: 60_000 });
  await page.goto(`${origin}/`);
  await listening;
}

try {
  const { call } = await h.liveCall('juno');
  const callPage = said(await h.board('/api/notebooks/call', { call })).page;
  // (the guest's iPad scans the call's QR code and gives a name)
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'nl' }));
  const joined = await h.send(new URL(link).pathname, { origin }, new URLSearchParams({ name: 'Ilse' }));
  assert.equal(joined.status, 303, joined.text);
  const g = joined.headers['set-cookie'][0].split(';')[0];
  const fed = [];
  // (HQ's feed: the coordinator's own book events, played into the board's pages as its feed hands them on)
  onPublish(e => e.type === 'book' && fed.push(e));
  const feed = (page, from = 0) =>
    page.evaluate(evs => import('/shell/events.js').then(m => evs.forEach(ev => m.onEvent(ev))), fed.slice(from));

  // The board's iPad (HQ, landscape, the book open at the call's page) and its guest's (portrait, the call's page)
  const board = await device(LANDSCAPE, h.boardCookie);
  await openHq(board);
  await board.evaluate(at => import('/shell/ink/book.js').then(m => m.openAt(at)), {
    page: callPage.id,
    notebook: callPage.notebook,
  });
  const guest = await device(PORTRAIT, g);
  await guest.goto(`${origin}/guest/notebooks/?notebook=${callPage.notebook}`);
  await guest.locator('#book .bk-paper').waitFor({ state: 'attached', timeout: 60_000 });
  await guest.waitForTimeout(1500);

  // The agent saves v1: its card on both
  const v1 = said(await h.voice('prototype', { call, name: 'Flip card', html: PAGE('Flip me', '#d0573a') }));
  await feed(board);
  const boardCard = board.locator('.bk-proto-card');
  await boardCard.waitFor();
  await board.waitForFunction(() => document.querySelector('.bk-proto-card img')?.complete);
  await board.waitForTimeout(600);
  await shot('1-board-ipad-card', board);
  const guestCard = guest.locator('.bk-proto-card');
  await guestCard.waitFor({ timeout: 10_000 });
  await guest.waitForFunction(() => document.querySelector('.bk-proto-card img')?.complete);
  await guest.waitForTimeout(600);
  await shot('1-guest-ipad-card', guest);

  // The guest taps it: full screen, live, tapped through, and back to the call's page
  await guest.locator('.bk-proto-card').click();
  const guestFrame = guest.frameLocator('.bk-guest-proto iframe');
  await guestFrame.locator('button', { hasText: 'Flip me' }).click({ timeout: 20_000 });
  await guestFrame.locator('button', { hasText: 'Flipped!' }).waitFor();
  await shot('2-guest-ipad-open', guest);
  // Her pen on it: a scrap of hers on the call's page with its snip, which the agent hears as hers
  await penLoop(guest, '.bk-guest-proto iframe', 200, 300);
  const hers = await scrapBy(callPage.id, by => /^guest:\d+$/.test(by));
  assert.ok(hers, "the guest's pen on the prototype made no mark on the call's page");
  assert.equal(said(await h.voice(`drawn?id=${hers.id}&call=${call}`)).who, 'Ilse');
  await shot('2-guest-ipad-marked', guest);
  await guest.locator('.bk-guest-back').click();
  assert.equal(await guest.locator('.bk-guest-proto').count(), 0);

  // The board taps its card: HQ's viewer, live; its pen there a mark on the call's page, the board's
  await board.locator('.bk-proto-card').click();
  const boardFrame = board.frameLocator('#viewer iframe');
  await boardFrame.locator('button', { hasText: 'Flip me' }).click({ timeout: 20_000 });
  await boardFrame.locator('button', { hasText: 'Flipped!' }).waitFor();
  await whole(board);
  await shot('2-board-ipad-open', board);
  await penLoop(board, '#viewer iframe', 200, 200);
  const scrap = await scrapBy(callPage.id, by => by === 'board');
  assert.ok(scrap, "the board's pen on the prototype made no mark on the call's page");
  assert.equal(said(await h.voice(`drawn?id=${scrap.id}&call=${call}`)).who, 'Board');
  await shot('3-board-ipad-marked', board);

  // v2 beside v1 in the call's page's clip, on both
  const second = fed.length;
  said(await h.voice('prototype', { call, name: 'Flip card', html: PAGE('Flip me too', '#2f6f8f'), about: 'Blue' }));
  await board.keyboard.press('Escape');
  await feed(board, second);
  await guest.locator('.bk-version-link').nth(1).waitFor({ timeout: 15_000 });
  await guest.locator('.bk-versions').scrollIntoViewIfNeeded();
  await shot('4-guest-ipad-clip', guest);
  // ...and tapping a clip's frame opens it again
  await guest.locator('.bk-version-link').nth(1).click();
  await guest.frameLocator('.bk-guest-proto iframe').locator('button', { hasText: 'Flip me too' }).waitFor();
  await guest.locator('.bk-guest-back').click();
  // (the board's clip too, on its iPad on its side: whole, as from its card.)
  await board.evaluate(at => import('/shell/ink/book.js').then(m => m.openAt(at)), {
    page: callPage.id,
    notebook: callPage.notebook,
  });
  await board.locator('.bk-version-link').nth(1).click();
  await board.frameLocator('#viewer iframe').locator('button', { hasText: 'Flip me too' }).waitFor({ timeout: 20_000 });
  await whole(board);
  await shot('4-board-ipad-clip-open', board);
  await board.keyboard.press('Escape');

  // The board's desktop (the call's own screen): its card and the clip
  const desk = await device(DESKTOP, h.boardCookie);
  await openHq(desk);
  await desk.evaluate(at => import('/shell/ink/book.js').then(m => m.openAt(at)), {
    page: callPage.id,
    notebook: callPage.notebook,
  });
  await desk.locator('.bk-versions').waitFor({ timeout: 30_000 });
  await feed(
    desk,
    fed.findLastIndex(e => e.text === 'prototype'),
  );
  await desk.locator('.bk-proto-card').waitFor();
  await desk.waitForFunction(() => document.querySelector('.bk-proto-card img')?.complete);
  await desk.waitForTimeout(600);
  await shot('5-desktop-card-clip', desk);
  // And the iPads turned: the board's upright, its guest's on its side
  await board.setViewportSize(PORTRAIT);
  await guest.setViewportSize(LANDSCAPE);
  await new Promise(r => setTimeout(r, 1000));
  await shot('6-board-ipad-portrait', board);
  await shot('6-guest-ipad-landscape', guest);

  for (const o of opened) assert.deepEqual(o.errors, []);
  console.log(`PASS call prototypes: v1 ${v1.link}, cards, both opened and tapped through, each one's mark heard`);
} finally {
  for (const o of opened) await o.context.close();
  await browser.close();
  h.server.closeAllConnections();
  h.server.close();
}
process.exit(0);
