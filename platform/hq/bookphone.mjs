// book-check.mjs's phone story (shell/ink/pair.js, pairink.js, shared/review/handover.js; Ink's folder): a phone paired with the desktop by the book's code, as the iPad is in bookpair.mjs. A ring
// round part of HQ's scene, which the desktop lays out its own way, shows nowhere on the desktop's page, live or
// lifted; rested, it goes into the book from the phone with the phone's own picture of it, and the desktop's book turns
// to it. No post-it on either screen, drawing or scrolling. A ring round something both screens show (a card of the
// desk phone's) shows on the desktop's page in place while it's drawn; once it's in the book nothing of it is drawn on
// either screen, nor once its sheet is sent (rule zero: bookink.mjs); a ring still being drawn as the phone ends the
// pairing leaves nothing behind (rested, it goes in from the phone), and none of the phone's rings shows over HQ's own
// view there.
import assert from 'node:assert/strict';
import { until } from '../../shared/browser/browser.mjs';
import { nothingDrawn } from './bookink.mjs';
import {
  DESKTOP,
  PHONE,
  bookIs,
  bookShows,
  noteIn,
  opened,
  pairRelay,
  ringRound,
  sheetShowed,
  watchSheet,
} from './bookpair.mjs';

// (in the page: how many of the canvases' pixels are inked, review mode's own ink in its shadow root)
const REVIEW_INK = 'review-mode .ui > canvas';
const inked = (page, sel) =>
  page.evaluate(sel => {
    let n = 0;
    const [host, inner] = sel.split(/ (.*)/);
    const all = inner
      ? document.querySelector(host).shadowRoot.querySelectorAll(inner)
      : document.querySelectorAll(sel);
    for (const c of all) {
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < px.length; i += 4) n += px[i] > 100;
    }
    return n;
  }, sel);

// A phone paired with the desktop by the book's code, HQ's page on it and its post-it watched; the desktop's feed
// played (feed: the events the coordinator would publish.)
async function phonePaired(c, route) {
  const desk = await c.hqIn(c.desk, DESKTOP, { hasTouch: false, deviceScaleFactor: 1 }),
    phone = await c.hqIn(c.pad, PHONE, { deviceScaleFactor: 3 }),
    feed = [];
  for (const context of [desk, phone]) await context.route(/\/api\/pair(\/[a-z]+)?(\?.*)?$/, route);
  await desk.route(`${c.base}/api/events`, r =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: `retry: 150\n\n${feed
        .splice(0)
        .map(e => `data: ${JSON.stringify(e)}\n\n`)
        .join('')}`,
    }),
  );
  const d = await opened(c, desk, '/?intro=0');
  // (the phone with the book's controls)
  await d.page.getByRole('button', { name: 'Draw from your phone' }).click();
  const code = (await (await d.page.waitForSelector('#book .pair-digits')).textContent()).replace(/\D/g, '');
  const p = await opened(c, phone, `/?intro=0&pair=${code}`);
  await until(d.page, '#book .pair-line', /draws here/, 10_000);
  await bookIs(p.page, 'folded');
  for (const page of [d.page, p.page]) await watchSheet(page);
  return { desk, phone, d, p, feed };
}
// c: book-check's, as for bookpair.mjs's pairStory, with its store's notes. A
// phone paired with the desktop: a ring round part of HQ's scene (a canvas laid out its own way on each) shows on the
// desktop's book only as the phone's own picture, never on the desktop's page; no post-it on either screen
export async function phoneStory(c) {
  const route = pairRelay(),
    { desk, phone, d, p, feed } = await phonePaired(c, route),
    from = c.notes.length;
  const scene = { x: PHONE.width / 2, y: 520, w: 200, h: 90 };
  // (the ring goes round part of HQ's scene, once it's drawn there)
  await p.page.waitForFunction(
    ({ x, y }) => document.elementsFromPoint(x, y).some(e => e.localName === 'canvas'),
    scene,
    { timeout: 15_000, polling: 200 },
  );
  await sceneSnapped(c, d, p, scene);
  // (the phone scrolls HQ's page and draws again: into the book from there too)
  await p.page.mouse.wheel(0, 300);
  const scrolled = c.notes.length;
  await ringRound(c, p.page, { ...scene, y: 300 });
  await noteIn(c, p.page, scrolled);
  for (const page of [d.page, p.page])
    assert.equal(await sheetShowed(page), false, 'no post-it on either screen, drawing or scrolling');
  const card = await whileMade(c, d.page, p.page, feed);
  await endedMidRing(c, d.page, p.page, card);
  c.notes.splice(from); // (the phone's notes stay out of the book's stories after this one)
  // (a scripted pen has no pointer to capture, which WebKit says in its words: book-check's noErrors)
  for (const { errors } of [d, p])
    assert.deepEqual(
      errors.filter(e => !/can not be found here|No active pointer/.test(e)),
      [],
      'no errors on either screen',
    );
  await desk.close();
  await phone.close();
}
// A ring round part of HQ's scene: nowhere on the desktop's page, live or lifted; rested, into the book from the phone
// with its picture, the desktop's book turned to it
async function sceneSnapped(c, d, p, scene) {
  const before = await inked(d.page, REVIEW_INK),
    from = c.notes.length;
  await ringRound(c, p.page, scene, { lift: false });
  await d.page.waitForTimeout(800);
  assert.equal(await inked(d.page, '.pair-ink'), 0, "the ring being drawn shows nowhere on the desktop's page");
  await p.page.evaluate(() => window.__lift());
  await c.shot('pair-phone-ring', p.page);
  const note = await noteIn(c, p.page, from);
  assert.ok(note.snip, "the phone's picture goes in the book");
  await bookShows(d.page, note, "the desktop's book turns to the phone's note");
  await c.shot('pair-phone-snap', d.page);
  assert.equal(await inked(d.page, '.pair-ink'), 0, "the ring isn't drawn on the desktop's page");
  assert.equal(await inked(d.page, REVIEW_INK), before, "nor in review mode's ink there");
}

