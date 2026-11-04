// book-check.mjs's story of a page torn off by hand where a hand finds it (shell/ink/booktear.js, booktearedge.js; the
// Ink README, The book's frame, The tear), held as the board holds its iPad mini, upright (the page the whole screen)
// and sideways (beside HQ's page), and a phone upright and on its side, a home-screen app's blur at the top. A finger
// pressed in the spine's grip shows the page's perforation along it at once, the strip beyond it giving as the finger
// draws left, and let go before the page comes off, it goes; the mouse or the Pencil hovering there shows it fainter.
// A finger drawn left from the top or the foot of the spine, where iPadOS resizes the window, tears nothing; the
// Pencil drawn down the spine and drawn left from just inside its grip draws. A finger and the Pencil drawn left from
// the grip tear the page off, in hand and let go on PNG and PDF, which download; the dots' Tear off and send shows the
// perforation a moment. Recorded with --shots: the perforation pressed, the page in hand over PNG, and let go on it.
import assert from 'node:assert/strict';
import { inputs } from './hands.mjs';
import { QUIET_MS, atEverySize, inkAt, until } from './kit.mjs';
import { blurred } from './islands.mjs';
import { restsOpen, watchedPage } from './start.mjs';
import { cornerOf, dragTo, spineOf, tearOffMenu, watchTears } from './tearing.mjs';

const SIZES = {
  'ipad-mini-upright': { width: 744, height: 1133, sat: 24 },
  'ipad-mini-sideways': { width: 1133, height: 744, sat: 24 },
  phone: { width: 390, height: 844, sat: 54 },
  'phone-sideways': { width: 844, height: 390 },
};

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, SNIP
export const tearHandStories = c => ({
  "a page torn off by hand at its spine's middle, by a finger and the Pencil, its perforation showing as a hand comes; never at the screen's corners, and a line drawn there still draws":
    atEverySize(SIZES, (browser, name, size) => byHand(browser, c, name, size)),
});

async function byHand(browser, c, name, { sat = 0, ...viewport }) {
  const context = await c.hqIn(browser, viewport, { hasTouch: true });
  if (sat) await blurred(context, { sat });
  // (the page's picture, as the store makes it: bookshare.js pictureOf)
  await context.route(`${c.base}/api/book/picture**`, r =>
    r.fulfill({ contentType: 'image/png', body: Buffer.from(c.SNIP.split(',')[1], 'base64') }),
  );
  // (a download's link pressed, kept rather than followed)
  await context.addInitScript(() => {
    window.__downloads = [];
    const press = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return press.call(this);
      window.__downloads.push(this.download);
    };
  });
  const { page, errors } = await watchedPage(context);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await restsOpen(page, c, viewport);
    const hand = await inputs(page),
      at = await spineOf(page);
    await watchTears(page);
    await shownOnAHand(page, c, name, hand, at);
    await notAtTheCorners(page, name, hand, at, sat);
    await stillDraws(page, name, hand, at);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(await page.evaluate(() => window.__tore), false, `${name}: nothing torn off yet`);
    await tornOff(page, c, name);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`tearhand-${name}-failed`, page);
    e.message = `${name}: ${e.message} (page errors: ${errors.join(' | ') || 'none'})`;
    throw e;
  } finally {
    await context.close();
  }
}

// A finger drawn left from the grip: the page in hand, let go on PNG, which downloads; the Pencil's, let go on PDF; and
// the dots' Tear off and send, the perforation showing a moment
async function tornOff(page, c, name) {
  await dragTo(page, 'touch', 'png', () => c.shot(`tearhand-${name}-in-hand`, page));
  await page.waitForTimeout(120);
  await c.shot(`tearhand-${name}-let-go`, page);
  await until(() => page.evaluate(() => window.__downloads.length === 1), `${name}: the PNG downloaded`);
  await until(() => page.evaluate(() => !document.querySelector('#book .bk-controls[data-targets]')), 'put away');
  await dragTo(page, 'pen', 'pdf');
  await until(() => page.evaluate(() => window.__downloads.length === 2), `${name}: the PDF downloaded, by the Pencil`);
  await until(() => page.evaluate(() => !document.querySelector('#book .bk-controls[data-targets]')), 'put away');
  await tearOffMenu(page, 'tap');
  await until(async () => (await perforation(page)).shown === 'flash', `${name}: the perforation as the menu's picked`);
  await page.keyboard.press('Escape');
}

