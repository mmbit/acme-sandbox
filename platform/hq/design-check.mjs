#!/usr/bin/env node
// A design session's page on two iPads, on the real coordinator: the call's page, a grid of scraps like every page,
// opened by an iPad that scanned the call's QR code with a name (callguests.ts) and by the board's HQ, each one's
// stroke kept, hers reaches the agent by her name, her cookie opens nothing of HQ, and the agent's drawing lands in
// the board's sight at once. Screenshots with --shots.
//   node platform/hq/design-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { launched, playwright } from '../../shared/browser/browser.mjs';
import { coordinator } from './book/guestserver.mjs';
import { fulfilResponse } from './book/originroute.mjs';
import { hands } from './book/hands.mjs';
import { closeScrap, openScrap } from './book/kit.mjs';

const sharp = createRequire(new URL('../coordinator/', import.meta.url))('sharp');
const arg = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const shots = arg('--shots');
if (shots) mkdirSync(shots, { recursive: true });
const LANDSCAPE = { width: 1180, height: 820 },
  PORTRAIT = { width: 820, height: 1180 };

// (the agent's drawing drawn in Chromium by the coordinator, callpage.ts drawing)
process.env.CHROMIUM_PATH ??= process.env.BROWSER_HEADLESS_SHELL ?? playwright().chromium.executablePath();
const state = await coordinator();
const { h, origin } = state;
const browser = await launched();
assert.ok(browser, 'no Chromium for Playwright');
const opened = [];
const said = r => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const shot = async (name, page) => shots && (await page.screenshot({ path: `${shots}/${name}.png` }));

// A pen loop on the page, as an Apple Pencil draws it: a tap in the grid's gap at x, y in the frame opens a scrap (the
// grid takes no ink), the loop goes on its sheet and the scrap is put back
async function penLoop(page, frame, x, y) {
  const box = await page.locator(frame).boundingBox();
  const { pen } = await hands(page);
  const { sheet } = await openScrap(page, pen, undefined, [box.x + x, box.y + y]);
  const [cx, cy, rx, ry] = [sheet.x + sheet.width / 2, sheet.y + sheet.height * 0.6, sheet.width / 4, sheet.height / 8];
  await pen.stroke(Array.from({ length: 25 }, (_, i) => [cx + rx * Math.cos(i / 4), cy + ry * Math.sin(i / 4)]));
  await closeScrap(page, pen);
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

// The notebook's events on the coordinator's feed (server-sent), each played to on, the old ones it repeats left out
async function relay(reader, on) {
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const r = await reader.read().catch(() => ({ done: true }));
    if (r.done) return;
    buf += dec.decode(r.value);
    for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
      const line = buf.slice(0, i);
      if (!line.startsWith('data: ')) continue;
      const ev = JSON.parse(line.slice(6));
      if (!ev.history && ev.type === 'book') on(ev).catch(() => {});
    }
  }
}
// HQ on a device, once its screens are wired: it asks for its feed (/api/events) after them, so an event played in
// before would find no card listening
async function openHq(page) {
  const listening = page.waitForRequest(r => new URL(r.url()).pathname === '/api/events', { timeout: 60_000 });
  await page.goto(`${origin}/`);
  await listening;
}