// ----
// The strongest of review mode's ink in a box and a margin round it (client px), 0-255
const inkIn = (page, b, pad = 40) =>
  page.evaluate(
    ([b, pad]) => {
      const k = devicePixelRatio;
      let most = 0;
      for (const c of document.querySelector('review-mode').shadowRoot.querySelectorAll('.ui > canvas')) {
        const x = Math.max(0, Math.round((b.x - pad) * k)),
          y = Math.max(0, Math.round((b.y - pad) * k)),
          w = Math.min(c.width - x, Math.round((b.w + 2 * pad) * k)),
          h = Math.min(c.height - y, Math.round((b.h + 2 * pad) * k));
        if (w <= 0 || h <= 0) continue;
        const { data } = c.getContext('2d').getImageData(x, y, w, h);
        for (let i = 3; i < data.length; i += 4) most = Math.max(most, data[i]);
      }
      return most;
    },
    [b, pad],
  );

// The desk phone open on the phone, and so on the desktop: a card of it both show, with the same words, uncovered, a
// size a ring goes round ({ sel, phone, desk }: its boxes on each)
async function bothShow(phone, desk) {
  await phone.evaluate(() => import('/shell/desk.js').then(d => d.openPhone()));
  for (const page of [phone, desk])
    await page.waitForSelector('#tool .device.phone', { state: 'visible', timeout: 10_000 });
  await desk.waitForTimeout(600); // (its pop)
  const boxOf = (page, sels) =>
    page.evaluate(async sels => {
      const { found, selector, textOf } = await import('/__review/anchor.js');
      const all = sels ?? [...document.querySelectorAll('#tool .device.phone *')].map(selector);
      return all.map(sel => {
        const el = found(sel, document),
          b = el?.getBoundingClientRect();
        if (!b?.width) return null;
        const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return {
          sel,
          text: textOf(el),
          x: b.left + b.width / 2,
          y: b.top + b.height / 2,
          w: b.width,
          h: b.height,
          ...{ box: { x: b.left, y: b.top, w: b.width, h: b.height }, uncovered: !!top && el.contains(top) },
        };
      });
    }, sels);
  const there = await boxOf(phone, null),
    fits = b => b?.uncovered && b.text && b.w > 100 && b.w < 240 && b.h > 30 && b.h < 140;
  const mine = there.filter(b => fits(b) && b.box.y > 80 && b.box.y + b.h < 844 - 80);
  const theirs = await boxOf(
    desk,
    mine.map(b => b.sel),
  );
  const i = theirs.findIndex((b, i) => b?.uncovered && b.text === mine[i].text && b.box.x + b.w < 1280);
  assert.ok(i >= 0, 'a card of the desk phone shows on both screens');
  return { sel: mine[i].sel, phone: mine[i], desk: theirs[i] };
}
// A ring round the card on the phone: on the desktop's page round the same card while it's drawn; rested, into the book
// from the phone, and nothing of it drawn on either screen. The note.
async function filed(c, desk, phone, card) {
  const from = c.notes.length;
  await ringRound(c, phone, card.phone, { lift: false });
  for (let i = 0; i < 30 && !(await inked(desk, '.pair-ink')); i++) await desk.waitForTimeout(150);
  assert.ok(await inked(desk, '.pair-ink'), "the phone's ring shows on the desktop as it's drawn");
  await phone.evaluate(() => window.__lift());
  const note = await noteIn(c, phone, from);
  assert.ok(note.anchor.el?.selector.startsWith(card.sel), `filed on the card (${note.anchor.el?.selector})`);
  await nothingDrawn(desk, 'the desktop, the phone’s ring in the book');
  await nothingDrawn(phone, 'the phone, its ring in the book');
  return note;
}

