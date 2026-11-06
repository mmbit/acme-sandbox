#!/usr/bin/env node
// A call's prototypes on both iPads, on the real coordinator (the coordinator's callprototypes.ts): the call's agent
// saves one, its card slides in on the board's iPad (HQ) and its guest's (the guest room), each opens it full screen and
// taps through it, each one's pen on it points: a note of the call's for its agent by their name, never a scrap on the
// call's page, the guest's screen reaching the agent with her circle on it, her Pauze (on the call's page, or on the
// open prototype's bar) holding it back until she shows it again, the board's iPad reaching the agent as the board's
// screen 2 with its own bubble's eye and Pause, and v2 sits beside v1 in the call's page's clip. Screenshots of each step
// on an iPad in landscape and in portrait, and a desktop.
//   node platform/hq/prototypes-check.mjs [--shots dir]
// The coordinator takes its pictures in its own Chromium: CHROMIUM_PATH names one where `chromium` isn't on PATH.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
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
// The pointer note a pen on a call's prototype made from another screen ('callnote', callprototypes.ts markOnCall),
// once it's in, with what the agent hears of it
async function pointed(fed, from) {
  for (let i = 0; i < 40 && !fed.slice(from).some(e => e.text === 'callnote'); i++)
    await new Promise(r => setTimeout(r, 250));
  return fed.slice(from).find(e => e.text === 'callnote')?.note;
}
// Nothing of anyone's but the agent's on the call's page: a pen on a prototype leaves no scrap there
const noScraps = async (page, agent) =>
  assert.deepEqual(
    (said(await h.board(`/api/notebooks/pages/groups?page=${page}`)).groups ?? []).filter(g => g.by !== agent),
    [],
    "a pen on the prototype left a scrap on the call's page",
  );

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
  const joined = await h.send(
    new URL(link).pathname,
    { origin },
    new URLSearchParams({ name: 'Ilse', screen: 'show' }),
  );
  assert.equal(joined.status, 303, joined.text);
  const g = joined.headers['set-cookie'][0].split(';')[0];
  const fed = [];
  // (HQ's feed: the coordinator's own book events, played into the board's pages as its feed hands them on)
  onPublish(e => e.type === 'book' && fed.push(e));
  const feed = (page, from = 0) =>
    page.evaluate(evs => import('/shell/events.js').then(m => evs.forEach(ev => m.onEvent(ev))), fed.slice(from));
  // (what the agent has of every screen on the call, all of it, and whether the guest's is among it)
  const screenNow = async () =>
    said(await h.voice('screen-turn', { purpose: 'call', ref: String(call), after: 0, seen: 0, briefed: true }));
  const ilse = turn => turn.lines?.some(l => /^Ilse's screen/.test(l));
  const until = async (ok, tries = 40) => {
    for (let i = 0; i < tries; i++)
      if (await ok()) return true;
      else await new Promise(r => setTimeout(r, 500));
    return false;
  };

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
  // Her pen on it points: a note of the call's by her name, which the agent hears with its snip, nothing on the page
  const before = fed.length;
  await penLoop(guest, '.bk-guest-proto iframe', 200, 300);
  const hers = await pointed(fed, before);
  assert.ok(hers, "the guest's pen on the prototype reached nobody");
  const heard = said(await h.voice(`note?id=${hers.id}&call=${call}`));
  assert.equal(heard.by, 'Ilse');
  assert.ok(heard.picture?.data, 'her note has no snip');
  await noScraps(callPage.id, 'juno');
  // ...and her screen reaches the agent too, under her name, her circle on it (the room's watch-along)
  let seen;
  for (let i = 0; i < 40; i++) {
    const turn = said(
      await h.voice('screen-turn', {
        purpose: 'call',
        ref: String(call),
        after: 0,
        seen: 0,
        briefed: true,
        picture: true,
      }),
    );
    if (
      turn.on &&
      turn.lines.some(l => /^Ilse's screen/.test(l)) &&
      turn.lines.some(l => / (circled|drew) /.test(l)) &&
      turn.pictures?.length
    ) {
      seen = turn;
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  assert.ok(seen, "the guest's screen didn't reach the agent with her circle on it");
  if (shots)
    writeFileSync(`${shots}/2-guest-screen-as-the-agent-sees-it.jpg`, Buffer.from(seen.pictures[0].data, 'base64'));
  await shot('2-guest-ipad-marked', guest);
  // While it's open, the eye and Pauze are on its bar: Pauze there holds her screen back, Weer laten zien there shows
  // it again
  const protoPause = guest.locator('.bk-guest-proto .bk-guest-pause');
  await protoPause.locator('span', { hasText: 'Pauze' }).waitFor();
  assert.ok(await guest.locator('.bk-guest-proto .bk-guest-eye').isVisible(), 'no eye on the open prototype');
  await protoPause.click();
  await protoPause.locator('span', { hasText: 'Weer laten zien' }).waitFor();
  assert.ok(
    await until(async () => !ilse(await screenNow())),
    'the agent still sees her screen paused from the prototype',
  );
  await shot('2-guest-ipad-paused-on-prototype', guest);
  await protoPause.click();
  await protoPause.locator('span', { hasText: 'Pauze' }).waitFor();
  assert.ok(await until(async () => ilse(await screenNow())), "her screen didn't come back from the prototype's bar");
  await guest.locator('.bk-guest-back').click();
  assert.equal(await guest.locator('.bk-guest-proto').count(), 0);

  // While it's shown, her room's bar has the eye and Pauze, as the board's minimised call; Pauze stops it, the agent
  // sees nothing more of hers, a reload keeps it paused, and Weer laten zien shows it again
  const pause = guest.locator('#book .bk-guest-pause');
  await pause.locator('span', { hasText: 'Pauze' }).waitFor();
  assert.ok(await guest.locator('#book .bk-guest-eye').isVisible(), 'no eye while her screen is shown');
  assert.equal(await guest.locator('#book .bk-guest-eye').getAttribute('aria-label'), 'Juno ziet je scherm');
  await shot('3-guest-ipad-shown', guest);
  await pause.click();
  await pause.locator('span', { hasText: 'Weer laten zien' }).waitFor();
  assert.ok(await guest.locator('#book .bk-guest-eye').isHidden(), 'the eye stays while paused');
  assert.ok(await until(async () => !ilse(await screenNow())), 'the agent still sees her screen while it is paused');
  await shot('3-guest-ipad-paused', guest);
  await guest.reload();
  await pause.locator('span', { hasText: 'Weer laten zien' }).waitFor({ timeout: 30_000 });
  assert.ok(!ilse(await screenNow()), 'a reload showed her paused screen again');
  await pause.click();
  await pause.locator('span', { hasText: 'Pauze' }).waitFor();
  await guest.locator('#book .bk-guest-eye').waitFor();
  assert.ok(
    await until(async () => ilse(await screenNow())),
    "her screen didn't reach the agent again after Weer laten zien",
  );

  // The board taps its card: HQ's viewer, live; its pen there points too, the board's, nothing on the page
  await board.locator('.bk-proto-card').click();
  const boardFrame = board.frameLocator('#viewer iframe');
  await boardFrame.locator('button', { hasText: 'Flip me' }).click({ timeout: 20_000 });
  await boardFrame.locator('button', { hasText: 'Flipped!' }).waitFor();
  await whole(board);
  await shot('2-board-ipad-open', board);
  const boardBefore = fed.length;
  await penLoop(board, '#viewer iframe', 200, 200);
  const its = await pointed(fed, boardBefore);
  assert.ok(its, "the board's pen on the prototype reached nobody");
  assert.equal(said(await h.voice(`note?id=${its.id}&call=${call}`)).by, undefined);
  await noScraps(callPage.id, 'juno');
  await shot('3-board-ipad-marked', board);

  // The board's iPad, not the call's screen, reaches the agent too, as the board's screen 2 (boardscreen.js): what it
  // has open, under its own bubble's eye and Pause; Pause holds it back through a reload, and Show again shows it again
  const screen2 = () => h.voice('screen', { purpose: 'call', ref: String(call), who: 'screen 2' });
  assert.ok(
    await until(async () => (await screenNow()).lines?.some(l => /^The board's screen 2/.test(l))),
    "the board's iPad didn't reach the agent",
  );
  const its2 = said(await screen2());
  if (shots) writeFileSync(`${shots}/3-board-ipad-as-the-agent-sees-it.jpg`, Buffer.from(its2.picture.data, 'base64'));
  const bubble = board.locator('.callbubble');
  assert.ok(await bubble.locator('.cb-eye').isVisible(), "no eye on the board's iPad while the agent sees it");
  assert.equal(await bubble.locator('.cb-hangup').count(), 0, 'the call is hung up on its own screen');
  await bubble.locator('.cb-pause').click();
  await board.locator('.callbubble .cb-pause[aria-pressed="true"]').waitFor();
  assert.ok(await until(async () => (await screen2()).status === 409), "the agent still sees the board's paused iPad");
  await shot('3-board-ipad-paused', board);
  await openHq(board);
  await board.locator('.callbubble .cb-pause[aria-pressed="true"]').waitFor({ timeout: 30_000 });
  // (paused from its start: its first batch says so)
  assert.ok(await until(async () => (await screen2()).status === 409), "a reload showed the board's paused iPad again");
  await board.locator('.callbubble .cb-pause').click();
  await board.locator('.callbubble .cb-eye').waitFor();
  assert.ok(
    await until(async () => (await screen2()).status === 200),
    "the board's iPad didn't come back on Show again",
  );

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
  console.log(
    `PASS call prototypes: v1 ${v1.link}, cards, both opened and tapped through, each pen a pointer heard, her screen and the board's iPad seen, paused and shown again`,
  );
} finally {
  for (const o of opened) await o.context.close();
  await browser.close();
  h.server.closeAllConnections();
  h.server.close();
}
process.exit(0);
