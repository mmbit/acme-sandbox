// book-check.mjs's phone story (shell/pair.js, pairink.js, shared/review/handover.js): a phone paired with the desktop
// by the book's code, as the iPad is in bookpair.mjs. A ring round part of HQ's scene, which the desktop lays out its
// own way, shows nowhere on the desktop's page, live or lifted, and opens there as the phone's own picture of it, which
// Send puts in the book; the phone's screen shows no post-it while it's drawn, nor while it scrolls. Its picture goes
// even when it develops only after the mark has left, and a ring the desktop doesn't get stays on the phone round what
// it was drawn round.
import assert from 'node:assert/strict';
import { until } from '../../shared/browser/browser.mjs';
import {
  DESKTOP,
  PHONE,
  POSTIT_MS,
  SETTLE_MS,
  bookIs,
  moved,
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

// A phone paired with the desktop by the book's code, HQ's page on it and its post-it watched
async function phonePaired(c, route) {
  const desk = await c.hqIn(c.desk, DESKTOP, { hasTouch: false, deviceScaleFactor: 1 }),
    phone = await c.hqIn(c.pad, PHONE, { deviceScaleFactor: 3 });
  for (const context of [desk, phone]) await context.route(/\/api\/pair(\/[a-z]+)?(\?.*)?$/, route);
  const d = await opened(c, desk, '/?intro=0');
  await d.page.getByRole('button', { name: 'Draw from your phone' }).click();
  const code = (await (await d.page.waitForSelector('#book .pair-digits')).textContent()).replace(/\D/g, '');
  const p = await opened(c, phone, `/?intro=0&pair=${code}`);
  await until(d.page, '#book .pair-line', /draws here/, 10_000);
  await bookIs(p.page, 'folded');
  await watchSheet(p.page);
  return { desk, phone, d, p };
}
// c: book-check's, as for bookpair.mjs's pairStory. A phone paired with the desktop: a ring round part of HQ's scene (a
// canvas laid out its own way on each) shows on the desktop only as the phone's own picture, never on the desktop's
// page; the phone shows no post-it as it's drawn
export async function phoneStory(c) {
  const route = pairRelay(),
    { desk, phone, d, p } = await phonePaired(c, route);
  const scene = { x: PHONE.width / 2, y: 520, w: 200, h: 90 };
  // (the ring goes round part of HQ's scene, once it's drawn there)
  await p.page.waitForFunction(
    ({ x, y }) => document.elementsFromPoint(x, y).some(e => e.localName === 'canvas'),
    scene,
    { timeout: 15_000, polling: 200 },
  );
  const before = await inked(d.page, REVIEW_INK);
  await holdShot(p.page);
  await ringRound(c, p.page, scene, { lift: false });
  await d.page.waitForTimeout(800);
  assert.equal(await inked(d.page, '.pair-ink'), 0, "the ring being drawn shows nowhere on the desktop's page");
  await p.page.evaluate(() => window.__lift());
  await c.shot('pair-phone-ring', p.page);
  await d.page.waitForSelector(c.ui('.sheet:not([hidden]) .polaroid img[src^="data:image/jpeg"]'), {
    timeout: SETTLE_MS + POSTIT_MS,
  });
  assert.equal(
    await d.page.textContent(c.ui('.sheet h2')),
    'From your other screen',
    "the desktop's post-it holds the phone's own picture of the ring",
  );
  assert.ok(await p.page.evaluate(() => window.__shotHeld), 'a picture developed only once the mark had left');
  assert.equal(await inked(d.page, '.pair-ink'), 0, "the ring isn't drawn on the desktop's page");
  await d.page.waitForTimeout(1500); // (the polaroid develops)
  await c.shot('pair-phone-snap', d.page);
  assert.equal(await inked(d.page, REVIEW_INK), before, "nor in review mode's ink there");
  await snapSent(c, d.page);
  // (the phone scrolls HQ's page and draws again: still no post-it there, the mark on the desktop's)
  await p.page.mouse.wheel(0, 300);
  await ringRound(c, p.page, { ...scene, y: 300 });
  await moved(c, p.page, d.page);
  assert.equal(await sheetShowed(p.page), false, "the phone's post-it never popped up, drawing or scrolling");
  await d.page.locator(c.ui('[data-cancel]')).dispatchEvent('click');
  await bouncedBack(c, route, d.page, p.page, { ...scene, y: 300 });
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
// (in the page: its screenshot held until its mark has gone to the other screen, as a slow one is)
const holdShot = page =>
  page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    let gone;
    const left = new Promise(res => (gone = res));
    document.addEventListener('pencil:hand', e => e.detail?.give && setTimeout(gone, 300));
    HTMLImageElement.prototype.decode = function () {
      if (!this.src.startsWith('data:image/svg+xml')) return decode.call(this);
      window.__shotHeld = true;
      return left.then(() => decode.call(this));
    };
  });
// A ring the desktop doesn't get stays on the phone, back where it was drawn: its post-it there, about what it's round
async function bouncedBack(c, route, desk, phone, at) {
  route.refuseSend();
  await ringRound(c, phone, at);
  await phone.waitForSelector('#toasts .toast:has-text("wasn’t reached")', { timeout: SETTLE_MS + POSTIT_MS });
  await phone.waitForSelector(c.ui('.sheet:not([hidden])'), { timeout: POSTIT_MS });
  assert.equal(await phone.textContent(c.ui('.sheet h2')), 'About this bit…', 'the ring is back round what it was');
  assert.equal(await desk.isVisible(c.ui('.sheet')), false, 'and not on the desktop');
  const noted = c.posts.filter(x => x.path === '/api/book/note').length;
  await phone.locator(c.ui('.send')).dispatchEvent('click');
  await phone.waitForSelector(c.ui('.sheet'), { state: 'hidden', timeout: 15_000 });
  const note = c.posts.filter(x => x.path === '/api/book/note')[noted]?.body;
  assert.ok(note?.anchor.el?.selector, `Send files it about what it was round (${note?.anchor.el?.tag})`);
  assert.ok(note.anchor.ink.length >= 1, 'with its ring');
}
// Send on the desktop's post-it: the phone's picture goes in the book, with nothing of the desktop's page to draw on
async function snapSent(c, page) {
  const noted = c.posts.filter(x => x.path === '/api/book/note').length;
  await page.locator(c.ui('.send')).dispatchEvent('click');
  await page.waitForSelector(c.ui('.sheet'), { state: 'hidden', timeout: 15_000 });
  const note = c.posts.filter(x => x.path === '/api/book/note')[noted]?.body;
  assert.ok(note?.snip?.startsWith('data:image/jpeg'), "Send puts the phone's picture in the book");
  assert.equal(note.anchor.el, null, "with no element of the desktop's to draw it on");
  assert.deepEqual(note.anchor.ink, [], 'nor any ink');
}