// A ring round a card both screens show: drawn on the desktop only while it's made, nothing of it once it's in the book,
// nor once its sheet is sent (on the desktop's feed, as the coordinator tells it)
async function whileMade(c, desk, phone, feed) {
  const card = await bothShow(phone, desk);
  assert.equal(await inkIn(desk, card.desk.box), 0, 'nothing drawn round the card on the desktop yet');
  const kept = await filed(c, desk, phone, card);
  await c.shot('pair-phone-kept', desk);
  // (the sheet it went on)
  const sheet = await desk.evaluate(async id => {
    const api = (path, body) =>
      fetch(`/api/book${path}`, body && { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
    const sheet = (await api('/sheets')).open.find(s => s.notes.some(n => n.id === id));
    await api('/send', { id: sheet.id });
    return sheet.owner;
  }, kept.id);
  await desk.waitForTimeout(10_200);
  feed.push({ type: 'book', agent: sheet, text: 'sent' });
  // (the desktop reads the sheets again on the feed's word, which delivers the send)
  for (let i = 0; i < 30 && kept.status !== 'sent'; i++) await desk.waitForTimeout(150);
  assert.equal(kept.status, 'sent', 'its sheet went');
  await nothingDrawn(desk, 'the desktop, the phone’s ring sent');
  await c.shot('pair-phone-sent', desk);
  return card;
}

// A ring being drawn on the phone as the phone ends the pairing: gone from the desktop's page at once, nothing of the
// phone's left over HQ there (the board's picture: a phone's ring stuck over HQ's counters); lifted and rested, it goes
// in from the phone, the desktop's page as it was. Then on HQ's own view, none of the phone's rings shows on the
// desktop
async function endedMidRing(c, desk, phone, card) {
  const before = await inkIn(desk, card.desk.box);
  await ringRound(c, phone, { ...card.phone, y: card.phone.y + 4 }, { lift: false });
  for (let i = 0; i < 30 && !(await inked(desk, '.pair-ink')); i++) await desk.waitForTimeout(150);
  assert.ok(await inked(desk, '.pair-ink'), "the phone's ring shows on the desktop as it's drawn");
  await phone.locator('#book .pair-line [data-do=end]').dispatchEvent('click');
  await desk.waitForFunction(() => !('paired' in document.documentElement.dataset), null, { timeout: 10_000 });
  await desk.waitForTimeout(300); // (a frame's redraw)
  assert.equal(
    await inked(desk, '.pair-ink'),
    0,
    "the pairing ended, nothing of the phone's ring stays on the desktop",
  );
  await c.shot('pair-phone-ended', desk);
  const from = c.notes.length;
  await phone.evaluate(() => window.__lift());
  await noteIn(c, phone, from);
  assert.equal(await desk.isVisible(c.ui('.sheet')), false, 'lifted, the mark goes in from the phone, alone now');
  assert.equal(await inkIn(desk, card.desk.box), before, "and the desktop's page is as it was");
  // (HQ's own view on the desktop: none of the phone's rings drawn over it, the scene's sent one among them)
  await desk.evaluate(() => import('/shell/desk.js').then(d => d.closeTool()));
  await desk.waitForSelector('#tool', { state: 'hidden' });
  await desk.waitForTimeout(400); // (the marks drawn after it)
  assert.equal(await inked(desk, REVIEW_INK), 0, "HQ's own view on the desktop: none of the phone's rings over it");
}