// The mouse hovering at the grip: the perforation, faint, gone as it moves off. A finger pressed there: the
// perforation at once, along the spine and clear of its corners; drawn a little left, the strip gives; let go, it goes
async function shownOnAHand(page, c, name, hand, [x, y]) {
  await page.mouse.move(x, y);
  await until(async () => (await perforation(page)).shown === 'hover', `${name}: the perforation as the mouse hovers`);
  await page.mouse.move(x - 160, y);
  await until(async () => !(await perforation(page)).shown, `${name}: the hover's perforation gone`);
  const held = await hand.hold('touch', [x, y]);
  await until(async () => (await perforation(page)).shown === 'press', `${name}: the perforation as a finger presses`);
  await held.move([x - 6, y + 1]);
  await until(async () => (await perforation(page)).give > 0, `${name}: the strip giving under the finger`);
  // (its fade in can stall a moment in headless WebKit, under load)
  await until(async () => (await perforation(page)).opacity > 0.9, `${name}: the perforation plain to see`);
  const { box } = await perforation(page),
    { width, height } = page.viewportSize(),
    corner = cornerOf(height);
  assert.ok(box.right <= width && box.right > width - 24, `${name}: along the spine (${JSON.stringify(box)})`);
  assert.ok(
    box.top >= corner && box.bottom <= height - corner,
    `${name}: clear of the corners (${JSON.stringify(box)})`,
  );
  await c.shot(`tearhand-${name}-perforation`, page);
  await held.up([x - 6, y + 1]);
  await until(async () => !(await perforation(page)).shown, `${name}: the perforation gone as the finger lets go`);
}

// A finger drawn left from the spine at the top right, below the blur, and at the foot's right where it's paper:
// nothing tears there
async function notAtTheCorners(page, name, hand, [x], sat) {
  const { height } = page.viewportSize(),
    foot = height - cornerOf(height) / 2,
    paper = await page.evaluate(
      ([x, y]) => {
        const under = document.elementFromPoint(x, y);
        return !!under?.closest('#book .bk-leaf') && !under.closest('.bk-controls > *, button');
      },
      [x, foot],
    );
  await hand.stroke('touch', [
    [x, sat + 24],
    [x - 160, sat + 34],
  ]);
  if (paper)
    await hand.stroke('touch', [
      [x, foot],
      [x - 160, foot - 10],
    ]);
  await page.waitForTimeout(QUIET_MS);
  assert.equal(await page.evaluate(() => window.__tore), false, `${name}: nothing torn off at the corners`);
}

// The Pencil drawn down the spine from its grip, and drawn left from just inside it: both lines drawn
async function stillDraws(page, name, hand, [x, y]) {
  const ink = box => page.evaluate(inkAt, box);
  await hand.stroke('pen', [
    [x, y],
    [x - 2, y + 40],
    [x - 4, y + 90],
  ]);
  await until(async () => (await ink({ x: x - 14, y: y + 20, w: 20, h: 60 })) > 0, `${name}: a line down the spine`);
  // (just inside the grip, on the paper: on a phone on its side the tools stand over most of the spine)
  const inside = await page.evaluate(
    ([x, y]) => {
      for (let at = x - 40; at > x - 200; at -= 8) {
        const under = document.elementFromPoint(at, y);
        if (under?.closest('#book .bk-leaf') && !under.closest('.bk-controls > *, button')) return at;
      }
      return null;
    },
    [x, y + 4],
  );
  assert.ok(inside, `${name}: paper beside the grip`);
  await hand.stroke('pen', [
    [inside, y + 4],
    [inside - 60, y + 6],
    [inside - 140, y + 8],
  ]);
  await until(async () => (await ink({ x: inside - 120, y: y - 4, w: 100, h: 20 })) > 0, `${name}: a line drawn left`);
}

// The perforation as the screen shows it: why it shows (data-shown), its opacity, its box and how far its strip gives
const perforation = page =>
  page.evaluate(() => {
    const el = document.querySelector('#book .bk-perf'),
      r = el.getBoundingClientRect();
    return {
      shown: el.dataset.shown ?? null,
      opacity: Number(getComputedStyle(el).opacity),
      give: Number(getComputedStyle(el).getPropertyValue('--give')) || 0,
      box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    };
  });