try {
  // A design session: the call's page, as the call starts (HQ's calldraw.js)
  const { call } = await h.liveCall('juno');
  const callPage = said(await h.board('/api/notebooks/call', { call })).page;
  // An iPad scans the call's QR code and gives a name once
  const { link } = said(await h.board('/api/calls/guest', { call, lang: 'nl' }));
  assert.match(new URL(link).pathname, /^\/guest\/scan\/nl\/[A-Za-z0-9_-]{43}$/);
  const joined = await h.send(new URL(link).pathname, { origin }, new URLSearchParams({ name: 'Esmee' }));
  assert.equal(joined.status, 303, joined.text);
  const g = joined.headers['set-cookie'][0].split(';')[0];
  // Its cookie opens only this call's page, never HQ
  const hq = await h.send('/api/notebooks/pages?notebook=' + callPage.notebook, { cookie: g });
  assert.ok([401, 403].includes(hq.status), `the scan's cookie reached HQ's api: ${hq.status}`);

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
  await shot('1-guest-ipad-sketch', guest);
  await board.waitForTimeout(1500);
  await shot('1-board-ipad-sketch', board);

  // Each draws on the page
  await penLoop(guest, '#book', 520, 700);
  await penLoop(board, 'body', 880, 450); // (the open book's paper: the right half on an iPad on its side)
  const drawnBy = async by => {
    for (let i = 0; i < 60; i++) {
      const gr = (said(await h.board(`/api/notebooks/pages/groups?page=${callPage.id}`)).groups ?? []).find(
        x => by(x.by) && x.ink.length,
      );
      if (gr) return gr;
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  };
  const hers = await drawnBy(by => /^guest:\d+$/.test(by));
  assert.ok(hers, "the iPad's stroke on the design page wasn't kept");
  await shot('2-board-ipad-drawn', board);
  const boards = await drawnBy(by => by === 'board');
  assert.ok(boards, "the board's stroke on the design page wasn't kept");
  assert.equal(said(await h.voice(`drawn?id=${hers.id}&call=${call}`)).who, 'Esmee');
  await guest.waitForTimeout(800);
  await shot('2-guest-ipad-drawn', guest);
  await shot('2-board-ipad-drawn', board);

  // The agent draws a picture while the board looks at the page: it lands in what the board sees at once.
  // (the board's book opened as wide as the screen lets it.)
  await board.evaluate(
    w => localStorage.setItem('hq.book.landscape', JSON.stringify({ mode: 'open', book: w })),
    LANDSCAPE.width,
  );
  await openHq(board);
  await board.evaluate(at => import('/shell/ink/book.js').then(m => m.openAt(at)), {
    page: callPage.id,
    notebook: callPage.notebook,
  });
  await board.waitForTimeout(3000); // (the board's hands off the page a moment, as on a call)
  // (the coordinator's feed played into the board's HQ as events.js gets it: the devices' own feed is shut, above)
  const feed = await fetch(h.base + '/api/events', { headers: { cookie: h.boardCookie } });
  relay(feed.body.getReader(), ev => board.evaluate(e => import('/shell/events.js').then(m => m.onEvent(e)), ev));
  const pixels = async () =>
    (
      await sharp(await board.screenshot())
        .raw()
        .toBuffer({ resolveWithObject: true })
    ).data;
  const before = await pixels();
  const svg = '<svg viewBox="0 0 640 480"><rect width="640" height="480" fill="#e0109c"/></svg>';
  const card = said(await h.voice('drawing', { call, svg })).id;
  const asked = Date.now();
  // (the screen changed over a card's worth of it)
  const changed = async () => {
    const now = await pixels();
    let n = 0;
    for (let y = 0; y < LANDSCAPE.height; y += 4)
      for (let x = 0; x < LANDSCAPE.width; x += 4) {
        const i = (y * LANDSCAPE.width + x) * 4;
        if (
          Math.abs(now[i] - before[i]) + Math.abs(now[i + 1] - before[i + 1]) + Math.abs(now[i + 2] - before[i + 2]) >
          30
        )
          n++;
      }
    return n > (100 * 100) / 16;
  };
  let shown = false;
  while (!shown && Date.now() - asked < 2000) shown = await changed();
  assert.ok(shown, "the agent's card wasn't on the board's screen within 2 s");
  await board.waitForTimeout(2500);
  await shot('3-board-ipad-card', board);
  for (const o of opened) assert.deepEqual(o.errors, []);
  console.log(
    `PASS design session: the call's page on both iPads, each one's stroke kept (#${hers.id}, #${boards.id}), hers heard as Esmee's; the agent's card #${card} in sight at once`,
  );
} finally {
  for (const o of opened) {
    await o.context.unrouteAll({ behavior: 'ignoreErrors' });
    await o.context.close();
  }
  await browser.close();
  h.server.closeAllConnections();
  h.server.close();
}
process.exit(0);
